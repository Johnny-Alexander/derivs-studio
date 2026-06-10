"""
Fallback chain source: Yahoo Finance via yfinance.

Known problems (all handled by the shared quality layer):
- bid/ask frequently 0.0 or stale outside RTH / on illiquid strikes
  → bid synthesis or drop
- impliedVolatility is unreliable (placeholder ~1e-5) → Brent solver from mid
- one HTTP call per expiry → we only fetch expiries ≤ 120 DTE and tolerate
  individual expiries failing

yfinance is synchronous; calls run in a worker thread.
"""

from __future__ import annotations

import asyncio
import logging
import math
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from ...symbols import OptionSymbol, parse_occ
from ..quality import MAX_DTE, RawQuote, clean_chain
from .base import ChainSnapshot

logger = logging.getLogger(__name__)


def _default_ticker_factory(symbol: str) -> Any:
    import yfinance as yf

    return yf.Ticker(symbol)


def _opt_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


class YahooProvider:
    name = "yahoo"

    def __init__(
        self,
        ticker_factory: Callable[[str], Any] = _default_ticker_factory,
        now_fn: Callable[[], datetime] | None = None,
    ):
        self._ticker_factory = ticker_factory
        self._now_fn = now_fn or (lambda: datetime.now(timezone.utc))

    def _rows_from_frame(self, frame: Any, right: str, expiry_str: str) -> list[RawQuote]:
        expiry = datetime.strptime(expiry_str, "%Y-%m-%d").date()
        raws: list[RawQuote] = []
        for rec in frame.to_dict("records"):
            sym: OptionSymbol | None = None
            contract = rec.get("contractSymbol")
            if contract:
                try:
                    sym = parse_occ(str(contract))
                except ValueError:
                    sym = None
            if sym is None:
                strike = _opt_float(rec.get("strike"))
                if strike is None:
                    continue
                sym = OptionSymbol(root="SPX", expiry=expiry, right=right, strike=strike)
            raws.append(
                RawQuote(
                    sym=sym,
                    bid=_opt_float(rec.get("bid")),
                    ask=_opt_float(rec.get("ask")),
                    iv=_opt_float(rec.get("impliedVolatility")),
                    volume=int(_opt_float(rec.get("volume")) or 0),
                    open_interest=int(_opt_float(rec.get("openInterest")) or 0),
                    last_trade_price=_opt_float(rec.get("lastPrice")),
                )
            )
        return raws

    def _fetch_sync(self, symbol: str) -> ChainSnapshot:
        ticker = self._ticker_factory(f"^{symbol}")
        fetched_at = self._now_fn()

        spot = float(ticker.history(period="1d")["Close"].iloc[-1])

        horizon = (fetched_at + timedelta(days=MAX_DTE)).date()
        raws: list[RawQuote] = []
        for expiry_str in ticker.options:
            expiry = datetime.strptime(expiry_str, "%Y-%m-%d").date()
            if expiry > horizon or expiry < fetched_at.date():
                continue
            try:
                chain = ticker.option_chain(expiry_str)
            except Exception:
                logger.warning("yahoo: failed to fetch expiry %s, skipping", expiry_str)
                continue
            raws.extend(self._rows_from_frame(chain.calls, "C", expiry_str))
            raws.extend(self._rows_from_frame(chain.puts, "P", expiry_str))

        options = clean_chain(raws, spot, fetched_at)
        logger.info(
            "yahoo: %d/%d options survived quality filters (spot %.2f)",
            len(options), len(raws), spot,
        )
        return ChainSnapshot(underlying_px=spot, fetched_at=fetched_at, options=options)

    async def get_snapshot(self, symbol: str = "SPX") -> ChainSnapshot:
        return await asyncio.to_thread(self._fetch_sync, symbol)
