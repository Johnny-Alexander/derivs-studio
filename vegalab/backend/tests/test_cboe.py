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
# Real capture taken at this instant (see fixtures/cboe/README.md).
FROZEN_NOW = datetime(2026, 6, 10, 9, 7, 11, tzinfo=timezone.utc)
SPOT = 7386.6499
URL = "https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json"


def provider() -> CboeProvider:
    return CboeProvider(now_fn=lambda: FROZEN_NOW)


def fixture_payload() -> dict:
    return json.loads(FIXTURE.read_text())


# Constructed-row tests below keep their own spot; strikes were chosen
# around this level.
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

    assert snap.underlying_px == SPOT
    assert snap.fetched_at == FROZEN_NOW
    # 28 real rows in the fixture; 8 are dropped (far-OTM teenies on
    # moneyness, 464/128 DTE on the DTE cut, |delta|>0.99 on the band).
    assert len(snap.options) == 20
    assert snap.synthetic_fraction == 0.0  # capture had no in-universe one-sided rows

    dropped = {r["option"] for r in fixture_payload()["data"]["options"]}
    dropped -= {o.symbol for o in snap.options}
    assert dropped == {
        "SPX260618P00200000", "SPX260618P00400000",   # ±15% moneyness
        "SPX270917C00400000", "SPX270917C00600000",   # 464 DTE (also both-zero)
        "SPX261016C06280000", "SPX261016P06280000",   # 128 DTE
        "SPX260618P07770000", "SPX260618P07775000",   # |delta| > 0.99
    }

    o = next(o for o in snap.options if o.symbol == "SPX260618C07380000")
    assert o.root == "SPX" and o.right == "C" and o.strike == 7380.0
    assert o.expiry == date(2026, 6, 18)
    assert o.bid == 67.2 and o.ask == 67.9
    assert o.mid == pytest.approx((67.2 + 67.9) / 2)
    assert o.iv == pytest.approx(0.1943)
    assert o.delta == pytest.approx(0.436)
    assert o.volume == 2270 and o.open_interest == 4583
    # Both roots make it through.
    assert {o.root for o in snap.options} == {"SPX", "SPXW"}


async def test_user_agent_header_present(serve, httpx_mock):
    serve(fixture_payload())
    await provider().get_snapshot()
    request = httpx_mock.get_requests()[0]
    assert request.headers["User-Agent"] == USER_AGENT
    assert "Mozilla/5.0" in request.headers["User-Agent"]


async def test_missing_iv_triggers_solver(serve):
    # Real 0DTE deep-ITM puts with iv=0.0 in the feed but live two-sided
    # quotes: the Brent solver must back out a usable IV from mid. The
    # pre-market quotes are wide, so the solved vol is high but finite.
    serve(fixture_payload())
    snap = await provider().get_snapshot()
    for sym in ("SPXW260610P07475000", "SPXW260610P07480000"):
        o = next(o for o in snap.options if o.symbol == sym)
        assert 0.3 < o.iv < 1.5
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
