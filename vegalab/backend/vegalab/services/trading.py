"""
Fill logic, position updates, cash accounting (handover "Trading rules").

- Buy fills at ask, sell at bid, from the LATEST market_snapshot for the
  instrument. 422 if that snapshot is older than ``stale_quote_minutes``.
- Cash: buy → cash −= fill × qty × 100; sell → cash += fill × qty × 100.
  Negative cash is allowed (margin out of scope) but |cash| may not exceed
  5 × starting_capital.
- Positions are signed contract counts with standard average-cost; realized
  PnL on reducing trades accrues to ``positions.realized_pnl``.
- Multi-leg: v1 submits legs sequentially from the frontend; no atomic
  strategy object (see BACKLOG.md).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Account, Instrument, MarketSnapshot, Position, Trade, utcnow

MULTIPLIER = 100
CASH_CAP_MULTIPLE = 5.0


class TradingError(Exception):
    """Base for rejections; routes map these to HTTP 4xx."""

    status_code = 422


class UnknownInstrument(TradingError):
    status_code = 404


class NoMarketData(TradingError):
    pass


class StaleMarketData(TradingError):
    pass


class CashCapExceeded(TradingError):
    pass


class InvalidOrder(TradingError):
    pass


def ensure_utc(dt: datetime) -> datetime:
    """SQLite returns naive datetimes; all our writes are UTC, so tag them."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def latest_snapshot(session: Session, instrument_id: int) -> MarketSnapshot | None:
    return session.scalar(
        select(MarketSnapshot)
        .where(MarketSnapshot.instrument_id == instrument_id)
        .order_by(MarketSnapshot.snapshot_ts.desc())
        .limit(1)
    )


def _check_fresh(snap: MarketSnapshot | None, now: datetime) -> MarketSnapshot:
    if snap is None:
        raise NoMarketData("no market data for instrument")
    max_age = timedelta(minutes=get_settings().stale_quote_minutes)
    if now - ensure_utc(snap.fetched_at) > max_age:
        raise StaleMarketData("market data stale")
    return snap


def apply_fill(
    qty0: int, avg0: float, fill_qty: int, fill_px: float
) -> tuple[int, float, float]:
    """
    Average-cost position math for one signed fill.

    Returns (new_qty, new_avg_cost, realized_pnl_delta). Realized PnL only
    arises on the closing portion of an opposite-sign fill; flipping through
    zero re-opens the remainder at the fill price.
    """
    if qty0 == 0 or (qty0 > 0) == (fill_qty > 0):
        qty1 = qty0 + fill_qty
        avg1 = (abs(qty0) * avg0 + abs(fill_qty) * fill_px) / abs(qty1)
        return qty1, avg1, 0.0

    closed = min(abs(fill_qty), abs(qty0))
    direction = 1.0 if qty0 > 0 else -1.0
    realized = closed * (fill_px - avg0) * direction * MULTIPLIER
    qty1 = qty0 + fill_qty
    if qty1 == 0:
        avg1 = 0.0
    elif (qty1 > 0) == (qty0 > 0):
        avg1 = avg0  # partial close keeps the original basis
    else:
        avg1 = fill_px  # flipped through zero: remainder opens at the fill
    return qty1, avg1, realized


def place_trade(
    session: Session,
    account: Account,
    symbol: str,
    side: str,
    qty: int,
    now: datetime | None = None,
) -> tuple[Trade, Position]:
    now = now or utcnow()
    side = side.lower()
    if side not in ("buy", "sell"):
        raise InvalidOrder(f"side must be 'buy' or 'sell', got {side!r}")
    if qty < 1:
        raise InvalidOrder("qty must be a positive integer")

    instrument = session.scalar(select(Instrument).where(Instrument.symbol == symbol.upper()))
    if instrument is None:
        raise UnknownInstrument(f"unknown instrument {symbol!r}")

    snap = _check_fresh(latest_snapshot(session, instrument.id), now)
    fill_px = snap.ask if side == "buy" else snap.bid
    fill_qty = qty if side == "buy" else -qty

    cash_delta = -fill_px * qty * MULTIPLIER if side == "buy" else fill_px * qty * MULTIPLIER
    new_cash = account.cash + cash_delta
    if abs(new_cash) > CASH_CAP_MULTIPLE * account.starting_capital:
        raise CashCapExceeded(
            f"|cash| after fill (${abs(new_cash):,.0f}) would exceed "
            f"{CASH_CAP_MULTIPLE:g} × starting capital"
        )

    position = session.scalar(
        select(Position).where(
            Position.account_id == account.id, Position.instrument_id == instrument.id
        )
    )
    if position is None:
        position = Position(
            account_id=account.id, instrument_id=instrument.id,
            qty=0, avg_cost=0.0, realized_pnl=0.0, opened_at=now,
        )
        session.add(position)

    if position.qty == 0:
        position.opened_at = now  # re-opening a flattened line restarts its clock
    position.qty, position.avg_cost, realized = apply_fill(
        position.qty, position.avg_cost, fill_qty, fill_px
    )
    position.realized_pnl += realized
    position.updated_at = now

    account.cash = new_cash

    trade = Trade(
        account_id=account.id,
        instrument_id=instrument.id,
        side=side,
        qty=qty,
        fill_px=fill_px,
        fill_quality="synthetic" if snap.synthetic_quote else "real",
        traded_at=now,
    )
    session.add(trade)
    session.flush()
    return trade, position


def account_options_delta(
    session: Session, account: Account, now: datetime | None = None
) -> tuple[float, float]:
    """
    (delta in underlying-share equivalents, spot) from the latest snapshot
    Greeks of every open position. Excludes the existing hedge so re-running
    hedge_delta is idempotent.
    """
    now = now or utcnow()
    positions = session.scalars(
        select(Position).where(Position.account_id == account.id, Position.qty != 0)
    ).all()

    delta_shares = 0.0
    spot: float | None = None
    for pos in positions:
        snap = _check_fresh(latest_snapshot(session, pos.instrument_id), now)
        delta_shares += pos.qty * MULTIPLIER * snap.delta
        spot = snap.underlying_px

    if spot is None:
        # No open positions: still need S for the (de)hedge bookkeeping.
        snap = session.scalar(
            select(MarketSnapshot).order_by(MarketSnapshot.snapshot_ts.desc()).limit(1)
        )
        spot = _check_fresh(snap, now).underlying_px
    return delta_shares, spot


def hedge_delta(
    session: Session,
    account: Account,
    target_delta: float = 0.0,
    now: datetime | None = None,
) -> dict:
    """
    Set ``delta_hedge_notional = −(account_delta − target) × S`` where
    account_delta is the options-only delta in share equivalents. Financing
    and mark-to-market of the hedge are handled by the snapshot engine.
    """
    delta_shares, spot = account_options_delta(session, account, now)
    notional = -(delta_shares - target_delta) * spot
    account.delta_hedge_notional = notional
    session.flush()
    return {
        "account_delta_shares": delta_shares,
        "target_delta": target_delta,
        "spot": spot,
        "delta_hedge_notional": notional,
    }
