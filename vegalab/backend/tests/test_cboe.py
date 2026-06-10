"""
CboeProvider against mocked httpx (pytest-httpx): happy path off the
committed fixture, the solver/synthesis/drop quality paths, the universe
filter, and the mandatory User-Agent header.
"""

import json
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

from vegalab.data.providers.cboe import USER_AGENT, CboeProvider

FIXTURE = Path(__file__).parent / "fixtures" / "cboe" / "_SPX_sample.json"
# The fixture is frozen at this instant (see fixtures/cboe/_generate_sample.py).
FROZEN_NOW = datetime(2026, 6, 10, 14, 45, 0, tzinfo=timezone.utc)
URL = "https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json"


def provider() -> CboeProvider:
    return CboeProvider(now_fn=lambda: FROZEN_NOW)


def fixture_payload() -> dict:
    return json.loads(FIXTURE.read_text())


def minimal_payload(options: list[dict], spot: float = 6010.25) -> dict:
    return {"data": {"current_price": spot, "options": options}}


@pytest.fixture
def serve(httpx_mock):
    def _serve(payload: dict):
        httpx_mock.add_response(url=URL, json=payload)
    return _serve


async def test_happy_path_from_fixture(serve):
    serve(fixture_payload())
    snap = await provider().get_snapshot()

    assert snap.underlying_px == 6010.25
    assert snap.fetched_at == FROZEN_NOW
    # 30 rows in the fixture; 4 are built to be dropped (both-zero quote,
    # >15% moneyness, >120 DTE, |delta|>0.99).
    assert len(snap.options) == 26
    syn = [o for o in snap.options if o.synthetic_quote]
    assert len(syn) == 1 and syn[0].symbol == "SPXW260619P05775000"

    o = next(o for o in snap.options if o.symbol == "SPXW260619C05750000")
    assert o.root == "SPXW" and o.right == "C" and o.strike == 5750.0
    assert o.expiry == date(2026, 6, 19)
    assert o.bid == 265.59 and o.ask == 269.33
    assert o.mid == pytest.approx((265.59 + 269.33) / 2)
    assert o.iv == pytest.approx(0.1691)
    assert o.delta == pytest.approx(0.9536)
    assert o.volume == 350 and o.open_interest == 1200
    # Both roots make it through.
    assert {o.root for o in snap.options} == {"SPX", "SPXW"}


async def test_user_agent_header_present(serve, httpx_mock):
    serve(fixture_payload())
    await provider().get_snapshot()
    request = httpx_mock.get_requests()[0]
    assert request.headers["User-Agent"] == USER_AGENT
    assert "Mozilla/5.0" in request.headers["User-Agent"]


async def test_missing_iv_triggers_solver(serve):
    # iv=0 in the feed but a sane mid: the Brent solver must back out an IV
    # close to the one the fixture's mid was generated from (~0.1547 smile).
    serve(fixture_payload())
    snap = await provider().get_snapshot()
    o = next(o for o in snap.options if o.symbol == "SPX260717C06025000")
    assert 0.10 < o.iv < 0.25
    assert o.iv >= 0.005


async def test_zero_bid_synthesis(serve):
    row = {
        "option": "SPXW260619C06100000",
        "bid": 0.0, "ask": 9.0, "iv": 0.13,
        "delta": 0.18, "gamma": 0.001, "theta": -0.9, "vega": 1.9,
        "volume": 5, "open_interest": 10, "last_trade_price": 8.6,
    }
    serve(minimal_payload([row]))
    snap = await provider().get_snapshot()
    assert len(snap.options) == 1
    o = snap.options[0]
    assert o.synthetic_quote is True
    # spread = max(0.30, 0.025 * last_trade_price=8.6) = 0.30
    assert o.bid == pytest.approx(max(0.05, 9.0 - 0.30))
    assert o.ask == 9.0


async def test_zero_bid_synthesis_wide_spread_floor(serve):
    # mid_estimate big enough that 2.5% of it beats the $0.30 floor
    row = {
        "option": "SPXW260619C05900000",
        "bid": 0.0, "ask": 120.0, "iv": 0.14,
        "delta": 0.75, "gamma": 0.002, "theta": -1.2, "vega": 2.5,
        "volume": 1, "open_interest": 2, "last_trade_price": 118.0,
    }
    serve(minimal_payload([row]))
    snap = await provider().get_snapshot()
    o = snap.options[0]
    assert o.bid == pytest.approx(120.0 - 0.025 * 118.0)
    assert o.synthetic_quote is True


async def test_both_zero_dropped(serve):
    row = {
        "option": "SPXW260619C06000000",
        "bid": 0.0, "ask": 0.0, "iv": 0.14,
        "delta": 0.5, "gamma": 0.002, "theta": -1.0, "vega": 2.0,
    }
    serve(minimal_payload([row]))
    snap = await provider().get_snapshot()
    assert snap.options == []


async def test_universe_filter(serve):
    common = {"iv": 0.15, "gamma": 0.001, "theta": -0.5, "vega": 1.0,
              "bid": 1.0, "ask": 1.4}
    rows = [
        # keep: 37 DTE, near the money, mid delta
        {"option": "SPX260717C06000000", "delta": 0.52, **common},
        # drop: |delta| below 0.01
        {"option": "SPX260717C06100000", "delta": 0.004, **common},
        # drop: |delta| above 0.99
        {"option": "SPX260717C05200000", "delta": 0.995, **common},
        # drop: strike more than 15% from spot
        {"option": "SPX260717C07200000", "delta": 0.05, **common},
        # drop: expiry beyond 120 DTE
        {"option": "SPX261218C06000000", "delta": 0.55, **common},
        # drop: already expired
        {"option": "SPX260609C06000000", "delta": 0.55, **common},
    ]
    serve(minimal_payload(rows))
    snap = await provider().get_snapshot()
    assert [o.symbol for o in snap.options] == ["SPX260717C06000000"]


async def test_unparseable_rows_skipped_not_fatal(serve):
    rows = [
        {"option": "GARBAGE", "bid": 1.0, "ask": 1.2, "iv": 0.2, "delta": 0.5,
         "gamma": 0.001, "theta": -0.5, "vega": 1.0},
        {"option": "SPX260717C06000000", "bid": 95.0, "ask": 97.0, "iv": 0.15,
         "delta": 0.52, "gamma": 0.001, "theta": -0.5, "vega": 1.0},
    ]
    serve(minimal_payload(rows))
    snap = await provider().get_snapshot()
    assert [o.symbol for o in snap.options] == ["SPX260717C06000000"]


async def test_http_error_raises(httpx_mock):
    for _ in range(3):  # provider retries twice before giving up
        httpx_mock.add_response(url=URL, status_code=503)
    with pytest.raises(Exception):
        await provider().get_snapshot()
