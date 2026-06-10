"""
FastAPI dependencies: DB session, bearer-token auth, job-secret guard.

Auth: ``Authorization: Bearer <token>`` matched against ``users.api_token``
with a constant-time comparison against EVERY user's token (three players —
no timing oracle, no early exit). 401 otherwise.

``POST /jobs/snapshot`` instead requires ``X-Job-Secret`` to match the
JOB_SECRET setting, also compared constant-time.
"""

from __future__ import annotations

import hmac
from collections.abc import Iterator

from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import session_scope
from ..models import Account, Season, User


def get_db() -> Iterator[Session]:
    with session_scope() as session:
        yield session


def get_current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()

    matched: User | None = None
    for user in db.scalars(select(User)):
        if hmac.compare_digest(token, user.api_token):
            matched = user
    if matched is None:
        raise HTTPException(status_code=401, detail="invalid token")
    return matched


def get_current_account(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Account:
    account = db.scalar(
        select(Account)
        .join(Season, Account.season_id == Season.id)
        .where(Account.user_id == user.id, Season.is_active)
        .order_by(Season.starts_on.desc())
        .limit(1)
    )
    if account is None:
        raise HTTPException(status_code=403, detail="no account in the active season")
    return account


def require_job_secret(x_job_secret: str | None = Header(default=None)) -> None:
    expected = get_settings().job_secret
    if not x_job_secret or not hmac.compare_digest(x_job_secret, expected):
        raise HTTPException(status_code=401, detail="missing or invalid X-Job-Secret")
