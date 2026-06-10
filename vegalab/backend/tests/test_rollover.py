"""POST /jobs/rollover: auth, archive semantics, fresh accounts, idempotency."""

from __future__ import annotations

from datetime import date

from sqlalchemy import select

from vegalab.db import session_scope
from vegalab.models import Account, Season
from vegalab.services.rollover import run_rollover

JOB = {"X-Job-Secret": "dev-job-secret"}


def test_rollover_requires_job_secret(client, league):
    assert client.post("/jobs/rollover").status_code == 401
    assert client.post("/jobs/rollover", headers={"X-Job-Secret": "wrong"}).status_code == 401


def test_rollover_archives_and_creates(client, league):
    res = client.post("/jobs/rollover", headers=JOB)
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "rolled"
    assert body["archived"] == ["Season test"]
    assert body["accounts_created"] == 3

    with session_scope() as s:
        old = s.scalar(select(Season).where(Season.name == "Season test"))
        assert old.is_active is False
        assert old.ends_on is not None
        new = s.scalar(select(Season).where(Season.is_active))
        assert new.name == body["season"]
        accounts = s.scalars(select(Account).where(Account.season_id == new.id)).all()
        assert len(accounts) == 3
        assert all(
            a.cash == 100_000.0 and a.starting_capital == 100_000.0 for a in accounts
        )


def test_rollover_idempotent(client, league):
    assert client.post("/jobs/rollover", headers=JOB).json()["status"] == "rolled"
    assert client.post("/jobs/rollover", headers=JOB).json()["status"] == "noop"
    with session_scope() as s:
        assert len(s.scalars(select(Season).where(Season.is_active)).all()) == 1


def test_rollover_explicit_date(fresh_db, league):
    out = run_rollover(today=date(2026, 7, 15))
    assert out["status"] == "rolled"
    assert out["season"] == "Season 2026-07"
    with session_scope() as s:
        season = s.scalar(select(Season).where(Season.name == "Season 2026-07"))
        assert season.starts_on == date(2026, 7, 1)
        assert season.is_active is True
