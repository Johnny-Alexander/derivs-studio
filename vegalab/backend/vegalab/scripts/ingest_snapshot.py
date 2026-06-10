"""
Fetch one chain snapshot and persist it: upsert instruments, insert
market_snapshots rows.

Idempotency: snapshot_ts is fetched_at truncated to the minute, and
(instrument_id, snapshot_ts) is unique — running twice in the same minute
writes once. On provider double-failure the cycle is skipped entirely
(no partial snapshots).

    python -m vegalab.scripts.ingest_snapshot
"""

from __future__ import annotations

import asyncio
import logging
import sys

from sqlalchemy import select

from ..config import get_settings
from ..data.providers import ChainSnapshot, fetch_with_fallback
from ..db import session_scope
from ..models import Instrument, MarketSnapshot

logger = logging.getLogger(__name__)


def persist_snapshot(snap: ChainSnapshot) -> int:
    """Write one snapshot; returns the number of new market_snapshots rows."""
    snapshot_ts = snap.fetched_at.replace(second=0, microsecond=0)

    with session_scope() as session:
        symbols = [o.symbol for o in snap.options]
        existing = {
            i.symbol: i
            for i in session.scalars(select(Instrument).where(Instrument.symbol.in_(symbols)))
        }
        for o in snap.options:
            if o.symbol not in existing:
                inst = Instrument(
                    symbol=o.symbol, root=o.root, expiry=o.expiry,
                    strike=o.strike, right=o.right,
                )
                session.add(inst)
                existing[o.symbol] = inst
        session.flush()

        inst_ids = [existing[s].id for s in symbols]
        already = set(
            session.scalars(
                select(MarketSnapshot.instrument_id).where(
                    MarketSnapshot.snapshot_ts == snapshot_ts,
                    MarketSnapshot.instrument_id.in_(inst_ids),
                )
            )
        )

        written = 0
        for o in snap.options:
            inst_id = existing[o.symbol].id
            if inst_id in already:
                continue
            session.add(
                MarketSnapshot(
                    instrument_id=inst_id,
                    snapshot_ts=snapshot_ts,
                    bid=o.bid, ask=o.ask, mid=o.mid, iv=o.iv,
                    delta=o.delta, gamma=o.gamma, theta=o.theta, vega=o.vega,
                    volume=o.volume, open_interest=o.open_interest,
                    underlying_px=snap.underlying_px,
                    synthetic_quote=o.synthetic_quote,
                    fetched_at=snap.fetched_at,
                )
            )
            written += 1
    return written


async def _run() -> int:
    settings = get_settings()
    try:
        snap, used = await fetch_with_fallback(settings.data_provider)
    except Exception as exc:
        logger.error("snapshot cycle skipped: %s", exc)
        return 1
    written = persist_snapshot(snap)
    print(f"provider={used} options={len(snap.options)} new_rows={written} "
          f"ts={snap.fetched_at.replace(second=0, microsecond=0):%Y-%m-%d %H:%M}Z")
    return 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    try:
        return asyncio.run(_run())
    except Exception as exc:
        print(f"ingest failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
