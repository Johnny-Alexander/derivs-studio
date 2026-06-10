"""
Runtime settings, loaded from the environment (and an optional .env file).

Phase 1 hardcoded r/q live here now so every layer reads the same numbers.
BACKLOG: pull SOFR daily instead of a hardcoded risk-free rate.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./vegalab.db"

    risk_free_rate: float = 0.0438
    dividend_yield: float = 0.015

    data_provider: Literal["cboe", "yahoo"] = "cboe"

    # Overridable so tests / local demos can point the provider at a stub
    # server. Production never sets this.
    cboe_base_url: str = "https://cdn.cboe.com/api/global/delayed_quotes/options"


@lru_cache
def get_settings() -> Settings:
    return Settings()
