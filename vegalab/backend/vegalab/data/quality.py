"""
Data-quality rules, applied by BOTH providers after parsing (handover
"Data-quality rules" section):

1. IV: provider IV missing / zero / < 0.005 → recompute from mid with the
   Brent solver. If mid is unusable too, drop the strike.
2. Bid/ask: bid == 0 and ask > 0 → synthesize
   bid = max(0.05, ask − max(0.30, 0.025 × mid_estimate)), flag
   synthetic_quote=True. Both zero → drop.
3. Universe filter: |delta| in [0.01, 0.99] (computed or provider),
   strike within ±15% of spot, expiry ≤ 120 DTE.
4. Staleness is handled at the snapshot job, not here.

Greeks the provider didn't supply are computed from the final IV with the
Phase 1 closed forms (theta per day, vega per vol-point).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, time, timezone

from ..config import get_settings
from ..quant.iv_solver import solve_iv
from ..quant.pricing import greeks
from ..symbols import OptionSymbol
from .types import OptionQuote

MIN_IV = 0.005
MIN_ABS_DELTA = 0.01
MAX_ABS_DELTA = 0.99
MAX_MONEYNESS = 0.15
MAX_DTE = 120

# SPX options settle around the 4pm ET close; 21:00 UTC is close enough for
# a year-fraction and avoids any tz dependency.
_EXPIRY_CUTOFF_UTC = time(21, 0)
_MIN_T_YEARS = 1.0 / (365.0 * 24.0)  # floor at 1h so 0DTE doesn't blow up the solver


@dataclass
class RawQuote:
    """Provider row before quality rules. None = source didn't supply it."""

    sym: OptionSymbol
    bid: float | None
    ask: float | None
    iv: float | None
    delta: float | None = None
    gamma: float | None = None
    theta: float | None = None
    vega: float | None = None
    volume: int = 0
    open_interest: int = 0
    last_trade_price: float | None = None


def year_fraction(expiry: date, now: datetime) -> float:
    cutoff = datetime.combine(expiry, _EXPIRY_CUTOFF_UTC, tzinfo=timezone.utc)
    return max((cutoff - now).total_seconds() / (365.0 * 86400.0), _MIN_T_YEARS)


def clean_quote(raw: RawQuote, spot: float, now: datetime) -> OptionQuote | None:
    """Apply the quality rules to one row. Returns None to drop the strike."""
    sym = raw.sym

    # Cheap universe cuts first: DTE and moneyness don't need quotes.
    dte = (sym.expiry - now.date()).days
    if dte < 0 or dte > MAX_DTE:
        return None
    if abs(sym.strike - spot) > MAX_MONEYNESS * spot:
        return None

    bid = raw.bid or 0.0
    ask = raw.ask or 0.0
    if bid < 0 or ask < 0:
        return None

    # Rule 2: bid/ask.
    synthetic = False
    if bid == 0.0 and ask == 0.0:
        return None
    if bid == 0.0 and ask > 0.0:
        mid_estimate = raw.last_trade_price if (raw.last_trade_price or 0) > 0 else ask
        synthetic_spread = max(0.30, 0.025 * mid_estimate)
        bid = max(0.05, ask - synthetic_spread)
        synthetic = True
    if ask == 0.0 and bid > 0.0:
        # Mirror case (rare, mostly Yahoo): same synthesis on the ask side.
        mid_estimate = raw.last_trade_price if (raw.last_trade_price or 0) > 0 else bid
        ask = bid + max(0.30, 0.025 * mid_estimate)
        synthetic = True
    if ask < bid:
        return None
    mid = (bid + ask) / 2.0

    settings = get_settings()
    r, q = settings.risk_free_rate, settings.dividend_yield
    T = year_fraction(sym.expiry, now)

    # Rule 1: IV.
    iv = raw.iv
    if iv is None or not math.isfinite(iv) or iv < MIN_IV:
        iv = solve_iv(mid, spot, sym.strike, T, r, q, sym.right)
        if iv is None or iv < MIN_IV:
            return None

    # Fill Greeks the provider didn't supply from the final IV.
    computed = None
    if raw.delta is None or raw.gamma is None or raw.theta is None or raw.vega is None:
        computed = greeks(spot, sym.strike, T, r, q, iv, sym.right)
    delta = raw.delta if raw.delta is not None else computed["delta"]
    gamma = raw.gamma if raw.gamma is not None else computed["gamma"]
    theta = raw.theta if raw.theta is not None else computed["theta"]
    vega = raw.vega if raw.vega is not None else computed["vega"]

    # Rule 3: delta band.
    if not (MIN_ABS_DELTA <= abs(delta) <= MAX_ABS_DELTA):
        return None

    return OptionQuote(
        symbol=sym.occ,
        root=sym.root,
        expiry=sym.expiry,
        right=sym.right,  # type: ignore[arg-type]
        strike=sym.strike,
        bid=round(bid, 4),
        ask=round(ask, 4),
        mid=round(mid, 4),
        iv=iv,
        delta=delta,
        gamma=gamma,
        theta=theta,
        vega=vega,
        volume=int(raw.volume or 0),
        open_interest=int(raw.open_interest or 0),
        synthetic_quote=synthetic,
    )


def clean_chain(raws: list[RawQuote], spot: float, now: datetime) -> list[OptionQuote]:
    out = []
    for raw in raws:
        q = clean_quote(raw, spot, now)
        if q is not None:
            out.append(q)
    return out
