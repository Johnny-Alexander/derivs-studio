"""
YahooProvider against fake yfinance objects: placeholder IV (~1e-5)
triggers the Brent solver, zero bid/ask handling, per-expiry failure
tolerance, and the 120-DTE expiry cut.
"""

from datetime import datetime, timezone
from types import SimpleNamespace

import pandas as pd
import pytest

from vegalab.data.providers.yahoo import YahooProvider
from vegalab.quant.pricing import bs_price

FROZEN_NOW = datetime(2026, 6, 10, 14, 45, 0, tzinfo=timezone.utc)
SPOT = 6010.25


class FakeTicker:
    def __init__(self, chains: dict[str, SimpleNamespace], spot: float = SPOT):
        self.options = tuple(chains.keys())
        self._chains = chains
        self._spot = spot
        self.requested_expiries: list[str] = []

    def history(self, period="1d"):
        return pd.DataFrame({"Close": [self._spot]})

    def option_chain(self, expiry: str):
        self.requested_expiries.append(expiry)
        chain = self._chains[expiry]
        if isinstance(chain, Exception):
            raise chain
        return chain


def frame(rows: list[dict]) -> pd.DataFrame:
    cols = ["contractSymbol", "strike", "lastPrice", "bid", "ask",
            "volume", "openInterest", "impliedVolatility"]
    return pd.DataFrame(rows, columns=cols)


def empty() -> pd.DataFrame:
    return frame([])


def provider_for(chains: dict) -> tuple[YahooProvider, FakeTicker]:
    ticker = FakeTicker(chains)
    return YahooProvider(ticker_factory=lambda s: ticker, now_fn=lambda: FROZEN_NOW), ticker


async def test_placeholder_iv_triggers_solver():
    # Yahoo's notorious 1e-5 placeholder IV with an otherwise sane quote:
    # the quality layer must recompute IV from mid via Brent.
    true_iv = 0.16
    T = (37 * 86400 + 6.25 * 3600) / (365 * 86400)  # 2026-07-17 21:00Z from FROZEN_NOW
    mid = bs_price(SPOT, 6000.0, T, 0.0438, 0.015, true_iv, "C")
    row = {
        "contractSymbol": "SPX260717C06000000", "strike": 6000.0,
        "lastPrice": mid, "bid": mid - 1.0, "ask": mid + 1.0,
        "volume": 10, "openInterest": 100, "impliedVolatility": 1e-05,
    }
    prov, _ = provider_for({"2026-07-17": SimpleNamespace(calls=frame([row]), puts=empty())})
    snap = await prov.get_snapshot()

    assert len(snap.options) == 1
    o = snap.options[0]
    assert o.iv == pytest.approx(true_iv, abs=0.01)
    # Yahoo supplies no Greeks; they must be computed from the solved IV.
    assert 0.4 < o.delta < 0.7
    assert o.theta < 0 and o.vega > 0 and o.gamma > 0


async def test_zero_bid_synthesised_and_flagged():
    row = {
        "contractSymbol": "SPX260717P05900000", "strike": 5900.0,
        "lastPrice": 45.0, "bid": 0.0, "ask": 46.0,
        "volume": 3, "openInterest": 50, "impliedVolatility": 0.17,
    }
    prov, _ = provider_for({"2026-07-17": SimpleNamespace(calls=empty(), puts=frame([row]))})
    snap = await prov.get_snapshot()

    assert len(snap.options) == 1
    o = snap.options[0]
    assert o.synthetic_quote is True
    # spread = max(0.30, 0.025 * lastPrice=45) = 1.125
    assert o.bid == pytest.approx(46.0 - 1.125)


async def test_both_zero_dropped():
    row = {
        "contractSymbol": "SPX260717C06050000", "strike": 6050.0,
        "lastPrice": 60.0, "bid": 0.0, "ask": 0.0,
        "volume": 0, "openInterest": 0, "impliedVolatility": 0.15,
    }
    prov, _ = provider_for({"2026-07-17": SimpleNamespace(calls=frame([row]), puts=empty())})
    snap = await prov.get_snapshot()
    assert snap.options == []


async def test_expiries_beyond_120_dte_not_fetched():
    near = SimpleNamespace(calls=empty(), puts=empty())
    prov, ticker = provider_for({"2026-07-17": near, "2026-12-18": near, "2025-06-01": near})
    await prov.get_snapshot()
    assert ticker.requested_expiries == ["2026-07-17"]


async def test_one_bad_expiry_does_not_poison_the_rest():
    good_row = {
        "contractSymbol": "SPX260717C06000000", "strike": 6000.0,
        "lastPrice": 100.0, "bid": 99.0, "ask": 101.0,
        "volume": 1, "openInterest": 1, "impliedVolatility": 0.155,
    }
    prov, _ = provider_for({
        "2026-06-19": RuntimeError("yahoo flaked"),
        "2026-07-17": SimpleNamespace(calls=frame([good_row]), puts=empty()),
    })
    snap = await prov.get_snapshot()
    assert [o.symbol for o in snap.options] == ["SPX260717C06000000"]


async def test_unparseable_contract_falls_back_to_components():
    # Yahoo sometimes serves odd contract symbols; we rebuild from
    # strike/expiry/right with an SPX root rather than dropping the row.
    row = {
        "contractSymbol": "weird!!", "strike": 6000.0,
        "lastPrice": 100.0, "bid": 99.0, "ask": 101.0,
        "volume": 1, "openInterest": 1, "impliedVolatility": 0.155,
    }
    prov, _ = provider_for({"2026-07-17": SimpleNamespace(calls=frame([row]), puts=empty())})
    snap = await prov.get_snapshot()
    assert [o.symbol for o in snap.options] == ["SPX260717C06000000"]
