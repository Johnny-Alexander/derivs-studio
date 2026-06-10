"""
/chain and /chain/meta: the meta route serves the header strip (spot, quote
age, expiries) without shipping the option rows.
"""

from __future__ import annotations

from datetime import datetime, timezone

from vegalab.db import session_scope

from .conftest import add_market, auth

TS = datetime(2026, 6, 10, 14, 30, tzinfo=timezone.utc)


def test_chain_meta_empty(client, league):
    r = client.get("/chain/meta", headers=auth(league["users"]["alice"]["token"]))
    assert r.status_code == 200
    assert r.json() == {
        "snapshot_ts": None,
        "fetched_at": None,
        "spot": None,
        "expiries": [],
    }


def test_chain_meta_reports_latest_without_options(client, league):
    with session_scope() as s:
        add_market(s, "SPXW260710C06000000", TS, bid=45.0, ask=46.0, spot=6000.0)
        add_market(s, "SPXW260717P05900000", TS, bid=30.0, ask=31.0, spot=6000.0)

    r = client.get("/chain/meta", headers=auth(league["users"]["alice"]["token"]))
    assert r.status_code == 200
    body = r.json()
    assert body["spot"] == 6000.0
    assert body["expiries"] == ["2026-07-10", "2026-07-17"]
    assert "options" not in body

    full = client.get("/chain", headers=auth(league["users"]["alice"]["token"])).json()
    assert len(full["options"]) == 2
    assert full["expiries"] == body["expiries"]


def test_chain_meta_requires_auth(client, league):
    assert client.get("/chain/meta").status_code == 401
