"""
Generate `_SPX_sample.json`, a schema-accurate sample of the CBOE delayed
quotes payload (~30 options), with Black-Scholes-consistent quotes plus a
handful of deliberately broken rows that exercise the data-quality rules.

See README.md in this directory for provenance: the dev environment's
network policy blocks cdn.cboe.com, so this stands in for a live capture
until one can be taken. Regenerate with:

    ../../../../.venv/bin/python _generate_sample.py
"""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

from vegalab.data.quality import year_fraction
from vegalab.quant.pricing import bs_price, greeks
from vegalab.symbols import format_occ

NOW = datetime(2026, 6, 10, 14, 45, 0, tzinfo=timezone.utc)
SPOT = 6010.25
R, Q = 0.0438, 0.015


def smile_iv(strike: float, expiry: date) -> float:
    base = 0.145 if (expiry - NOW.date()).days < 20 else 0.158
    return round(base - 0.55 * (strike - SPOT) / SPOT + 0.02 * ((strike - SPOT) / SPOT) ** 2 * 8, 4)


def row(root: str, expiry: date, right: str, strike: float, **overrides) -> dict:
    iv = smile_iv(strike, expiry)
    T = year_fraction(expiry, NOW)
    mid = bs_price(SPOT, strike, T, R, Q, iv, right)
    g = greeks(SPOT, strike, T, R, Q, iv, right)
    spread = max(0.10, round(0.014 * mid, 2))
    bid = round(max(mid - spread / 2, 0.05), 2)
    ask = round(mid + spread / 2, 2)
    out = {
        "option": format_occ(root, expiry, right, strike),
        "bid": bid,
        "bid_size": 25,
        "ask": ask,
        "ask_size": 30,
        "iv": iv,
        "open_interest": 1200,
        "volume": 350,
        "delta": round(g["delta"], 4),
        "gamma": round(g["gamma"], 6),
        "theta": round(g["theta"], 4),
        "rho": 0.0,
        "vega": round(g["vega"], 4),
        "last_trade_price": round(mid, 2),
        "last_trade_time": "2026-06-10T10:29:54",
        "tick": "up",
        "prev_day_close": round(mid * 0.97, 2),
    }
    out.update(overrides)
    return out


def main() -> None:
    weekly = date(2026, 6, 19)   # SPXW, 9 DTE
    monthly = date(2026, 7, 17)  # SPX, 37 DTE
    options: list[dict] = []

    for strike in [5750, 5850, 5950, 6000, 6050, 6150]:
        options.append(row("SPXW", weekly, "C", strike))
        options.append(row("SPXW", weekly, "P", strike))
    for strike in [5700, 5800, 5900, 6000, 6100, 6200]:
        options.append(row("SPX", monthly, "C", strike))
        options.append(row("SPX", monthly, "P", strike))

    # Broken/edge rows the quality layer must handle:
    # 1. missing IV -> Brent solver from mid
    options.append(row("SPX", monthly, "C", 6025, iv=0))
    # 2. zero bid, live ask -> synthetic bid + flag
    options.append(row("SPXW", weekly, "P", 5775, bid=0.0, bid_size=0))
    # 3. both sides zero -> drop
    options.append(row("SPXW", weekly, "C", 6175, bid=0.0, ask=0.0,
                       bid_size=0, ask_size=0))
    # 4. strike >15% from spot -> drop (delta also out of band)
    options.append(row("SPX", monthly, "C", 7200, iv=0.31, delta=0.0004))
    # 5. expiry > 120 DTE -> drop
    options.append(row("SPX", date(2026, 12, 18), "C", 6000))
    # 6. |delta| > 0.99 -> drop
    options.append(row("SPX", monthly, "C", 5150, delta=0.9942))

    payload = {
        "symbol": "_SPX",
        "timestamp": NOW.strftime("%Y-%m-%d %H:%M:%S"),
        "data": {
            "symbol": "_SPX",
            "security_type": "index",
            "current_price": SPOT,
            "price_change": 12.43,
            "price_change_percent": 0.21,
            "bid": 6009.97,
            "ask": 6010.53,
            "open": 5998.11,
            "high": 6014.88,
            "low": 5991.02,
            "close": SPOT,
            "prev_day_close": 5997.82,
            "volume": 0,
            "iv30": 14.9,
            "last_trade_time": "2026-06-10T10:30:00",
            "options": options,
        },
    }

    out_path = Path(__file__).with_name("_SPX_sample.json")
    out_path.write_text(json.dumps(payload, indent=1) + "\n")
    print(f"wrote {out_path} ({len(options)} options)")


if __name__ == "__main__":
    main()
