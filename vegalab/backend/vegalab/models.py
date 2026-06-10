"""
SQLAlchemy 2.x ORM models — the 8-table schema.

Conventions:
- All timestamps are UTC (timezone-aware columns); ET appears only at
  display/cron-guard edges.
- No generated columns.
- ``market_snapshots.synthetic_quote`` flags rows whose bid was synthesized
  by the data-quality layer; ``trades.fill_quality`` ('real' | 'synthetic')
  records whether a fill executed against such a quote.
- Money/Greeks are floats: this is a paper-trading game marked off delayed
  quotes, not an accounting system.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy import false as sql_false
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    api_token: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )

    accounts: Mapped[list["Account"]] = relationship(back_populates="user")


class Season(Base):
    __tablename__ = "seasons"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    starts_on: Mapped[date] = mapped_column(Date, nullable=False)
    ends_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    accounts: Mapped[list["Account"]] = relationship(back_populates="season")


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = (UniqueConstraint("user_id", "season_id", name="uq_accounts_user_season"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    season_id: Mapped[int] = mapped_column(ForeignKey("seasons.id"), nullable=False)
    starting_capital: Mapped[float] = mapped_column(Float, nullable=False, default=100_000.0)
    cash: Mapped[float] = mapped_column(Float, nullable=False, default=100_000.0)
    delta_hedge_notional: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )

    user: Mapped["User"] = relationship(back_populates="accounts")
    season: Mapped["Season"] = relationship(back_populates="accounts")


class Instrument(Base):
    __tablename__ = "instruments"
    __table_args__ = (Index("ix_instruments_expiry_strike", "expiry", "strike"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)  # OCC
    root: Mapped[str] = mapped_column(String(8), nullable=False)  # SPX | SPXW
    expiry: Mapped[date] = mapped_column(Date, nullable=False)
    strike: Mapped[float] = mapped_column(Float, nullable=False)
    right: Mapped[str] = mapped_column(String(1), nullable=False)  # C | P


class MarketSnapshot(Base):
    __tablename__ = "market_snapshots"
    __table_args__ = (
        UniqueConstraint("instrument_id", "snapshot_ts", name="uq_snapshots_instrument_ts"),
        Index("ix_market_snapshots_ts", "snapshot_ts"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), nullable=False)
    snapshot_ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    bid: Mapped[float] = mapped_column(Float, nullable=False)
    ask: Mapped[float] = mapped_column(Float, nullable=False)
    mid: Mapped[float] = mapped_column(Float, nullable=False)
    iv: Mapped[float] = mapped_column(Float, nullable=False)
    delta: Mapped[float] = mapped_column(Float, nullable=False)
    gamma: Mapped[float] = mapped_column(Float, nullable=False)
    theta: Mapped[float] = mapped_column(Float, nullable=False)  # per calendar day
    vega: Mapped[float] = mapped_column(Float, nullable=False)   # per vol-point
    volume: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    open_interest: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    underlying_px: Mapped[float] = mapped_column(Float, nullable=False)
    synthetic_quote: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=sql_false()
    )
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Trade(Base):
    __tablename__ = "trades"
    __table_args__ = (Index("ix_trades_account_traded_at", "account_id", "traded_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), nullable=False)
    side: Mapped[str] = mapped_column(String(4), nullable=False)  # buy | sell
    qty: Mapped[int] = mapped_column(Integer, nullable=False)
    fill_px: Mapped[float] = mapped_column(Float, nullable=False)
    fill_quality: Mapped[str] = mapped_column(
        String(9), nullable=False, default="real", server_default="real"
    )
    traded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class Position(Base):
    __tablename__ = "positions"
    __table_args__ = (
        UniqueConstraint("account_id", "instrument_id", name="uq_positions_account_instrument"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), nullable=False)
    qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # signed contracts
    avg_cost: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    realized_pnl: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    opened_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )


class PnlAttribution(Base):
    __tablename__ = "pnl_attribution"
    __table_args__ = (
        UniqueConstraint("account_id", "snapshot_ts", name="uq_attribution_account_ts"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    snapshot_ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    delta_pnl: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    gamma_pnl: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    vega_pnl: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    theta_pnl: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    vanna_pnl: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    charm_pnl: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    volga_pnl: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    # Hedge leg mark-to-market; financing_pnl is interest-only carry.
    hedge_pnl: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0, server_default="0"
    )
    financing_pnl: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    residual_pnl: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    total_pnl: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
