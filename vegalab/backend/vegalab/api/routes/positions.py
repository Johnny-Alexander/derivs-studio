"""GET /me/positions + POST /me/hedge_delta."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import Account, Instrument, Position
from ...services import trading
from ..deps import get_current_account, get_db

router = APIRouter()

MULTIPLIER = 100


class HedgeRequest(BaseModel):
    target_delta: float = 0.0


@router.get("/me/positions")
def my_positions(
    db: Session = Depends(get_db),
    account: Account = Depends(get_current_account),
) -> dict:
    rows = db.execute(
        select(Position, Instrument)
        .join(Instrument, Position.instrument_id == Instrument.id)
        .where(Position.account_id == account.id, Position.qty != 0)
        .order_by(Instrument.expiry, Instrument.strike)
    ).all()

    positions = []
    net = {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0}
    options_value = 0.0
    spot = None
    for pos, inst in rows:
        snap = trading.latest_snapshot(db, inst.id)
        mark = snap.mid if snap else None
        unrealized = (mark - pos.avg_cost) * pos.qty * MULTIPLIER if mark is not None else None
        if snap:
            qm = pos.qty * MULTIPLIER
            net["delta"] += qm * snap.delta
            net["gamma"] += qm * snap.gamma
            net["theta"] += qm * snap.theta
            net["vega"] += qm * snap.vega
            options_value += qm * snap.mid
            spot = snap.underlying_px
        positions.append(
            {
                "symbol": inst.symbol,
                "expiry": inst.expiry,
                "strike": inst.strike,
                "right": inst.right,
                "qty": pos.qty,
                "avg_cost": pos.avg_cost,
                "mark": mark,
                "unrealized_pnl": unrealized,
                "realized_pnl": pos.realized_pnl,
                "synthetic_quote": snap.synthetic_quote if snap else None,
                "opened_at": pos.opened_at,
            }
        )

    hedge_delta_shares = (
        account.delta_hedge_notional / spot if (spot and account.delta_hedge_notional) else 0.0
    )
    return {
        "positions": positions,
        "cash": account.cash,
        "starting_capital": account.starting_capital,
        "equity": account.cash + options_value,
        "delta_hedge_notional": account.delta_hedge_notional,
        "net_greeks": net,
        "net_delta_incl_hedge": net["delta"] + hedge_delta_shares,
        "spot": spot,
    }


@router.post("/me/hedge_delta")
def hedge_delta(
    req: HedgeRequest,
    db: Session = Depends(get_db),
    account: Account = Depends(get_current_account),
) -> dict:
    try:
        return trading.hedge_delta(db, account, req.target_delta)
    except trading.TradingError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
