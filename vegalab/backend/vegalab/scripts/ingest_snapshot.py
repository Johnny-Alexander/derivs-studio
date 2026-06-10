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

from ..config import get_settings
from ..data.providers import fetch_with_fallback
from ..services.snapshots import persist_snapshot  # noqa: F401  (re-exported; lives in services now)

logger = logging.getLogger(__name__)


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
