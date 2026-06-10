"""
Snapshot engine end-to-end with fabricated chain snapshots: attribution
rows exist, buckets sum to total, idempotency, the missing-σ residual rule,
the hedge financing leg, and per-account failure isolation.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from vegalab.data.types import ChainSnapshot, OptionQuote
from vegalab.db import session_scope
from vegalab.models import Account, PnlAttribution
from vegalab.services import snapshots as engine
from vegalab.services import trading
from vegalab.symbols import parse_occ

UTC = timezone.utc
T0 = datetime(2026, 6, 10, 14, 30, tzinfo=UTC)
CALL = "SPXW260710C06000000"
PUT = "SPXW260710P06000000"

BUCKET_KEYS = [
    "delta_pnl", "gamma_pnl", "vega_pnl", "theta_pnl",
    "vanna_pnl", "charm_pnl", "volga_pnl", "financing_pnl", "residual_pnl",
]


def quote(occ: str, bid: float, ask: float, iv: float = 0.18) -> OptionQuote:
    sym = parse_occ(occ)
    return OptionQuote(
        symbol=sym.occ, root=sym.root, expiry=sym.expiry, right=sym.right,
        strike=sym.strike, bid=bid, ask=ask, mid=(bid + ask) / 2.0, iv=iv,
        delta=0.5 if sym.right == "C" else -0.5,
        gamma=0.002, theta=-2.0, vega=3.0,
    )


def chain(ts: datetime, spot: float, options: list[OptionQuote]) -> ChainSnapshot:
    return ChainSnapshot(underlying_px=spot, fetched_at=ts, options=options)


def attribution_rows(account_id: int) -> list[PnlAttribution]:
    with session_scope() as s:
        return s.scalars(
            select(PnlAttribution)
            .where(PnlAttribution.account_id == account_id)
            .order_by(PnlAttribution.snapshot_ts)
        ).all()


def assert_buckets_sum_to_total(row: PnlAttribution):
    assert sum(getattr(row, k) for k in BUCKET_KEYS) == pytest.approx(row.total_pnl, abs=1e-6)


def seed_cycle_and_trade(league, side="buy", qty=1):
    """Snapshot at T0, alice trades at T0+2min. Returns alice's account id."""
    engine.ingest_and_attribute(chain(T0, 6000.0, [quote(CALL, 45.0, 46.0), quote(PUT, 41.0, 42.0)]))
    account_id = league["users"]["alice"]["account_id"]
    with session_scope() as s:
        acct = s.get(Account, account_id)
        trading.place_trade(s, acct, CALL, side, qty, now=T0 + timedelta(minutes=2))
    return account_id


def test_no_positions_no_attribution(league):
    summary = engine.ingest_and_attribute(chain(T0, 6000.0, [quote(CALL, 45.0, 46.0)]))
    assert summary["new_rows"] == 1
    assert summary["accounts_attributed"] == 0
    with session_scope() as s:
        assert s.scalar(select(func.count()).select_from(PnlAttribution)) == 0


def test_attribution_rows_exist_and_buckets_sum(league):
    account_id = seed_cycle_and_trade(league, "buy", 2)

    t1 = T0 + timedelta(minutes=5)
    summary = engine.ingest_and_attribute(
        chain(t1, 6030.0, [quote(CALL, 60.0, 61.0, iv=0.19), quote(PUT, 30.0, 31.0, iv=0.19)])
    )
    assert summary["accounts_attributed"] == 1

    rows = attribution_rows(account_id)
    assert len(rows) == 1
    row = rows[0]
    assert_buckets_sum_to_total(row)
    # Entry at 46 (ask), marked at 60.5 mid → +$2,900 on 2 lots
    assert row.total_pnl == pytest.approx((60.5 - 46.0) * 2 * 100)
    assert row.delta_pnl > 0  # spot rallied 30 points on a long call


def test_second_interval_uses_mid_to_mid(league):
    account_id = seed_cycle_and_trade(league)
    t1 = T0 + timedelta(minutes=5)
    t2 = T0 + timedelta(minutes=10)
    engine.ingest_and_attribute(chain(t1, 6030.0, [quote(CALL, 60.0, 61.0)]))
    engine.ingest_and_attribute(chain(t2, 6040.0, [quote(CALL, 65.0, 66.0)]))

    rows = attribution_rows(account_id)
    assert len(rows) == 2
    # second interval: mid 60.5 → 65.5
    assert rows[1].total_pnl == pytest.approx((65.5 - 60.5) * 1 * 100)
    for row in rows:
        assert_buckets_sum_to_total(row)


def test_idempotent_rerun_is_noop(league):
    account_id = seed_cycle_and_trade(league)
    t1 = T0 + timedelta(minutes=5)
    snap = chain(t1, 6030.0, [quote(CALL, 60.0, 61.0)])
    first = engine.ingest_and_attribute(snap)
    again = engine.ingest_and_attribute(snap)

    assert first["accounts_attributed"] == 1
    assert again["accounts_attributed"] == 0
    assert again["new_rows"] == 0
    assert len(attribution_rows(account_id)) == 1


def test_missing_sigma_goes_to_residual(league):
    account_id = seed_cycle_and_trade(league)
    t1 = T0 + timedelta(minutes=5)
    engine.ingest_and_attribute(chain(t1, 6030.0, [quote(CALL, 60.0, 61.0)]))

    t2 = T0 + timedelta(minutes=10)
    engine.ingest_and_attribute(chain(t2, 6035.0, [quote(CALL, 62.0, 63.0, iv=0.0)]))

    row = attribution_rows(account_id)[-1]
    assert row.total_pnl == pytest.approx((62.5 - 60.5) * 1 * 100)
    assert row.residual_pnl == pytest.approx(row.total_pnl)
    for k in BUCKET_KEYS[:-1]:
        assert getattr(row, k) == 0.0


def test_hedge_financing_leg(league):
    account_id = seed_cycle_and_trade(league)
    with session_scope() as s:
        acct = s.get(Account, account_id)
        trading.hedge_delta(s, acct, target_delta=0.0, now=T0 + timedelta(minutes=2))
        notional = acct.delta_hedge_notional
    assert notional == pytest.approx(-0.5 * 100 * 6000.0)  # short $300k vs the long call

    t1 = T0 + timedelta(minutes=5)
    engine.ingest_and_attribute(chain(t1, 6030.0, [quote(CALL, 60.0, 61.0)]))

    row = attribution_rows(account_id)[-1]
    # Hedge MTM: notional × (6030/6000 − 1) = −$1,500, plus a tiny carry cost.
    assert row.financing_pnl == pytest.approx(notional * (6030.0 / 6000.0 - 1.0), rel=1e-3)
    assert row.financing_pnl < 0
    assert_buckets_sum_to_total(row)
    # Total includes the hedge leg: option gained (60.5 − 46) × 100, hedge lost ~1.5k
    assert row.total_pnl == pytest.approx((60.5 - 46.0) * 100 + row.financing_pnl)


def test_one_account_failing_does_not_poison_others(league, monkeypatch):
    alice = seed_cycle_and_trade(league)
    bob = league["users"]["bob"]["account_id"]
    with session_scope() as s:
        acct = s.get(Account, bob)
        trading.place_trade(s, acct, PUT, "sell", 1, now=T0 + timedelta(minutes=2))

    real = engine.attribute_account

    def sabotaged(session, account, t1):
        if account.id == alice:
            raise RuntimeError("boom")
        return real(session, account, t1)

    monkeypatch.setattr(engine, "attribute_account", sabotaged)
    t1 = T0 + timedelta(minutes=5)
    summary = engine.ingest_and_attribute(
        chain(t1, 6030.0, [quote(CALL, 60.0, 61.0), quote(PUT, 30.0, 31.0)])
    )
    assert summary["accounts_failed"] == 1
    assert summary["accounts_attributed"] == 1
    assert len(attribution_rows(alice)) == 0
    assert len(attribution_rows(bob)) == 1


def test_pnl_route_serves_attribution(client, league):
    account_id = seed_cycle_and_trade(league)
    t1 = T0 + timedelta(minutes=5)
    engine.ingest_and_attribute(chain(t1, 6030.0, [quote(CALL, 60.0, 61.0)]))

    headers = {"Authorization": f"Bearer {league['users']['alice']['token']}"}
    r = client.get("/me/pnl?granularity=snapshot", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert len(body["series"]) == 1
    point = body["series"][0]
    assert sum(point[k] for k in BUCKET_KEYS) == pytest.approx(point["total_pnl"], abs=1e-6)

    r = client.get("/me/pnl?granularity=daily", headers=headers)
    assert r.status_code == 200
    daily = r.json()["series"]
    assert len(daily) == 1
    assert daily[0]["total_pnl"] == pytest.approx(point["total_pnl"])
