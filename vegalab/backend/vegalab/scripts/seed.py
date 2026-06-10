"""
Seed the league: one active season, 3 users, one $100k account each.

Idempotent: re-running never duplicates rows and never rotates an existing
user's token (the league would riot).

    python -m vegalab.scripts.seed
"""

from __future__ import annotations

import secrets
from datetime import date

from sqlalchemy import select

from ..db import session_scope
from ..models import Account, Season, User

USER_NAMES = ["alice", "bob", "carol"]
STARTING_CAPITAL = 100_000.0


def main() -> int:
    today = date.today()
    season_name = f"Season {today:%Y-%m}"

    with session_scope() as session:
        season = session.scalar(select(Season).where(Season.name == season_name))
        if season is None:
            season = Season(name=season_name, starts_on=today.replace(day=1), is_active=True)
            session.add(season)
            session.flush()
            print(f"created season {season.name!r} (id={season.id})")
        else:
            print(f"season {season.name!r} already exists (id={season.id})")

        for name in USER_NAMES:
            user = session.scalar(select(User).where(User.name == name))
            if user is None:
                user = User(name=name, api_token=secrets.token_hex(16))
                session.add(user)
                session.flush()
                print(f"created user {name!r}  token={user.api_token}")
            else:
                print(f"user {name!r} already exists  token={user.api_token}")

            account = session.scalar(
                select(Account).where(
                    Account.user_id == user.id, Account.season_id == season.id
                )
            )
            if account is None:
                account = Account(
                    user_id=user.id,
                    season_id=season.id,
                    starting_capital=STARTING_CAPITAL,
                    cash=STARTING_CAPITAL,
                )
                session.add(account)
                session.flush()
                print(f"  account id={account.id} cash=${STARTING_CAPITAL:,.0f}")
            else:
                print(f"  account id={account.id} already exists")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
