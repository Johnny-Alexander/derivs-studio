"""
Fetch the SPX chain via the configured provider (with fallback) and
pretty-print it. No DB involved — this is the eyeball-the-data tool.

    python -m vegalab.scripts.fetch_chain [--provider cboe|yahoo] [--limit N]
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from ..config import get_settings
from ..data.providers import fetch_with_fallback


async def _run(provider: str, limit: int) -> int:
    snap, used = await fetch_with_fallback(provider)

    n = len(snap.options)
    n_syn = sum(1 for o in snap.options if o.synthetic_quote)
    print(f"provider={used}  spot={snap.underlying_px:.2f}  "
          f"fetched_at={snap.fetched_at:%Y-%m-%d %H:%M:%S}Z")
    print(f"{n} filtered strikes, {n_syn} synthetic quotes "
          f"({100.0 * snap.synthetic_fraction:.1f}%)")
    print()
    hdr = (f"{'symbol':<22} {'expiry':<10} {'K':>7} {'R':>1} "
           f"{'bid':>9} {'ask':>9} {'mid':>9} {'iv':>7} {'delta':>7} "
           f"{'vol':>7} {'oi':>8} {'syn':>3}")
    print(hdr)
    print("-" * len(hdr))
    shown = snap.options if limit <= 0 else snap.options[:limit]
    for o in shown:
        print(f"{o.symbol:<22} {o.expiry.isoformat():<10} {o.strike:>7.0f} {o.right:>1} "
              f"{o.bid:>9.2f} {o.ask:>9.2f} {o.mid:>9.2f} {o.iv:>7.4f} {o.delta:>7.3f} "
              f"{o.volume:>7d} {o.open_interest:>8d} {'⚠' if o.synthetic_quote else '':>3}")
    if limit > 0 and n > limit:
        print(f"... ({n - limit} more)")
    return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(description="Fetch and pretty-print the SPX chain")
    parser.add_argument("--provider", choices=["cboe", "yahoo"],
                        default=get_settings().data_provider)
    parser.add_argument("--limit", type=int, default=40,
                        help="rows to print (<=0 for all)")
    args = parser.parse_args(argv)
    try:
        return asyncio.run(_run(args.provider, args.limit))
    except Exception as exc:
        print(f"fetch failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
