"""POST /trade + GET /me/trades."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import Account, Instrument, Trade
from ...services import trading
from ..deps import get_current_account, get_db

router = APIRouter()


class TradeRequest(BaseModel):
    symbol: str = Field(description="OCC symbol, e.g. SPXW260618C06000000")
    side: str = Field(pattern="^(buy|sell)$")
    qty: int = Field(ge=1)


@router.post("/trade")
def place_trade(
    req: TradeRequest,
    db: Session = Depends(get_db),
    account: Account = Depends(get_current_account),
) -> dict:
    try:
        trade, position = trading.place_trade(db, account, req.symbol, req.side, req.qty)
    except trading.TradingError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    return {
        "trade_id": trade.id,
        "symbol": req.symbol.upper(),
        "side": trade.side,
        "qty": trade.qty,
        "fill_px": trade.fill_px,
        "fill_quality": trade.fill_quality,
        "traded_at": trade.traded_at,
        "position_qty": position.qty,
        "position_avg_cost": position.avg_cost,
        "realized_pnl": position.realized_pnl,
        "cash": account.cash,
    }


@router.get("/me/trades")
def my_trades(
    db: Session = Depends(get_db),
    account: Account = Depends(get_current_account),
) -> list[dict]:
    rows = db.execute(
        select(Trade, Instrument.symbol)
        .join(Instrument, Trade.instrument_id == Instrument.id)
        .where(Trade.account_id == account.id)
        .order_by(Trade.traded_at.desc(), Trade.id.desc())
    ).all()
    return [
        {
            "trade_id": t.id,
            "symbol": symbol,
            "side": t.side,
            "qty": t.qty,
            "fill_px": t.fill_px,
            "fill_quality": t.fill_quality,
            "traded_at": t.traded_at,
        }
        for t, symbol in rows
    ]
