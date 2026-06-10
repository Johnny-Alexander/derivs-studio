"""
FastAPI application factory.

CORS allows the configured origins (CORS_ORIGINS, comma-separated — the
Vercel origin in prod plus localhost for dev). /health is unauthenticated
and reports the last snapshot ts + the configured provider so the README's
"is the cron alive?" check works.

Run locally:

    uvicorn vegalab.api.app:app --reload
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select

from ..config import get_settings
from ..db import session_scope
from ..models import MarketSnapshot
from .routes import chain, jobs, leaderboard, pnl, positions, trades


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="vegalab", version="0.3.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(chain.router)
    app.include_router(trades.router)
    app.include_router(positions.router)
    app.include_router(pnl.router)
    app.include_router(leaderboard.router)
    app.include_router(jobs.router)

    @app.get("/health")
    def health() -> dict:
        with session_scope() as session:
            last_ts = session.scalar(select(func.max(MarketSnapshot.snapshot_ts)))
        return {
            "status": "ok",
            "last_snapshot_ts": last_ts,
            "provider": settings.data_provider,
        }

    return app


app = create_app()
