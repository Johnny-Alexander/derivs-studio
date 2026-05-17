"""
Black-Scholes price and closed-form Greeks for European options on a
dividend-paying underlying.

Unit conventions (read carefully — attribution.py depends on these):

    delta : dimensionless (∂Price/∂S)
    gamma : 1/dollar      (∂²Price/∂S²)
    vega  : dollars per *vol-point* — closed-form ∂Price/∂σ divided by 100.
            So if σ moves by 1 vol-point (0.01 in decimal), price ≈ vega.
    theta : dollars per *calendar day* — closed-form ∂Price/∂t divided by 365.
            Long options have negative theta.
    vanna : ∂Δ/∂σ in raw units (per decimal of vol). Same for call/put.
    charm : ∂Δ/∂t per year (raw). Differs between call and put.
    volga : ∂²Price/∂σ² in raw units (per decimal² of vol). Same for call/put.

T must be in years (calendar-day count is fine for SPX), sigma in decimal,
right is 'C' or 'P' (case-insensitive).
"""

from __future__ import annotations

import math
from typing import Dict

from scipy.stats import norm


def _d1_d2(S: float, K: float, T: float, r: float, q: float, sigma: float):
    sqrtT = math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
    d2 = d1 - sigma * sqrtT
    return d1, d2, sqrtT


def bs_price(
    S: float, K: float, T: float, r: float, q: float, sigma: float, right: str
) -> float:
    if T <= 0:
        raise ValueError("T must be positive")
    if sigma <= 0:
        raise ValueError("sigma must be positive")
    r_letter = right.upper()
    d1, d2, _ = _d1_d2(S, K, T, r, q, sigma)
    disc_r = math.exp(-r * T)
    disc_q = math.exp(-q * T)
    if r_letter == "C":
        return S * disc_q * norm.cdf(d1) - K * disc_r * norm.cdf(d2)
    if r_letter == "P":
        return K * disc_r * norm.cdf(-d2) - S * disc_q * norm.cdf(-d1)
    raise ValueError(f"right must be 'C' or 'P', got {right!r}")


def greeks(
    S: float, K: float, T: float, r: float, q: float, sigma: float, right: str
) -> Dict[str, float]:
    if T <= 0:
        raise ValueError("T must be positive")
    if sigma <= 0:
        raise ValueError("sigma must be positive")
    r_letter = right.upper()
    if r_letter not in ("C", "P"):
        raise ValueError(f"right must be 'C' or 'P', got {right!r}")

    d1, d2, sqrtT = _d1_d2(S, K, T, r, q, sigma)
    disc_r = math.exp(-r * T)
    disc_q = math.exp(-q * T)
    pdf_d1 = norm.pdf(d1)
    cdf_d1 = norm.cdf(d1)
    cdf_d2 = norm.cdf(d2)
    cdf_md1 = 1.0 - cdf_d1
    cdf_md2 = 1.0 - cdf_d2

    if r_letter == "C":
        delta = disc_q * cdf_d1
    else:
        delta = -disc_q * cdf_md1

    gamma = disc_q * pdf_d1 / (S * sigma * sqrtT)

    vega_raw = S * disc_q * pdf_d1 * sqrtT      # per decimal of vol
    vega = vega_raw / 100.0                     # per vol-point

    common_theta = -S * pdf_d1 * sigma * disc_q / (2.0 * sqrtT)
    if r_letter == "C":
        theta_year = common_theta - r * K * disc_r * cdf_d2 + q * S * disc_q * cdf_d1
    else:
        theta_year = common_theta + r * K * disc_r * cdf_md2 - q * S * disc_q * cdf_md1
    theta = theta_year / 365.0                  # per calendar day

    # Vanna and volga: identical for call and put.
    vanna = -disc_q * pdf_d1 * d2 / sigma
    volga = vega_raw * d1 * d2 / sigma

    # Charm differs between call and put (the q·N(±d1) term has opposite signs).
    bracket = (2.0 * (r - q) * T - d2 * sigma * sqrtT) / (2.0 * T * sigma * sqrtT)
    if r_letter == "C":
        charm = q * disc_q * cdf_d1 - disc_q * pdf_d1 * bracket
    else:
        charm = -q * disc_q * cdf_md1 - disc_q * pdf_d1 * bracket

    return {
        "delta": delta,
        "gamma": gamma,
        "vega": vega,
        "theta": theta,
        "vanna": vanna,
        "charm": charm,
        "volga": volga,
    }
