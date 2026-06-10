"""GET /leaderboard?metric=pnl|sharpe|attribution."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ...models import User
from ...services.leaderboards import compute_leaderboard
from ..deps import get_current_user, get_db

router = APIRouter()


@router.get("/leaderboard")
def leaderboard(
    metric: Literal["pnl", "sharpe", "attribution"] = "pnl",
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    return {"metric": metric, "standings": compute_leaderboard(db, metric)}
