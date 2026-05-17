"""Tests for vegalab.quant.iv_solver — round-trip and bracket behavior."""

from __future__ import annotations

import pytest

from vegalab.quant.iv_solver import solve_iv
from vegalab.quant.pricing import bs_price


@pytest.mark.parametrize("S,K,T,r,q,sigma,right", [
    (100, 100, 0.5,  0.05, 0.00, 0.20, "C"),
    (100, 100, 0.5,  0.05, 0.00, 0.20, "P"),
    (100, 110, 0.25, 0.04, 0.02, 0.35, "C"),
    (100,  90, 0.25, 0.04, 0.02, 0.45, "P"),
    (5847, 5850, 17/365, 0.0438, 0.015, 0.16, "C"),
    (5847, 5700, 38/365, 0.0438, 0.015, 0.22, "P"),
    (5847, 6000, 17/365, 0.0438, 0.015, 0.08, "C"),  # very OTM, low vol
    (5847, 5800, 220/365, 0.0438, 0.015, 0.18, "P"),  # long-dated
])
def test_iv_round_trip(S, K, T, r, q, sigma, right):
    price = bs_price(S, K, T, r, q, sigma, right)
    iv = solve_iv(price, S, K, T, r, q, right)
    assert iv is not None
    assert iv == pytest.approx(sigma, abs=1e-6)


def test_returns_none_for_negative_price():
    assert solve_iv(-1.0, 100, 100, 0.5, 0.05, 0.0, "C") is None


def test_returns_none_for_zero_T():
    price = 5.0
    assert solve_iv(price, 100, 100, 0.0, 0.05, 0.0, "C") is None


def test_returns_none_for_price_above_no_arb_upper():
    # Call price can't exceed S·e^(-qT)
    assert solve_iv(1000.0, 100, 100, 0.5, 0.05, 0.0, "C") is None


def test_returns_none_for_price_below_intrinsic():
    # ITM call with price below intrinsic should be unsolvable
    # Intrinsic for S=100,K=80 is ~20 (forward-discounted)
    assert solve_iv(1.0, 100, 80, 0.5, 0.05, 0.0, "C") is None


def test_recovers_very_low_vol():
    """Boundary case near the lower end of the bracket."""
    sigma = 0.02
    price = bs_price(100, 100, 0.5, 0.05, 0.0, sigma, "C")
    iv = solve_iv(price, 100, 100, 0.5, 0.05, 0.0, "C")
    assert iv == pytest.approx(sigma, abs=1e-6)


def test_recovers_very_high_vol():
    """Boundary case at the upper end of the bracket."""
    sigma = 2.0
    price = bs_price(100, 100, 0.5, 0.05, 0.0, sigma, "C")
    iv = solve_iv(price, 100, 100, 0.5, 0.05, 0.0, "C")
    assert iv == pytest.approx(sigma, abs=1e-6)
