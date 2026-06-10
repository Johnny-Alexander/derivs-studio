"""
Season rollover: archive the current standings and start a fresh month.

"Archiving" is cheap by construction — accounts are per-season, and every
trade/position/attribution row hangs off an account, so deactivating the
old season freezes its standings in place (the leaderboard only looks at
accounts in active seasons). The new season gets one fresh $100k account
per user; old positions stay with the old account and are never carried
forward.

Idempotent on season name: a second call in the same month is a no-op.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import select

from ..db import session_scope
from ..models import Account, Season, User

STARTING_CAPITAL = 100_000.0


def run_rollover(today: date | None = None) -> dict:
    if today is None:
        today = datetime.now(timezone.utc).date()
    season_name = f"Season {today:%Y-%m}"

    with session_scope() as session:
        existing = session.scalar(select(Season).where(Season.name == season_name))
        if existing is not None:
            return {"status": "noop", "season": season_name, "detail": "season already exists"}

        archived: list[str] = []
        for old in session.scalars(select(Season).where(Season.is_active)):
            old.is_active = False
            if old.ends_on is None:
                old.ends_on = today
            archived.append(old.name)

        season = Season(name=season_name, starts_on=today.replace(day=1), is_active=True)
        session.add(season)
        session.flush()

        users = session.scalars(select(User)).all()
        for user in users:
            session.add(
                Account(
                    user_id=user.id,
                    season_id=season.id,
                    starting_capital=STARTING_CAPITAL,
                    cash=STARTING_CAPITAL,
                )
            )

        return {
            "status": "rolled",
            "season": season_name,
            "archived": archived,
            "accounts_created": len(users),
        }
