"""
Primary chain source: CBOE delayed quotes JSON.

    GET https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json

Free, no key, 15-min delayed. One request returns the entire chain (all
expiries) plus ``data.current_price`` for spot. CBOE blocks the default
python User-Agent, so we always send a browser-ish one.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Callable

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from ...config import get_settings
from ...symbols import parse_occ
from ..quality import RawQuote, clean_chain
from .base import ChainSnapshot

logger = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)


def _opt_float(row: dict, key: str) -> float | None:
    v = row.get(key)
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


class CboeProvider:
    name = "cboe"

    def __init__(
        self,
        base_url: str | None = None,
        timeout: float = 60.0,
        now_fn: Callable[[], datetime] | None = None,
    ):
        self._base_url = (base_url or get_settings().cboe_base_url).rstrip("/")
        self._timeout = timeout
        self._now_fn = now_fn or (lambda: datetime.now(timezone.utc))

    @retry(
        retry=retry_if_exception_type((httpx.TransportError, httpx.HTTPStatusError)),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, max=10),
        reraise=True,
    )
    async def _fetch(self, symbol: str) -> dict:
        url = f"{self._base_url}/_{symbol}.json"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.get(url, headers={"User-Agent": USER_AGENT})
            resp.raise_for_status()
            return resp.json()

    async def get_snapshot(self, symbol: str = "SPX") -> ChainSnapshot:
        payload = await self._fetch(symbol)
        data = payload["data"]
        spot = float(data["current_price"])
        fetched_at = self._now_fn()

        raws: list[RawQuote] = []
        skipped = 0
        for row in data.get("options", []):
            occ = row.get("option")
            if not occ:
                skipped += 1
                continue
            try:
                sym = parse_occ(occ)
            except ValueError:
                skipped += 1
                continue
            raws.append(
                RawQuote(
                    sym=sym,
                    bid=_opt_float(row, "bid"),
                    ask=_opt_float(row, "ask"),
                    iv=_opt_float(row, "iv"),
                    delta=_opt_float(row, "delta"),
                    gamma=_opt_float(row, "gamma"),
                    theta=_opt_float(row, "theta"),
                    vega=_opt_float(row, "vega"),
                    volume=int(row.get("volume") or 0),
                    open_interest=int(row.get("open_interest") or 0),
                    last_trade_price=_opt_float(row, "last_trade_price"),
                )
            )
        if skipped:
            logger.warning("cboe: skipped %d unparseable option rows", skipped)

        options = clean_chain(raws, spot, fetched_at)
        logger.info(
            "cboe: %d/%d options survived quality filters (spot %.2f)",
            len(options), len(raws), spot,
        )
        return ChainSnapshot(underlying_px=spot, fetched_at=fetched_at, options=options)
