"""
Leaderboard metrics over pnl_attribution (handover "Leaderboards"):

- pnl: season-to-date SUM(total_pnl) per account.
- sharpe: daily PnL series (buckets summed per UTC day) → mean/std × √252;
  null unless ≥ 5 trading days (and a nonzero std).
- attribution: per day, 1 − |residual_day| / max(|total_day|, 100), averaged
  over the season; days with |total_day| < $100 are excluded as noise; null
  when no day qualifies.

Accounts are per-season, so filtering to accounts in active seasons IS the
season-to-date filter. Aggregation is done in Python — three players at one
row per 5 minutes is tiny.
"""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, timezone
from statistics import mean, stdev

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Account, PnlAttribution, Season, User

MIN_SHARPE_DAYS = 5
NOISE_FLOOR = 100.0  # dollars

METRICS = ("pnl", "sharpe", "attribution")


def _daily(rows: list[PnlAttribution]) -> dict[date, dict[str, float]]:
    days: dict[date, dict[str, float]] = defaultdict(lambda: {"total": 0.0, "residual": 0.0})
    for row in rows:
        ts = row.snapshot_ts if row.snapshot_ts.tzinfo else row.snapshot_ts.replace(tzinfo=timezone.utc)
        d = ts.astimezone(timezone.utc).date()
        days[d]["total"] += row.total_pnl
        days[d]["residual"] += row.residual_pnl
    return days


def _sharpe(days: dict[date, dict[str, float]]) -> float | None:
    series = [v["total"] for _, v in sorted(days.items())]
    if len(series) < MIN_SHARPE_DAYS:
        return None
    sd = stdev(series)
    if sd == 0 or not math.isfinite(sd):
        return None
    return mean(series) / sd * math.sqrt(252.0)


def _attribution_accuracy(days: dict[date, dict[str, float]]) -> float | None:
    scores = [
        1.0 - abs(v["residual"]) / max(abs(v["total"]), NOISE_FLOOR)
        for v in days.values()
        if abs(v["total"]) >= NOISE_FLOOR
    ]
    return mean(scores) if scores else None


def compute_leaderboard(session: Session, metric: str) -> list[dict]:
    """Standings for one metric, best first; null metrics sort last."""
    if metric not in METRICS:
        raise ValueError(f"metric must be one of {METRICS}, got {metric!r}")

    accounts = session.execute(
        select(Account, User.name)
        .join(User, Account.user_id == User.id)
        .join(Season, Account.season_id == Season.id)
        .where(Season.is_active)
    ).all()

    standings = []
    for account, user_name in accounts:
        rows = session.scalars(
            select(PnlAttribution).where(PnlAttribution.account_id == account.id)
        ).all()
        days = _daily(rows)
        total_pnl = sum(r.total_pnl for r in rows)

        if metric == "pnl":
            value = total_pnl if rows else 0.0
        elif metric == "sharpe":
            value = _sharpe(days)
        else:
            value = _attribution_accuracy(days)

        standings.append(
            {
                "account_id": account.id,
                "user": user_name,
                "metric": metric,
                "value": value,
                "season_pnl": total_pnl,
                "trading_days": len(days),
            }
        )

    standings.sort(key=lambda s: (s["value"] is None, -(s["value"] or 0.0)))
    for rank, s in enumerate(standings, start=1):
        s["rank"] = rank
    return standings
