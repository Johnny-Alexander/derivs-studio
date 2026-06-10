"""GET /chain — the latest snapshot of the option chain."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...models import Instrument, MarketSnapshot, User
from ..deps import get_current_user, get_db

router = APIRouter()


@router.get("/chain")
def get_chain(
    expiry: date | None = None,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    latest_ts = db.scalar(select(func.max(MarketSnapshot.snapshot_ts)))
    if latest_ts is None:
        return {"snapshot_ts": None, "spot": None, "expiries": [], "options": []}

    base = (
        select(MarketSnapshot, Instrument)
        .join(Instrument, MarketSnapshot.instrument_id == Instrument.id)
        .where(MarketSnapshot.snapshot_ts == latest_ts)
    )

    expiries = sorted(
        set(
            db.scalars(
                select(Instrument.expiry)
                .join(MarketSnapshot, MarketSnapshot.instrument_id == Instrument.id)
                .where(MarketSnapshot.snapshot_ts == latest_ts)
            )
        )
    )

    options = []
    spot = None
    fetched_at = None
    rows = db.execute(
        base.where(Instrument.expiry == expiry).order_by(Instrument.strike, Instrument.right)
        if expiry is not None
        else base.order_by(Instrument.expiry, Instrument.strike, Instrument.right)
    ).all()
    for snap, inst in rows:
        spot = snap.underlying_px
        fetched_at = snap.fetched_at
        options.append(
            {
                "symbol": inst.symbol,
                "root": inst.root,
                "expiry": inst.expiry,
                "strike": inst.strike,
                "right": inst.right,
                "bid": snap.bid,
                "ask": snap.ask,
                "mid": snap.mid,
                "iv": snap.iv,
                "delta": snap.delta,
                "gamma": snap.gamma,
                "theta": snap.theta,
                "vega": snap.vega,
                "volume": snap.volume,
                "open_interest": snap.open_interest,
                "synthetic_quote": snap.synthetic_quote,
            }
        )

    return {
        "snapshot_ts": latest_ts,
        "fetched_at": fetched_at,
        "spot": spot,
        "expiries": expiries,
        "options": options,
    }
