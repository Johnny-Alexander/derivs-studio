"""
Auth gates: bearer token for user routes, X-Job-Secret for the cron route,
/health open to the world.
"""

from __future__ import annotations

from datetime import datetime, timezone

from vegalab.data.types import ChainSnapshot

from .conftest import auth

JOB_HEADERS = {"X-Job-Secret": "dev-job-secret"}  # config default


def test_user_routes_401_without_token(client, league):
    for path in ("/chain", "/me/positions", "/me/trades", "/me/pnl", "/leaderboard"):
        assert client.get(path).status_code == 401, path


def test_user_routes_401_with_bad_token(client, league):
    assert client.get("/me/positions", headers=auth("nope")).status_code == 401


def test_user_routes_200_with_token(client, league):
    r = client.get("/me/positions", headers=auth(league["users"]["alice"]["token"]))
    assert r.status_code == 200
    assert r.json()["cash"] == 100_000.0


def test_non_bearer_authorization_rejected(client, league):
    r = client.get("/me/positions", headers={"Authorization": "Basic abc"})
    assert r.status_code == 401


def test_jobs_snapshot_rejects_without_secret(client, league):
    assert client.post("/jobs/snapshot").status_code == 401
    assert client.post("/jobs/snapshot", headers={"X-Job-Secret": "wrong"}).status_code == 401


def test_jobs_snapshot_runs_with_secret(client, league, monkeypatch):
    async def fake_fetch(primary, symbol="SPX"):
        return (
            ChainSnapshot(
                underlying_px=6000.0,
                fetched_at=datetime(2026, 6, 10, 15, 0, tzinfo=timezone.utc),
                options=[],
            ),
            "cboe",
        )

    monkeypatch.setattr("vegalab.services.snapshots.fetch_with_fallback", fake_fetch)
    r = client.post("/jobs/snapshot", headers=JOB_HEADERS)
    assert r.status_code == 200
    body = r.json()
    assert body["provider"] == "cboe"
    assert body["new_rows"] == 0


def test_jobs_snapshot_503_on_double_provider_failure(client, league, monkeypatch):
    async def boom(primary, symbol="SPX"):
        raise RuntimeError("both providers failed")

    monkeypatch.setattr("vegalab.services.snapshots.fetch_with_fallback", boom)
    r = client.post("/jobs/snapshot", headers=JOB_HEADERS)
    assert r.status_code == 503


def test_health_open_and_reports_state(client, league):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["provider"] in ("cboe", "yahoo")
    assert body["last_snapshot_ts"] is None  # nothing ingested yet
