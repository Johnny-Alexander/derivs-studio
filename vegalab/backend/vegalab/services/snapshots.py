"""
The snapshot engine: ingest one chain snapshot, then write one
pnl_attribution row per account per snapshot ts (handover "Snapshot engine").

Interval conventions (v1, documented deviations in README):

- t1 = this snapshot's ts (fetched_at truncated to the minute).
- t0 = the account's last pnl_attribution ts; if none, the earliest open
  position's open time; for hedge-only accounts, the previous market
  snapshot ts. The actual market baseline is the latest market_snapshot at
  or before that instant.
- Marks are MID at both ends. Positions opened after t0 use p0 = avg_cost
  (the entry fill) with Greeks from the fill-time snapshot — the bid/ask
  crossing cost lands in this interval's residual, which is honest.
- Positions resized mid-interval are attributed at their CURRENT qty;
  whatever that approximation misses lands in residual (BACKLOG:
  trade-aware interval PnL).
- σ missing/unusable at t0 or t1, or no t0 market row at all → that
  position's whole interval PnL goes to residual (never fabricate Greeks).
- Hedge leg: mark-to-market notional × (S1/S0 − 1) goes to hedge_pnl;
  interest-only carry −r × |notional| × Δt goes to financing_pnl. Both are
  added to total so buckets keep summing to total.
- Idempotent on (account_id, snapshot_ts); each account runs in its own
  transaction so one failure cannot poison the others.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..data.providers import ChainSnapshot, fetch_with_fallback
from ..data.quality import MIN_IV, year_fraction
from ..db import session_scope
from ..models import Account, Instrument, MarketSnapshot, PnlAttribution, Position
from ..quant.attribution import attribute

logger = logging.getLogger(__name__)

MULTIPLIER = 100

BUCKETS = (
    "delta_pnl", "gamma_pnl", "vega_pnl", "theta_pnl",
    "vanna_pnl", "charm_pnl", "volga_pnl",
    "hedge_pnl", "financing_pnl", "residual_pnl", "total_pnl",
)


def persist_snapshot(snap: ChainSnapshot) -> int:
    """
    Upsert instruments + insert market_snapshots rows for one chain snapshot.

    Idempotency: snapshot_ts is fetched_at truncated to the minute and
    (instrument_id, snapshot_ts) is unique — running twice in the same
    minute writes once. Returns the number of new market_snapshots rows.
    """
    snapshot_ts = snap.fetched_at.replace(second=0, microsecond=0)

    with session_scope() as session:
        symbols = [o.symbol for o in snap.options]
        existing = {
            i.symbol: i
            for i in session.scalars(select(Instrument).where(Instrument.symbol.in_(symbols)))
        }
        for o in snap.options:
            if o.symbol not in existing:
                inst = Instrument(
                    symbol=o.symbol, root=o.root, expiry=o.expiry,
                    strike=o.strike, right=o.right,
                )
                session.add(inst)
                existing[o.symbol] = inst
        session.flush()

        inst_ids = [existing[s].id for s in symbols]
        already = set(
            session.scalars(
                select(MarketSnapshot.instrument_id).where(
                    MarketSnapshot.snapshot_ts == snapshot_ts,
                    MarketSnapshot.instrument_id.in_(inst_ids),
                )
            )
        )

        written = 0
        for o in snap.options:
            inst_id = existing[o.symbol].id
            if inst_id in already:
                continue
            session.add(
                MarketSnapshot(
                    instrument_id=inst_id,
                    snapshot_ts=snapshot_ts,
                    bid=o.bid, ask=o.ask, mid=o.mid, iv=o.iv,
                    delta=o.delta, gamma=o.gamma, theta=o.theta, vega=o.vega,
                    volume=o.volume, open_interest=o.open_interest,
                    underlying_px=snap.underlying_px,
                    synthetic_quote=o.synthetic_quote,
                    fetched_at=snap.fetched_at,
                )
            )
            written += 1
    return written


def _utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _row_at_or_before(
    session: Session, instrument_id: int, ts: datetime
) -> MarketSnapshot | None:
    return session.scalar(
        select(MarketSnapshot)
        .where(
            MarketSnapshot.instrument_id == instrument_id,
            MarketSnapshot.snapshot_ts <= ts,
        )
        .order_by(MarketSnapshot.snapshot_ts.desc())
        .limit(1)
    )


def _underlying_at_or_before(session: Session, ts: datetime) -> MarketSnapshot | None:
    return session.scalar(
        select(MarketSnapshot)
        .where(MarketSnapshot.snapshot_ts <= ts)
        .order_by(MarketSnapshot.snapshot_ts.desc())
        .limit(1)
    )


def _usable_iv(iv: float | None) -> bool:
    return iv is not None and iv >= MIN_IV


def attribute_account(session: Session, account: Account, t1: datetime) -> bool:
    """
    Write one pnl_attribution row for ``account`` at snapshot ts ``t1``.
    Returns False when skipped (idempotent re-run or no usable baseline).
    """
    exists = session.scalar(
        select(PnlAttribution.id).where(
            PnlAttribution.account_id == account.id,
            PnlAttribution.snapshot_ts == t1,
        )
    )
    if exists is not None:
        return False

    positions = session.scalars(
        select(Position).where(Position.account_id == account.id, Position.qty != 0)
    ).all()

    last_attr_ts = session.scalar(
        select(PnlAttribution.snapshot_ts)
        .where(PnlAttribution.account_id == account.id, PnlAttribution.snapshot_ts < t1)
        .order_by(PnlAttribution.snapshot_ts.desc())
        .limit(1)
    )
    if last_attr_ts is not None:
        t0_ts = _utc(last_attr_ts)
    elif positions:
        t0_ts = min(_utc(p.opened_at) for p in positions)
    else:
        prev = session.scalar(
            select(MarketSnapshot.snapshot_ts)
            .where(MarketSnapshot.snapshot_ts < t1)
            .order_by(MarketSnapshot.snapshot_ts.desc())
            .limit(1)
        )
        if prev is None:
            return False  # hedge-only account, first-ever snapshot: no interval yet
        t0_ts = _utc(prev)

    baseline = _underlying_at_or_before(session, t0_ts)
    if baseline is None:
        logger.info("account %d: no market baseline at/before %s; skipping", account.id, t0_ts)
        return False
    t0_market_ts = _utc(baseline.snapshot_ts)
    if t0_market_ts >= t1:
        return False  # nothing elapsed (shouldn't happen given the idempotency check)

    settings = get_settings()
    r, q = settings.risk_free_rate, settings.dividend_yield
    sums = dict.fromkeys(BUCKETS, 0.0)

    for pos in positions:
        instrument = session.get(Instrument, pos.instrument_id)
        row1 = _row_at_or_before(session, pos.instrument_id, t1)
        if row1 is None or _utc(row1.snapshot_ts) != t1:
            logger.warning(
                "account %d: %s has no row at %s; position skipped this interval",
                account.id, instrument.symbol, t1,
            )
            continue

        opened_at = _utc(pos.opened_at)
        if opened_at > t0_market_ts:
            row0 = _row_at_or_before(session, pos.instrument_id, opened_at)
            p0 = pos.avg_cost  # entry fill: crossing cost shows up now, honestly
        else:
            row0 = _row_at_or_before(session, pos.instrument_id, t0_market_ts)
            p0 = row0.mid if row0 is not None else pos.avg_cost
        if row0 is not None and _utc(row0.snapshot_ts) >= t1:
            row0 = None  # opened after the previous cycle: no prior state to lean on

        qm = pos.qty * MULTIPLIER
        if row0 is None or not _usable_iv(row0.iv) or not _usable_iv(row1.iv):
            interval = qm * (row1.mid - p0)
            sums["residual_pnl"] += interval
            sums["total_pnl"] += interval
            continue

        snap_t0 = {
            "S": row0.underlying_px,
            "sigma": row0.iv,
            "T": year_fraction(instrument.expiry, _utc(row0.snapshot_ts)),
            "price": p0,
            "r": r,
        }
        snap_t1 = {
            "S": row1.underlying_px,
            "sigma": row1.iv,
            "T": year_fraction(instrument.expiry, t1),
            "price": row1.mid,
            "r": r,
        }
        res = attribute(pos.qty, instrument.strike, instrument.right, q, snap_t0, snap_t1)
        for k in BUCKETS:
            sums[k] += res[k]

    # Hedge leg: MTM to hedge_pnl, interest-only carry to financing_pnl,
    # both added to total (residual unaffected).
    notional = account.delta_hedge_notional
    if notional:
        s1_row = _underlying_at_or_before(session, t1)
        S0, S1 = baseline.underlying_px, s1_row.underlying_px
        dt_years = (t1 - t0_market_ts).total_seconds() / (365.0 * 86400.0)
        hedge_mtm = notional * (S1 / S0 - 1.0)
        carry = -r * abs(notional) * dt_years
        sums["hedge_pnl"] += hedge_mtm
        sums["financing_pnl"] += carry
        sums["total_pnl"] += hedge_mtm + carry

    session.add(PnlAttribution(account_id=account.id, snapshot_ts=t1, **sums))
    return True


def ingest_and_attribute(snap: ChainSnapshot) -> dict:
    """
    Persist one chain snapshot, then attribute every account that has open
    positions or a nonzero hedge. One transaction per account.
    """
    new_rows = persist_snapshot(snap)
    t1 = snap.fetched_at.replace(second=0, microsecond=0)

    with session_scope() as session:
        position_accounts = set(
            session.scalars(select(Position.account_id).where(Position.qty != 0))
        )
        hedged_accounts = set(
            session.scalars(select(Account.id).where(Account.delta_hedge_notional != 0))
        )
    account_ids = sorted(position_accounts | hedged_accounts)

    attributed, failed = 0, 0
    for account_id in account_ids:
        try:
            with session_scope() as session:
                account = session.get(Account, account_id)
                if attribute_account(session, account, t1):
                    attributed += 1
        except Exception:
            failed += 1
            logger.exception("attribution failed for account %d (others continue)", account_id)

    return {
        "snapshot_ts": t1,
        "options": len(snap.options),
        "new_rows": new_rows,
        "accounts_attributed": attributed,
        "accounts_failed": failed,
    }


async def run_snapshot_job() -> dict:
    """Fetch via the configured provider (with fallback), ingest, attribute."""
    settings = get_settings()
    snap, provider = await fetch_with_fallback(settings.data_provider)
    summary = ingest_and_attribute(snap)
    summary["provider"] = provider
    return summary
