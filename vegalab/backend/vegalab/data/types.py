"""
Provider abstraction: every chain source yields the same ChainSnapshot.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Literal, Protocol

from pydantic import BaseModel


class OptionQuote(BaseModel):
    """One cleaned option row, post data-quality rules."""

    symbol: str            # OCC, e.g. SPX260620C05850000
    root: str              # SPX | SPXW
    expiry: date
    right: Literal["C", "P"]
    strike: float
    bid: float
    ask: float
    mid: float
    iv: float              # decimal (0.20 = 20 vol points)
    delta: float
    gamma: float
    theta: float           # per calendar day
    vega: float            # per vol-point
    volume: int = 0
    open_interest: int = 0
    synthetic_quote: bool = False


@dataclass
class ChainSnapshot:
    underlying_px: float
    fetched_at: datetime
    options: list[OptionQuote] = field(default_factory=list)

    @property
    def synthetic_fraction(self) -> float:
        if not self.options:
            return 0.0
        return sum(1 for o in self.options if o.synthetic_quote) / len(self.options)


class ChainProvider(Protocol):
    name: str

    async def get_snapshot(self, symbol: str = "SPX") -> ChainSnapshot: ...
