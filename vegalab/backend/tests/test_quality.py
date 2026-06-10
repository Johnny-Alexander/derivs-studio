"""Direct unit tests for the shared data-quality rules."""

from datetime import date, datetime, timezone

import pytest

from vegalab.data.quality import RawQuote, clean_quote, year_fraction
from vegalab.symbols import OptionSymbol

NOW = datetime(2026, 6, 10, 14, 45, 0, tzinfo=timezone.utc)
SPOT = 6010.25


def raw(strike=6000.0, right="C", expiry=date(2026, 7, 17), **overrides) -> RawQuote:
    base = dict(
        sym=OptionSymbol(root="SPX", expiry=expiry, right=right, strike=strike),
        bid=95.0, ask=97.0, iv=0.15, delta=0.52, gamma=0.001, theta=-1.1, vega=2.4,
        volume=10, open_interest=100, last_trade_price=96.0,
    )
    base.update(overrides)
    return RawQuote(**base)


def test_year_fraction_uses_2100_utc_cutoff():
    T = year_fraction(date(2026, 7, 17), NOW)
    assert T == pytest.approx((37 * 86400 + 6.25 * 3600) / (365 * 86400))


def test_year_fraction_floored_for_0dte():
    nearly_expired = datetime(2026, 7, 17, 20, 59, 0, tzinfo=timezone.utc)
    assert year_fraction(date(2026, 7, 17), nearly_expired) >= 1.0 / (365 * 24)


def test_clean_quote_passthrough():
    q = clean_quote(raw(), SPOT, NOW)
    assert q is not None
    assert q.synthetic_quote is False
    assert q.mid == pytest.approx(96.0)
    assert q.iv == 0.15 and q.delta == 0.52  # provider values trusted


def test_negative_quotes_dropped():
    assert clean_quote(raw(bid=-1.0), SPOT, NOW) is None


def test_crossed_market_dropped():
    assert clean_quote(raw(bid=10.0, ask=5.0), SPOT, NOW) is None


def test_synthetic_bid_floor_at_5_cents():
    # ask so small that ask - spread goes negative -> bid floored at 0.05
    q = clean_quote(raw(bid=0.0, ask=0.20, last_trade_price=0.18, delta=0.02), SPOT, NOW)
    assert q is not None
    assert q.bid == 0.05
    assert q.synthetic_quote is True


def test_zero_ask_synthesised_too():
    q = clean_quote(raw(bid=95.0, ask=0.0), SPOT, NOW)
    assert q is not None
    assert q.synthetic_quote is True
    assert q.ask == pytest.approx(95.0 + max(0.30, 0.025 * 96.0))


def test_unsolvable_mid_dropped():
    # IV missing and mid below intrinsic -> solver fails -> drop
    q = clean_quote(
        raw(strike=5200.0, bid=700.0, ask=702.0, iv=None, delta=None,
            gamma=None, theta=None, vega=None, last_trade_price=None),
        SPOT, NOW,
    )
    assert q is None


def test_missing_greeks_computed_from_iv():
    q = clean_quote(raw(delta=None, gamma=None, theta=None, vega=None), SPOT, NOW)
    assert q is not None
    assert 0.4 < q.delta < 0.7
    assert q.gamma > 0 and q.vega > 0 and q.theta < 0
