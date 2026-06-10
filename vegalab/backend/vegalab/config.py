"""
Runtime settings, loaded from the environment (and an optional .env file).

Phase 1 hardcoded r/q live here now so every layer reads the same numbers.
BACKLOG: pull SOFR daily instead of a hardcoded risk-free rate.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./vegalab.db"

    @field_validator("database_url")
    @classmethod
    def _force_psycopg3(cls, v: str) -> str:
        # Supabase/Heroku-style URLs say plain "postgresql://", which
        # SQLAlchemy resolves to psycopg2; we only ship psycopg 3.
        if v.startswith("postgresql://"):
            return v.replace("postgresql://", "postgresql+psycopg://", 1)
        if v.startswith("postgres://"):
            return v.replace("postgres://", "postgresql+psycopg://", 1)
        return v

    risk_free_rate: float = 0.0438
    dividend_yield: float = 0.015

    data_provider: Literal["cboe", "yahoo"] = "cboe"

    # Phase 3 (API) knobs.
    job_secret: str = "dev-job-secret"  # X-Job-Secret for POST /jobs/snapshot
    cors_origins: str = "http://localhost:3000"  # comma-separated
    stale_quote_minutes: int = 30  # reject fills when the latest snapshot is older

    # Overridable so tests / local demos can point the provider at a stub
    # server. Production never sets this.
    cboe_base_url: str = "https://cdn.cboe.com/api/global/delayed_quotes/options"


@lru_cache
def get_settings() -> Settings:
    return Settings()
