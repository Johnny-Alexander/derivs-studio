"""
OCC option-symbol handling: OCC string ↔ tuple ↔ pretty string.

OCC format (no padding spaces, as CBOE serves them):

    {root}{YYMMDD}{C|P}{strike*1000 as 8 digits}

e.g. ``SPX260620C05850000`` is the SPX 20-Jun-2026 5850 call, and weeklies
use the ``SPXW`` root (``SPXW260619P05900000``). The root is variable
length — parse it by locating the date/right/strike tail, don't assume
3 characters. Both SPX and SPXW roots are tradable in the game.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime

_OCC_RE = re.compile(r"^([A-Z]{1,6})(\d{6})([CP])(\d{8})$")
_PRETTY_RE = re.compile(r"^([A-Z]{1,6}) (\d{2}[A-Z]{3}\d{2}) (\d+(?:\.\d+)?)([CP])$")


@dataclass(frozen=True)
class OptionSymbol:
    root: str       # "SPX" or "SPXW" (others parse fine too)
    expiry: date
    right: str      # "C" | "P"
    strike: float

    @property
    def occ(self) -> str:
        return format_occ(self.root, self.expiry, self.right, self.strike)

    @property
    def pretty(self) -> str:
        strike = f"{self.strike:g}"
        return f"{self.root} {self.expiry.strftime('%d%b%y').upper()} {strike}{self.right}"


def parse_occ(symbol: str) -> OptionSymbol:
    m = _OCC_RE.match(symbol.strip().upper())
    if not m:
        raise ValueError(f"not an OCC option symbol: {symbol!r}")
    root, ymd, right, strike_str = m.groups()
    expiry = datetime.strptime(ymd, "%y%m%d").date()
    return OptionSymbol(root=root, expiry=expiry, right=right, strike=int(strike_str) / 1000.0)


def format_occ(root: str, expiry: date, right: str, strike: float) -> str:
    right = right.upper()
    if right not in ("C", "P"):
        raise ValueError(f"right must be 'C' or 'P', got {right!r}")
    strike_milli = round(strike * 1000)
    if not (0 < strike_milli < 10**8):
        raise ValueError(f"strike out of OCC range: {strike}")
    return f"{root.upper()}{expiry.strftime('%y%m%d')}{right}{strike_milli:08d}"


def parse_pretty(text: str) -> OptionSymbol:
    m = _PRETTY_RE.match(text.strip().upper())
    if not m:
        raise ValueError(f"not a pretty option symbol: {text!r}")
    root, dmy, strike_str, right = m.groups()
    expiry = datetime.strptime(dmy, "%d%b%y").date()
    return OptionSymbol(root=root, expiry=expiry, right=right, strike=float(strike_str))
