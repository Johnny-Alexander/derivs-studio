"""
Trading rules: fill side, average-cost math, realized PnL on reduce,
stale-data rejection, the 5× cash cap, and delta hedging.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from vegalab.db import session_scope
from vegalab.models import Account
from vegalab.services import trading

from .conftest import add_market, auth

UTC = timezone.utc
NOW = datetime(2026, 6, 10, 15, 0, tzinfo=UTC)
CALL = "SPXW260710C06000000"
PUT = "SPXW260710P06000000"


def get_account(s, account_id):
    return s.get(Account, account_id)


def test_buy_fills_at_ask_sell_at_bid(league):
    with session_scope() as s:
        add_market(s, CALL, NOW, bid=45.0, ask=46.0)
        acct = get_account(s, league["users"]["alice"]["account_id"])

        trade, pos = trading.place_trade(s, acct, CALL, "buy", 2, now=NOW)
        assert trade.fill_px == 46.0
        assert pos.qty == 2 and pos.avg_cost == 46.0
        assert acct.cash == pytest.approx(100_000 - 46.0 * 2 * 100)

        trade, pos = trading.place_trade(s, acct, CALL, "sell", 1, now=NOW)
        assert trade.fill_px == 45.0
        assert pos.qty == 1


def test_average_cost_on_adds(league):
    with session_scope() as s:
        add_market(s, CALL, NOW, bid=10.0, ask=10.0)
        acct = get_account(s, league["users"]["alice"]["account_id"])
        trading.place_trade(s, acct, CALL, "buy", 1, now=NOW)

        add_market(s, CALL, NOW + timedelta(minutes=5), bid=20.0, ask=20.0)
        _, pos = trading.place_trade(s, acct, CALL, "buy", 1, now=NOW + timedelta(minutes=5))
        assert pos.qty == 2
        assert pos.avg_cost == pytest.approx(15.0)
        assert pos.realized_pnl == 0.0


def test_realized_pnl_on_reduce_keeps_basis(league):
    with session_scope() as s:
        add_market(s, CALL, NOW, bid=10.0, ask=10.0)
        acct = get_account(s, league["users"]["alice"]["account_id"])
        trading.place_trade(s, acct, CALL, "buy", 2, now=NOW)

        add_market(s, CALL, NOW + timedelta(minutes=5), bid=14.0, ask=14.5)
        _, pos = trading.place_trade(s, acct, CALL, "sell", 1, now=NOW + timedelta(minutes=5))
        assert pos.qty == 1
        assert pos.avg_cost == 10.0  # partial close keeps the original basis
        assert pos.realized_pnl == pytest.approx((14.0 - 10.0) * 1 * 100)


def test_flip_through_zero_reopens_at_fill(league):
    with session_scope() as s:
        add_market(s, CALL, NOW, bid=10.0, ask=10.0)
        acct = get_account(s, league["users"]["alice"]["account_id"])
        trading.place_trade(s, acct, CALL, "buy", 1, now=NOW)

        add_market(s, CALL, NOW + timedelta(minutes=5), bid=12.0, ask=12.5)
        _, pos = trading.place_trade(s, acct, CALL, "sell", 3, now=NOW + timedelta(minutes=5))
        assert pos.qty == -2
        assert pos.avg_cost == 12.0  # remainder opened at the sell fill
        assert pos.realized_pnl == pytest.approx((12.0 - 10.0) * 1 * 100)


def test_short_then_cover_realized_sign(league):
    with session_scope() as s:
        add_market(s, PUT, NOW, bid=8.0, ask=8.4, delta=-0.5)
        acct = get_account(s, league["users"]["bob"]["account_id"])
        trading.place_trade(s, acct, PUT, "sell", 2, now=NOW)  # short at 8.0

        add_market(s, PUT, NOW + timedelta(minutes=5), bid=5.0, ask=5.4, delta=-0.4)
        _, pos = trading.place_trade(s, acct, PUT, "buy", 2, now=NOW + timedelta(minutes=5))
        assert pos.qty == 0
        assert pos.realized_pnl == pytest.approx((8.0 - 5.4) * 2 * 100)


def test_stale_market_data_rejected(league):
    with session_scope() as s:
        add_market(s, CALL, NOW, bid=10.0, ask=10.5)
        acct = get_account(s, league["users"]["alice"]["account_id"])
        with pytest.raises(trading.StaleMarketData):
            trading.place_trade(s, acct, CALL, "buy", 1, now=NOW + timedelta(minutes=31))
        # 29 minutes is still fine
        trading.place_trade(s, acct, CALL, "buy", 1, now=NOW + timedelta(minutes=29))


def test_cash_cap_rejected(league):
    with session_scope() as s:
        add_market(s, CALL, NOW, bid=500.0, ask=500.0)
        acct = get_account(s, league["users"]["alice"]["account_id"])
        # 12 contracts * $500 * 100 = $600k out → cash −500k, |cash| at the cap edge
        with pytest.raises(trading.CashCapExceeded):
            trading.place_trade(s, acct, CALL, "buy", 13, now=NOW)
        trading.place_trade(s, acct, CALL, "buy", 12, now=NOW)  # exactly −500k allowed


def test_unknown_instrument(league):
    with session_scope() as s:
        acct = get_account(s, league["users"]["alice"]["account_id"])
        with pytest.raises(trading.UnknownInstrument):
            trading.place_trade(s, acct, "SPXW991231C09999000", "buy", 1, now=NOW)


def test_fill_quality_synthetic_propagates(league):
    with session_scope() as s:
        add_market(s, CALL, NOW, bid=9.7, ask=10.0, synthetic=True)
        acct = get_account(s, league["users"]["alice"]["account_id"])
        trade, _ = trading.place_trade(s, acct, CALL, "buy", 1, now=NOW)
        assert trade.fill_quality == "synthetic"


def test_hedge_delta_formula_and_idempotency(league):
    with session_scope() as s:
        add_market(s, CALL, NOW, bid=10.0, ask=10.0, delta=0.6, spot=6000.0)
        acct = get_account(s, league["users"]["alice"]["account_id"])
        trading.place_trade(s, acct, CALL, "buy", 2, now=NOW)

        out = trading.hedge_delta(s, acct, target_delta=0.0, now=NOW)
        # options delta = 2 * 100 * 0.6 = 120 shares → notional = −120 × 6000
        assert out["account_delta_shares"] == pytest.approx(120.0)
        assert out["delta_hedge_notional"] == pytest.approx(-120.0 * 6000.0)

        again = trading.hedge_delta(s, acct, target_delta=0.0, now=NOW)
        assert again["delta_hedge_notional"] == pytest.approx(out["delta_hedge_notional"])


def test_trade_route_end_to_end(client, league):
    now = datetime.now(UTC)
    with session_scope() as s:
        add_market(s, CALL, now, bid=12.0, ask=12.4)

    headers = auth(league["users"]["alice"]["token"])
    r = client.post("/trade", json={"symbol": CALL, "side": "buy", "qty": 1}, headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["fill_px"] == 12.4
    assert body["position_qty"] == 1
    assert body["cash"] == pytest.approx(100_000 - 12.4 * 100)

    r = client.get("/me/trades", headers=headers)
    assert r.status_code == 200
    assert len(r.json()) == 1

    r = client.get("/me/positions", headers=headers)
    body = r.json()
    assert body["positions"][0]["symbol"] == CALL
    assert body["net_greeks"]["delta"] == pytest.approx(100 * 0.5)


def test_trade_route_maps_rejections_to_422(client, league):
    stale = datetime.now(UTC) - timedelta(hours=2)
    with session_scope() as s:
        add_market(s, CALL, stale, bid=12.0, ask=12.4)
    headers = auth(league["users"]["alice"]["token"])
    r = client.post("/trade", json={"symbol": CALL, "side": "buy", "qty": 1}, headers=headers)
    assert r.status_code == 422
    assert "stale" in r.json()["detail"]
