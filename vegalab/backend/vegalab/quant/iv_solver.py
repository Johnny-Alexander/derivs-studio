"""
Back-out IV from a mid price via Brent's method.

Used as a fallback when ORATS doesn't supply IV for an illiquid strike. The
bracket [0.01, 5.0] covers everything from deep-LEAP rates up to crisis vol.
"""

from __future__ import annotations

from typing import Optional

from scipy.optimize import brentq

from .pricing import bs_price


def solve_iv(
    price: float,
    S: float,
    K: float,
    T: float,
    r: float,
    q: float,
    right: str,
    lo: float = 0.01,
    hi: float = 5.0,
    xtol: float = 1e-8,
) -> Optional[float]:
    """
    Return the σ that prices the option at `price`, or None if no root
    in [lo, hi]. Also returns None for degenerate inputs (T<=0, price<0,
    or a price below intrinsic).
    """
    if T <= 0 or price < 0:
        return None

    # Sanity: price must lie within no-arb bounds.
    import math
    disc_r = math.exp(-r * T)
    disc_q = math.exp(-q * T)
    if right.upper() == "C":
        intrinsic = max(S * disc_q - K * disc_r, 0.0)
        upper = S * disc_q
    else:
        intrinsic = max(K * disc_r - S * disc_q, 0.0)
        upper = K * disc_r
    if price < intrinsic - 1e-12 or price > upper + 1e-12:
        return None

    def f(sigma: float) -> float:
        return bs_price(S, K, T, r, q, sigma, right) - price

    try:
        f_lo = f(lo)
        f_hi = f(hi)
    except (ValueError, ZeroDivisionError):
        return None

    if f_lo * f_hi > 0:
        return None

    try:
        return brentq(f, lo, hi, xtol=xtol, maxiter=100)
    except (ValueError, RuntimeError):
        return None
