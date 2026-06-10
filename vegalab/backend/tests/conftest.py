"""
Shared Phase 3 fixtures: a fresh per-test SQLite DB wired into the global
engine (so services, deps, and the FastAPI app all hit the same file), a
seeded three-player league, and helpers to plant market data.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest
from sqlalchemy.orm import Session

from vegalab import db as db_module
from vegalab.db import get_engine, session_scope
from vegalab.models import Account, Base, Instrument, MarketSnapshot, Season, User
from vegalab.symbols import parse_occ

UTC = timezone.utc


@pytest.fixture
def fresh_db(tmp_path):
    engine = get_engine(f"sqlite:///{tmp_path}/test.db")
    Base.metadata.create_all(engine)
    yield engine
    db_module._engine = None
    db_module._session_factory = None


@pytest.fixture
def league(fresh_db):
    """Active season + alice/bob/carol with $100k accounts. Returns ids/tokens."""
    with session_scope() as s:
        season = Season(name="Season test", starts_on=date(2026, 6, 1), is_active=True)
        s.add(season)
        s.flush()
        out = {"season_id": season.id, "users": {}}
        for name in ("alice", "bob", "carol"):
            user = User(name=name, api_token=f"token-{name}")
            s.add(user)
            s.flush()
            account = Account(
                user_id=user.id, season_id=season.id,
                starting_capital=100_000.0, cash=100_000.0,
            )
            s.add(account)
            s.flush()
            out["users"][name] = {
                "user_id": user.id,
                "token": user.api_token,
                "account_id": account.id,
            }
    return out


@pytest.fixture
def client(fresh_db):
    from fastapi.testclient import TestClient

    from vegalab.api.app import create_app

    with TestClient(create_app()) as c:
        yield c


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def add_instrument(s: Session, occ: str) -> Instrument:
    inst = s.query(Instrument).filter_by(symbol=occ).one_or_none()
    if inst is None:
        sym = parse_occ(occ)
        inst = Instrument(
            symbol=sym.occ, root=sym.root, expiry=sym.expiry,
            strike=sym.strike, right=sym.right,
        )
        s.add(inst)
        s.flush()
    return inst


def add_market(
    s: Session,
    occ: str,
    ts: datetime,
    *,
    bid: float,
    ask: float,
    iv: float = 0.18,
    delta: float = 0.5,
    gamma: float = 0.002,
    theta: float = -2.0,
    vega: float = 3.0,
    spot: float = 6000.0,
    synthetic: bool = False,
) -> MarketSnapshot:
    inst = add_instrument(s, occ)
    row = MarketSnapshot(
        instrument_id=inst.id,
        snapshot_ts=ts.replace(second=0, microsecond=0),
        bid=bid, ask=ask, mid=(bid + ask) / 2.0, iv=iv,
        delta=delta, gamma=gamma, theta=theta, vega=vega,
        volume=10, open_interest=100,
        underlying_px=spot, synthetic_quote=synthetic, fetched_at=ts,
    )
    s.add(row)
    s.flush()
    return row
