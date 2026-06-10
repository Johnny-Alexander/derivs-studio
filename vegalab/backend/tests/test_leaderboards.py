"""
Leaderboard metrics over synthetic attribution rows: correct ordering on
all three metrics, the ≥5-day sharpe rule, and the $100 noise floor on
attribution accuracy.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import pytest

from vegalab.db import session_scope
from vegalab.models import Account, PnlAttribution, User
from vegalab.services.leaderboards import compute_leaderboard

from .conftest import auth

UTC = timezone.utc
DAY0 = datetime(2026, 6, 1, 20, 0, tzinfo=UTC)


def add_day(s, account_id: int, day: int, total: float, residual: float = 0.0):
    s.add(
        PnlAttribution(
            account_id=account_id,
            snapshot_ts=DAY0 + timedelta(days=day),
            delta_pnl=total - residual,
            residual_pnl=residual,
            total_pnl=total,
        )
    )


@pytest.fixture
def synthetic_league(league):
    """
    alice : 6 steady days of +200, tiny residual → best sharpe + accuracy
    bob   : 6 swingy days summing to +3000, big residuals → best pnl
    carol : 4 days only, all under the $100 noise floor → null sharpe + accuracy
    """
    a = league["users"]["alice"]["account_id"]
    b = league["users"]["bob"]["account_id"]
    c = league["users"]["carol"]["account_id"]
    with session_scope() as s:
        for d in range(6):
            add_day(s, a, d, total=200.0 + d, residual=5.0)
        for d, total in enumerate([2000.0, -1500.0, 2500.0, -1000.0, 800.0, 200.0]):
            add_day(s, b, d, total=total, residual=0.4 * abs(total))
        for d in range(4):
            add_day(s, c, d, total=50.0, residual=1.0)
    return league


def by_user(standings):
    return {s["user"]: s for s in standings}


def test_pnl_ordering(synthetic_league):
    with session_scope() as s:
        standings = compute_leaderboard(s, "pnl")
    assert [x["user"] for x in standings] == ["bob", "alice", "carol"]
    assert standings[0]["value"] == pytest.approx(3000.0)
    assert by_user(standings)["alice"]["value"] == pytest.approx(sum(200.0 + d for d in range(6)))
    assert standings[0]["rank"] == 1


def test_sharpe_ordering_and_min_days(synthetic_league):
    with session_scope() as s:
        standings = compute_leaderboard(s, "sharpe")
    ranks = by_user(standings)
    assert ranks["carol"]["value"] is None  # only 4 trading days
    assert ranks["alice"]["value"] > ranks["bob"]["value"]  # steady beats swingy
    # alice: mean ≈ 202.5, sd ≈ 1.87 → annualized sharpe is huge and positive
    assert ranks["alice"]["value"] > 100
    assert standings[-1]["user"] == "carol"  # nulls sort last


def test_attribution_accuracy(synthetic_league):
    with session_scope() as s:
        standings = compute_leaderboard(s, "attribution")
    ranks = by_user(standings)
    # alice: 1 − 5/200ish per day
    assert ranks["alice"]["value"] == pytest.approx(
        sum(1 - 5.0 / (200.0 + d) for d in range(6)) / 6, abs=1e-9
    )
    # bob: residual is 40% of |total| every day → 0.6
    assert ranks["bob"]["value"] == pytest.approx(0.6, abs=1e-9)
    # carol: every day under the $100 noise floor → excluded → null
    assert ranks["carol"]["value"] is None
    assert [x["user"] for x in standings] == ["alice", "bob", "carol"]


def test_empty_league_pnl_is_zero(league):
    with session_scope() as s:
        standings = compute_leaderboard(s, "pnl")
    assert len(standings) == 3
    assert all(x["value"] == 0.0 for x in standings)


def test_null_values_sort_alphabetically_not_by_insertion(league):
    # "aaron" is created AFTER alice/bob/carol; with every sharpe null,
    # standings must come back alphabetical, not in account-id order.
    with session_scope() as s:
        user = User(name="aaron", api_token="token-aaron")
        s.add(user)
        s.flush()
        s.add(Account(user_id=user.id, season_id=league["season_id"]))
    with session_scope() as s:
        standings = compute_leaderboard(s, "sharpe")
    assert all(x["value"] is None for x in standings)
    assert [x["user"] for x in standings] == ["aaron", "alice", "bob", "carol"]


def test_sharpe_zero_variance_is_null(league):
    a = league["users"]["alice"]["account_id"]
    with session_scope() as s:
        for d in range(6):
            add_day(s, a, d, total=100.0)
    with session_scope() as s:
        value = by_user(compute_leaderboard(s, "sharpe"))["alice"]["value"]
    assert value is None


def test_leaderboard_route_all_three_metrics(client, synthetic_league):
    headers = auth(synthetic_league["users"]["alice"]["token"])
    for metric in ("pnl", "sharpe", "attribution"):
        r = client.get(f"/leaderboard?metric={metric}", headers=headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["metric"] == metric
        assert len(body["standings"]) == 3
        assert [x["rank"] for x in body["standings"]] == [1, 2, 3]
    # unknown metric → validation error
    assert client.get("/leaderboard?metric=vibes", headers=headers).status_code == 422
