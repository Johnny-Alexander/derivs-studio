"""GET /me/pnl?granularity=snapshot|daily — attribution rows for the account."""

from __future__ import annotations

from collections import defaultdict
from datetime import timezone
from typing import Literal

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import Account, PnlAttribution
from ...services.snapshots import BUCKETS
from ..deps import get_current_account, get_db

router = APIRouter()


def _row_dict(row: PnlAttribution) -> dict:
    return {bucket: getattr(row, bucket) for bucket in BUCKETS}


@router.get("/me/pnl")
def my_pnl(
    granularity: Literal["snapshot", "daily"] = "snapshot",
    db: Session = Depends(get_db),
    account: Account = Depends(get_current_account),
) -> dict:
    rows = db.scalars(
        select(PnlAttribution)
        .where(PnlAttribution.account_id == account.id)
        .order_by(PnlAttribution.snapshot_ts)
    ).all()

    if granularity == "snapshot":
        series = [{"snapshot_ts": r.snapshot_ts, **_row_dict(r)} for r in rows]
    else:
        daily: dict = defaultdict(lambda: dict.fromkeys(BUCKETS, 0.0))
        for r in rows:
            ts = r.snapshot_ts if r.snapshot_ts.tzinfo else r.snapshot_ts.replace(tzinfo=timezone.utc)
            day = ts.astimezone(timezone.utc).date()
            for bucket in BUCKETS:
                daily[day][bucket] += getattr(r, bucket)
        series = [{"date": day, **buckets} for day, buckets in sorted(daily.items())]

    totals = dict.fromkeys(BUCKETS, 0.0)
    for r in rows:
        for bucket in BUCKETS:
            totals[bucket] += getattr(r, bucket)

    return {"granularity": granularity, "series": series, "season_totals": totals}
