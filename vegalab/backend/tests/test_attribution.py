"""
Tests for vegalab.quant.attribution.

The core invariant: total_pnl = actual ΔPnL exactly, and for small moves the
residual is tiny (the Taylor expansion captures almost everything).
"""

from __future__ import annotations

import math

import pytest

from vegalab.quant.attribution import attribute
from vegalab.quant.pricing import bs_price


# ---------- Identity: every bucket sums to total within rounding ----------

def _make_snap(S, K, T, r, q, sigma, right):
    return {
        "S": S,
        "sigma": sigma,
        "T": T,
        "price": bs_price(S, K, T, r, q, sigma, right),
        "r": r,
    }


def test_buckets_plus_residual_equal_total_exactly():
    """By construction: sum(buckets) + residual ≡ total_pnl."""
    K, right, q, r = 5850.0, "C", 0.015, 0.0438
    t0 = _make_snap(5847.0, K, 17/365, r, q, 0.16, right)
    t1 = _make_snap(5852.0, K, (17 - 1/24)/365, r, q, 0.165, right)  # 1h elapsed
    out = attribute(
        position_qty=5, K=K, right=right, q=q,
        snap_t0=t0, snap_t1=t1,
    )
    bucket_sum = sum(
        v for k, v in out.items()
        if k.endswith("_pnl") and k != "total_pnl"
    )
    assert bucket_sum == pytest.approx(out["total_pnl"], abs=1e-9)


# ---------- Edge case: zero move ----------

def test_zero_move_all_buckets_zero():
    """If nothing changes, all buckets and the residual are zero."""
    K, right, q, r = 100.0, "C", 0.02, 0.05
    snap = _make_snap(100.0, K, 0.25, r, q, 0.20, right)
    out = attribute(
        position_qty=10, K=K, right=right, q=q,
        snap_t0=snap, snap_t1=dict(snap),
    )
    for key, val in out.items():
        assert val == pytest.approx(0.0, abs=1e-9), f"{key} was {val}"


# ---------- Edge case: time only (no spot or vol move) ----------

def test_time_only_move_isolates_theta():
    """
    When only T changes (no spot, no vol), only theta should contribute —
    other buckets that depend on ΔS or Δσ must vanish.
    """
    K, right, q, r = 100.0, "C", 0.02, 0.05
    t0 = _make_snap(100.0, K, 0.25, r, q, 0.20, right)
    t1 = _make_snap(100.0, K, 0.25 - 1.0/365.0, r, q, 0.20, right)  # 1 day passes
    out = attribute(
        position_qty=5, K=K, right=right, q=q,
        snap_t0=t0, snap_t1=t1,
    )
    assert out["delta_pnl"] == pytest.approx(0.0, abs=1e-12)
    assert out["gamma_pnl"] == pytest.approx(0.0, abs=1e-12)
    assert out["vega_pnl"]  == pytest.approx(0.0, abs=1e-12)
    assert out["vanna_pnl"] == pytest.approx(0.0, abs=1e-12)
    assert out["charm_pnl"] == pytest.approx(0.0, abs=1e-12)
    assert out["volga_pnl"] == pytest.approx(0.0, abs=1e-12)
    # Theta is the only non-trivial bucket, residual should be small (third-order in Δt).
    assert out["theta_pnl"] != 0
    assert abs(out["residual_pnl"]) < 0.01 * abs(out["theta_pnl"])


# ---------- Edge case: spot-only move ----------

def test_spot_only_small_move_explained_by_delta_gamma():
    """A pure spot move should be almost entirely explained by Δ+Γ."""
    K, right, q, r = 100.0, "C", 0.02, 0.05
    t0 = _make_snap(100.0, K, 0.25, r, q, 0.20, right)
    t1 = _make_snap(100.5, K, 0.25, r, q, 0.20, right)  # +0.5 in spot
    out = attribute(
        position_qty=5, K=K, right=right, q=q,
        snap_t0=t0, snap_t1=t1,
    )
    explained = out["delta_pnl"] + out["gamma_pnl"]
    total = out["total_pnl"]
    # Residual should be tiny — third-order in dS
    assert abs(out["residual_pnl"]) < 1e-3 * abs(total)
    assert explained == pytest.approx(total, rel=1e-3)


# ---------- Synthetic reconstruction: small spot+vol move ----------

@pytest.mark.parametrize("S,K,T,r,q,sigma,right,qty", [
    (100, 100, 0.25, 0.05, 0.02, 0.20, "C", 5),
    (100, 110, 0.25, 0.05, 0.02, 0.20, "C", -3),
    (100,  90, 0.50, 0.04, 0.01, 0.25, "P", 7),
    (5847, 5850, 17/365, 0.0438, 0.015, 0.16, "C", 5),
])
def test_small_move_residual_tiny(S, K, T, r, q, sigma, right, qty):
    """
    Move spot by 0.1% and vol by 10 bps over 5 minutes. The Taylor expansion
    should explain > 99.9% of the move; residual < 0.1% of total |PnL|.
    """
    dS = S * 0.001
    dsigma = 0.001
    dt_years = (5.0 / 60.0) / (24.0 * 365.0)  # 5 minutes

    t0 = _make_snap(S, K, T, r, q, sigma, right)
    t1 = _make_snap(S + dS, K, T - dt_years, r, q, sigma + dsigma, right)
    out = attribute(
        position_qty=qty, K=K, right=right, q=q,
        snap_t0=t0, snap_t1=t1,
    )
    total = abs(out["total_pnl"])
    if total > 1e-6:
        assert abs(out["residual_pnl"]) < 1e-3 * total, (
            f"residual {out['residual_pnl']:.6f} too large vs total {out['total_pnl']:.6f}"
        )


# ---------- Multiplier and qty sign ----------

def test_short_position_flips_sign():
    """A −5 lot and a +5 lot of the same move should have opposite-sign PnL."""
    K, right, q, r = 100.0, "C", 0.02, 0.05
    t0 = _make_snap(100.0, K, 0.25, r, q, 0.20, right)
    t1 = _make_snap(101.0, K, 0.25, r, q, 0.20, right)
    long_out = attribute(5, K, right, q, t0, t1)
    short_out = attribute(-5, K, right, q, t0, t1)
    for key in ("delta_pnl", "gamma_pnl", "total_pnl"):
        assert long_out[key] == pytest.approx(-short_out[key], abs=1e-9)


def test_multiplier_applied():
    """SPX is 100x — total_pnl must include the multiplier."""
    K, right, q, r = 100.0, "C", 0.02, 0.05
    t0 = _make_snap(100.0, K, 0.25, r, q, 0.20, right)
    t1 = _make_snap(101.0, K, 0.25, r, q, 0.20, right)
    out = attribute(1, K, right, q, t0, t1, multiplier=100)
    expected = 100 * (t1["price"] - t0["price"])
    assert out["total_pnl"] == pytest.approx(expected, abs=1e-9)


# ---------- Hedge + financing legs ----------

def test_hedge_and_financing_legs_zero_when_no_hedge():
    K, right, q, r = 100.0, "C", 0.02, 0.05
    t0 = _make_snap(100.0, K, 0.25, r, q, 0.20, right)
    t1 = _make_snap(101.0, K, 0.25 - 1/365, r, q, 0.20, right)
    out = attribute(5, K, right, q, t0, t1, account_state={})
    assert out["hedge_pnl"] == 0.0
    assert out["financing_pnl"] == 0.0


def test_hedge_leg_long_hedge_gains_on_spot_up():
    """A +$10k long SPX hedge should gain ~ 10k * (S1-S0)/S0 ≈ $100 on +1%."""
    K, right, q, r = 100.0, "C", 0.02, 0.05
    t0 = _make_snap(100.0, K, 0.25, r, q, 0.20, right)
    t1 = _make_snap(101.0, K, 0.25, r, q, 0.20, right)
    state = {"delta_hedge_notional": 10_000.0, "r": r}
    out = attribute(0, K, right, q, t0, t1, account_state=state)
    # Hedge MTM = 10000 * (101-100)/100 = 100, booked in hedge_pnl;
    # no time passed, so financing (interest-only) is zero.
    assert out["hedge_pnl"] == pytest.approx(100.0, abs=1e-9)
    assert out["financing_pnl"] == pytest.approx(0.0, abs=1e-9)


def test_financing_leg_carries_negatively():
    """Holding a hedge costs |notional|·r·Δt regardless of direction."""
    K, right, q, r = 100.0, "C", 0.02, 0.05
    t0 = _make_snap(100.0, K, 0.25, r, q, 0.20, right)
    t1 = _make_snap(100.0, K, 0.25 - 1/365, r, q, 0.20, right)  # spot flat, 1d passes
    state = {"delta_hedge_notional": -50_000.0, "r": 0.05}  # short hedge
    out = attribute(0, K, right, q, t0, t1, account_state=state)
    # hedge MTM = 0 (spot flat); carry = -0.05 * 50000 * (1/365) ≈ -6.85
    assert out["hedge_pnl"] == pytest.approx(0.0, abs=1e-9)
    assert out["financing_pnl"] == pytest.approx(
        -0.05 * 50_000.0 * (1.0 / 365.0), abs=1e-9
    )
