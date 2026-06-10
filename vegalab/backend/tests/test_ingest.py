"""
ingest persistence: instruments upserted by OCC symbol, market_snapshots
unique per (instrument, minute) — running twice in the same minute writes
once.
"""

from datetime import date, datetime, timezone

import pytest
from sqlalchemy import func, select

from vegalab import db as db_module
from vegalab.data.types import ChainSnapshot, OptionQuote
from vegalab.db import get_engine, session_scope
from vegalab.models import Base, Instrument, MarketSnapshot
from vegalab.scripts.ingest_snapshot import persist_snapshot


@pytest.fixture
def fresh_db(tmp_path):
    engine = get_engine(f"sqlite:///{tmp_path}/test.db")
    Base.metadata.create_all(engine)
    yield engine
    db_module._engine = None
    db_module._session_factory = None


def quote(symbol: str = "SPXW260619C06000000", **overrides) -> OptionQuote:
    base = dict(
        symbol=symbol, root="SPXW", expiry=date(2026, 6, 19), right="C",
        strike=6000.0, bid=45.1, ask=46.3, mid=45.7, iv=0.145,
        delta=0.51, gamma=0.002, theta=-2.1, vega=2.9,
        volume=120, open_interest=900, synthetic_quote=False,
    )
    base.update(overrides)
    return OptionQuote(**base)


def snap_at(ts: datetime, options: list[OptionQuote]) -> ChainSnapshot:
    return ChainSnapshot(underlying_px=6010.25, fetched_at=ts, options=options)


def count(session, model) -> int:
    return session.scalar(select(func.count()).select_from(model))


def test_double_run_same_minute_writes_once(fresh_db):
    t0 = datetime(2026, 6, 10, 14, 45, 12, tzinfo=timezone.utc)
    t0_later = t0.replace(second=55)  # same minute, different second
    options = [quote(), quote("SPXW260619P06000000", right="P", delta=-0.49)]

    assert persist_snapshot(snap_at(t0, options)) == 2
    assert persist_snapshot(snap_at(t0_later, options)) == 0

    with session_scope() as s:
        assert count(s, MarketSnapshot) == 2
        assert count(s, Instrument) == 2


def test_next_minute_writes_again(fresh_db):
    t0 = datetime(2026, 6, 10, 14, 45, 12, tzinfo=timezone.utc)
    t1 = datetime(2026, 6, 10, 14, 50, 3, tzinfo=timezone.utc)
    options = [quote()]

    assert persist_snapshot(snap_at(t0, options)) == 1
    assert persist_snapshot(snap_at(t1, options)) == 1

    with session_scope() as s:
        assert count(s, MarketSnapshot) == 2
        assert count(s, Instrument) == 1  # instrument upserted, not duplicated


def test_snapshot_row_contents(fresh_db):
    t0 = datetime(2026, 6, 10, 14, 45, 12, tzinfo=timezone.utc)
    persist_snapshot(snap_at(t0, [quote(synthetic_quote=True)]))

    with session_scope() as s:
        row = s.scalars(select(MarketSnapshot)).one()
        inst = s.scalars(select(Instrument)).one()
        assert inst.symbol == "SPXW260619C06000000"
        assert inst.root == "SPXW" and inst.right == "C" and inst.strike == 6000.0
        assert row.instrument_id == inst.id
        assert row.snapshot_ts.replace(tzinfo=timezone.utc) == t0.replace(second=0)
        assert row.underlying_px == 6010.25
        assert row.synthetic_quote is True
        assert row.bid == 45.1 and row.ask == 46.3 and row.mid == 45.7
