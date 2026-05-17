"""
Tests for vegalab.quant.pricing — the foundation of everything else. If these
don't pass, the rest of the app is built on sand.
"""

from __future__ import annotations

import math

import pytest

from vegalab.quant.pricing import bs_price, greeks


# ---------- Known-value reference points ----------

def test_textbook_call_no_dividend():
    """
    Classic textbook: S=K=100, T=1, r=5%, q=0, σ=20% → call ≈ 10.4506.
    """
    px = bs_price(S=100, K=100, T=1.0, r=0.05, q=0.0, sigma=0.20, right="C")
    assert px == pytest.approx(10.4506, abs=1e-3)


def test_textbook_put_no_dividend():
    """Same params as above → put ≈ 5.5735 (via put-call parity)."""
    px = bs_price(S=100, K=100, T=1.0, r=0.05, q=0.0, sigma=0.20, right="P")
    assert px == pytest.approx(5.5735, abs=1e-3)


def test_hull_example_13_6():
    """
    Hull (8th ed) Ex. 13.6: S=49, K=50, r=5%, σ=20%, T=20/52, q=0 → call ≈ 2.40.
    """
    px = bs_price(S=49, K=50, T=20.0 / 52.0, r=0.05, q=0.0, sigma=0.20, right="C")
    assert px == pytest.approx(2.40, abs=1e-2)


# ---------- Put-call parity ----------

@pytest.mark.parametrize("S,K,T,r,q,sigma", [
    (100, 100, 1.0, 0.05, 0.00, 0.20),
    (100, 110, 0.5, 0.04, 0.02, 0.25),
    (100,  90, 0.5, 0.04, 0.02, 0.25),
    (5847, 5850, 17/365, 0.0438, 0.015, 0.16),
])
def test_put_call_parity(S, K, T, r, q, sigma):
    """C − P = S·e^(−qT) − K·e^(−rT)"""
    c = bs_price(S, K, T, r, q, sigma, "C")
    p = bs_price(S, K, T, r, q, sigma, "P")
    lhs = c - p
    rhs = S * math.exp(-q * T) - K * math.exp(-r * T)
    assert lhs == pytest.approx(rhs, abs=1e-8)


# ---------- Finite-difference checks for each Greek ----------

# Test grid spanning ITM / ATM / OTM, call/put, short/long dated.
CASES = [
    # (S, K, T, r, q, sigma, right)
    (100, 100, 0.25, 0.05, 0.02, 0.20, "C"),  # ATM call short-dated
    (100, 110, 0.25, 0.05, 0.02, 0.20, "C"),  # OTM call
    (100,  90, 0.25, 0.05, 0.02, 0.20, "C"),  # ITM call
    (100, 100, 0.50, 0.04, 0.015, 0.18, "P"),  # ATM put medium
    (5847, 5850, 17/365, 0.0438, 0.015, 0.16, "C"),  # realistic SPX
    (5847, 5700, 38/365, 0.0438, 0.015, 0.22, "P"),  # OTM SPX put
]


def _fd1(f, x, h):
    return (f(x + h) - f(x - h)) / (2.0 * h)


def _fd2(f, x, h):
    return (f(x + h) - 2.0 * f(x) + f(x - h)) / (h * h)


def _fd_cross(f, x, y, hx, hy):
    return (
        f(x + hx, y + hy) - f(x + hx, y - hy)
        - f(x - hx, y + hy) + f(x - hx, y - hy)
    ) / (4.0 * hx * hy)


# Bump sizes per the handover. We scale a couple of them slightly for stability.
H_S_REL = 1e-4         # relative bump for spot — 0.01% (handover says 0.01 absolute, but relative is cleaner across S=100 and S=5800)
H_S_GAMMA_REL = 5e-4   # larger bump for 2nd-order (the handover suggests 0.5 on S=100)
H_SIGMA = 1e-4
H_SIGMA_VOLGA = 1e-3   # 2nd-order on σ needs a bigger bump
H_T = 1.0 / (365.0 * 24.0)


@pytest.mark.parametrize("S,K,T,r,q,sigma,right", CASES)
def test_fd_delta(S, K, T, r, q, sigma, right):
    cf = greeks(S, K, T, r, q, sigma, right)["delta"]
    h = S * H_S_REL
    fd = _fd1(lambda s: bs_price(s, K, T, r, q, sigma, right), S, h)
    assert fd == pytest.approx(cf, rel=1e-3, abs=1e-6)


@pytest.mark.parametrize("S,K,T,r,q,sigma,right", CASES)
def test_fd_gamma(S, K, T, r, q, sigma, right):
    cf = greeks(S, K, T, r, q, sigma, right)["gamma"]
    h = S * H_S_GAMMA_REL
    fd = _fd2(lambda s: bs_price(s, K, T, r, q, sigma, right), S, h)
    assert fd == pytest.approx(cf, rel=1e-2, abs=1e-6)


@pytest.mark.parametrize("S,K,T,r,q,sigma,right", CASES)
def test_fd_vega(S, K, T, r, q, sigma, right):
    cf = greeks(S, K, T, r, q, sigma, right)["vega"]  # per vol-point
    fd_raw = _fd1(lambda sg: bs_price(S, K, T, r, q, sg, right), sigma, H_SIGMA)
    fd = fd_raw / 100.0  # convert raw to per-vol-point
    assert fd == pytest.approx(cf, rel=1e-3, abs=1e-6)


@pytest.mark.parametrize("S,K,T,r,q,sigma,right", CASES)
def test_fd_theta(S, K, T, r, q, sigma, right):
    cf = greeks(S, K, T, r, q, sigma, right)["theta"]  # per day
    # Theta = ∂Price/∂t = -∂Price/∂T (T decreases as time passes)
    fd_year = -_fd1(lambda tt: bs_price(S, K, tt, r, q, sigma, right), T, H_T)
    fd = fd_year / 365.0  # convert per-year to per-day
    assert fd == pytest.approx(cf, rel=1e-3, abs=1e-6)


@pytest.mark.parametrize("S,K,T,r,q,sigma,right", CASES)
def test_fd_vanna(S, K, T, r, q, sigma, right):
    cf = greeks(S, K, T, r, q, sigma, right)["vanna"]
    h_s = S * H_S_GAMMA_REL
    fd = _fd_cross(
        lambda s, sg: bs_price(s, K, T, r, q, sg, right),
        S, sigma, h_s, H_SIGMA_VOLGA,
    )
    # Vanna can be very near zero for near-ATM; allow generous absolute floor.
    assert fd == pytest.approx(cf, rel=1e-2, abs=1e-4)


@pytest.mark.parametrize("S,K,T,r,q,sigma,right", CASES)
def test_fd_charm(S, K, T, r, q, sigma, right):
    cf = greeks(S, K, T, r, q, sigma, right)["charm"]
    # charm = ∂Δ/∂t = -∂Δ/∂T = -∂²Price/∂S∂T
    h_s = S * H_S_GAMMA_REL
    h_t = max(T * 1e-3, H_T)
    fd_cross_st = _fd_cross(
        lambda s, tt: bs_price(s, K, tt, r, q, sigma, right),
        S, T, h_s, h_t,
    )
    fd = -fd_cross_st
    assert fd == pytest.approx(cf, rel=1e-2, abs=1e-4)


@pytest.mark.parametrize("S,K,T,r,q,sigma,right", CASES)
def test_fd_volga(S, K, T, r, q, sigma, right):
    cf = greeks(S, K, T, r, q, sigma, right)["volga"]
    fd = _fd2(lambda sg: bs_price(S, K, T, r, q, sg, right), sigma, H_SIGMA_VOLGA)
    assert fd == pytest.approx(cf, rel=1e-2, abs=1e-4)


# ---------- Sanity-check signs and basic relationships ----------

def test_call_delta_in_unit_interval():
    g = greeks(100, 100, 0.5, 0.05, 0.02, 0.20, "C")
    assert 0.0 < g["delta"] < 1.0


def test_put_delta_negative():
    g = greeks(100, 100, 0.5, 0.05, 0.02, 0.20, "P")
    assert -1.0 < g["delta"] < 0.0


def test_long_call_theta_negative():
    """Long options should bleed value with time."""
    g = greeks(100, 100, 0.5, 0.05, 0.02, 0.20, "C")
    assert g["theta"] < 0


def test_gamma_positive():
    g = greeks(100, 100, 0.5, 0.05, 0.02, 0.20, "C")
    assert g["gamma"] > 0


def test_vega_positive():
    g = greeks(100, 100, 0.5, 0.05, 0.02, 0.20, "C")
    assert g["vega"] > 0


def test_vanna_volga_call_equal_put():
    """Vanna and volga are model-symmetric for calls and puts."""
    gc = greeks(100, 110, 0.5, 0.05, 0.02, 0.25, "C")
    gp = greeks(100, 110, 0.5, 0.05, 0.02, 0.25, "P")
    assert gc["vanna"] == pytest.approx(gp["vanna"], abs=1e-12)
    assert gc["volga"] == pytest.approx(gp["volga"], abs=1e-12)
    assert gc["gamma"] == pytest.approx(gp["gamma"], abs=1e-12)
    assert gc["vega"]  == pytest.approx(gp["vega"],  abs=1e-12)


def test_invalid_right_raises():
    with pytest.raises(ValueError):
        bs_price(100, 100, 0.5, 0.05, 0.0, 0.2, "X")
    with pytest.raises(ValueError):
        greeks(100, 100, 0.5, 0.05, 0.0, 0.2, "X")


def test_nonpositive_T_raises():
    with pytest.raises(ValueError):
        bs_price(100, 100, 0.0, 0.05, 0.0, 0.2, "C")
    with pytest.raises(ValueError):
        greeks(100, 100, -0.1, 0.05, 0.0, 0.2, "C")


def test_nonpositive_sigma_raises():
    with pytest.raises(ValueError):
        bs_price(100, 100, 0.5, 0.05, 0.0, 0.0, "C")
    with pytest.raises(ValueError):
        greeks(100, 100, 0.5, 0.05, 0.0, -0.2, "C")
