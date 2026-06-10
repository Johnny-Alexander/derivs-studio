"""
Provider registry + the primary/fallback orchestration used by the
snapshot job and CLI.
"""

from __future__ import annotations

import logging

from .base import ChainProvider, ChainSnapshot, OptionQuote
from .cboe import CboeProvider
from .yahoo import YahooProvider

logger = logging.getLogger(__name__)

__all__ = [
    "ChainProvider",
    "ChainSnapshot",
    "OptionQuote",
    "CboeProvider",
    "YahooProvider",
    "get_provider",
    "fetch_with_fallback",
]

_FALLBACK_ORDER = {"cboe": "yahoo", "yahoo": "cboe"}


def get_provider(name: str) -> ChainProvider:
    if name == "cboe":
        return CboeProvider()
    if name == "yahoo":
        return YahooProvider()
    raise ValueError(f"unknown data provider: {name!r}")


async def fetch_with_fallback(primary: str, symbol: str = "SPX") -> tuple[ChainSnapshot, str]:
    """
    Try the configured provider; on failure warn and try the other one; on
    double failure raise (callers skip the cycle — never write partials).
    Returns (snapshot, provider_name_that_succeeded).
    """
    try:
        return await get_provider(primary).get_snapshot(symbol), primary
    except Exception as exc:
        fallback = _FALLBACK_ORDER[primary]
        logger.warning("%s provider failed (%s); trying %s", primary, exc, fallback)
        try:
            return await get_provider(fallback).get_snapshot(symbol), fallback
        except Exception as exc2:
            logger.error("both providers failed: %s / %s", exc, exc2)
            raise RuntimeError(
                f"both providers failed: {primary}: {exc}; {fallback}: {exc2}"
            ) from exc2
