"""POST /jobs/snapshot — the cron entrypoint, guarded by X-Job-Secret."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ...services import snapshots
from ..deps import require_job_secret

router = APIRouter()


@router.post("/jobs/snapshot", dependencies=[Depends(require_job_secret)])
async def run_snapshot() -> dict:
    try:
        return await snapshots.run_snapshot_job()
    except Exception as exc:
        # Double provider failure (or DB trouble): cycle skipped, no partials.
        raise HTTPException(status_code=503, detail=f"snapshot cycle skipped: {exc}") from exc
