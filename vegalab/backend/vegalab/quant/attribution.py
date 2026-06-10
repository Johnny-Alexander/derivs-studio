"""
PnL attribution for a single position over an interval [t0, t1].

Greeks are evaluated at t0 (start of interval) — this gives the cleanest math.
The residual is whatever's left of actual ΔPnL after subtracting every bucket;
it should be small on calm days. A large residual means stale quotes, a sign
error, or that the snapshot interval is too long for the move that happened.
"""

from __future__ import annotations

from typing import Dict, Optional

from .pricing import greeks

MULTIPLIER_DEFAULT = 100


def attribute(
    position_qty: int,
    K: float,
    right: str,
    q: float,
    snap_t0: Dict[str, float],
    snap_t1: Dict[str, float],
    account_state: Optional[Dict[str, float]] = None,
    multiplier: int = MULTIPLIER_DEFAULT,
) -> Dict[str, float]:
    """
    Bucket the PnL change of a single position between two snapshots.

    Both snapshots must contain:
        S      : underlying spot
        sigma  : implied vol (decimal, 0.20 = 20 vol)
        T      : time to expiry in years
        price  : mid price of the option
        r      : (optional) risk-free rate; falls back to account_state['r'] or 0

    account_state (optional) supplies the financing leg:
        delta_hedge_notional : signed $ notional of synthetic SPX hedge
                               (+ long underlying, − short)
        cash_borrowed        : positive when account is borrowing
        r                    : rate used for carry

    Returns a dict of dollar PnL contributions:
        delta_pnl, gamma_pnl, vega_pnl, theta_pnl,
        vanna_pnl, charm_pnl, volga_pnl, hedge_pnl, financing_pnl,
        residual_pnl, total_pnl
    where hedge_pnl is the hedge leg's mark-to-market, financing_pnl is
    interest-only carry, and total_pnl == actual ΔPnL
    == qty * multiplier * (price_t1 − price_t0).
    """
    if account_state is None:
        account_state = {}

    S0 = snap_t0["S"]
    S1 = snap_t1["S"]
    sigma0 = snap_t0["sigma"]
    sigma1 = snap_t1["sigma"]
    T0 = snap_t0["T"]
    T1 = snap_t1["T"]
    p0 = snap_t0["price"]
    p1 = snap_t1["price"]

    dS = S1 - S0
    dsigma = sigma1 - sigma0
    dt = T0 - T1  # time elapsed in years (T decreases as the clock ticks)

    r = snap_t0.get("r", account_state.get("r", 0.0))
    g = greeks(S0, K, T0, r, q, sigma0, right)

    # Convert "display" Greeks back to raw before mixing with raw inputs.
    vega_raw = g["vega"] * 100.0       # per decimal of vol
    theta_year = g["theta"] * 365.0    # per year

    qm = position_qty * multiplier

    delta_pnl = qm * g["delta"] * dS
    gamma_pnl = qm * 0.5 * g["gamma"] * dS * dS
    vega_pnl = qm * vega_raw * dsigma
    theta_pnl = qm * theta_year * dt
    vanna_pnl = qm * g["vanna"] * dS * dsigma
    charm_pnl = qm * g["charm"] * dS * dt
    volga_pnl = qm * 0.5 * g["volga"] * dsigma * dsigma

    actual_pnl = qm * (p1 - p0)

    notional = account_state.get("delta_hedge_notional", 0.0)
    cash_borrowed = account_state.get("cash_borrowed", 0.0)
    carry_rate = account_state.get("r", r)
    hedge_pnl = notional * (S1 - S0) / S0 if S0 != 0 else 0.0
    hedge_carry = -carry_rate * abs(notional) * dt
    borrow_carry = -carry_rate * cash_borrowed * dt
    financing_pnl = hedge_carry + borrow_carry

    residual_pnl = actual_pnl - (
        delta_pnl + gamma_pnl + vega_pnl + theta_pnl
        + vanna_pnl + charm_pnl + volga_pnl + hedge_pnl + financing_pnl
    )

    return {
        "delta_pnl": delta_pnl,
        "gamma_pnl": gamma_pnl,
        "vega_pnl": vega_pnl,
        "theta_pnl": theta_pnl,
        "vanna_pnl": vanna_pnl,
        "charm_pnl": charm_pnl,
        "volga_pnl": volga_pnl,
        "hedge_pnl": hedge_pnl,
        "financing_pnl": financing_pnl,
        "residual_pnl": residual_pnl,
        "total_pnl": actual_pnl,
    }
