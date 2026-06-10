# BACKLOG

- Pull SOFR daily instead of hardcoded `r = 0.0438` (q = 0.015 likewise).
- Multi-leg orders: v1 submits legs sequentially from the frontend; no
  atomic strategy object (per handover, Phase 3 trading rules).
- Money columns are floats; fine for a paper game, revisit if anyone
  starts caring about cents.
- Trade-aware interval PnL: positions resized mid-interval are attributed
  at their current qty; the approximation error lands in residual. A
  cash-flow-aware interval PnL would shrink residuals on busy days.
- Account equity shown by `/me/positions` is cash + option marks; the
  synthetic delta hedge only affects PnL via the financing bucket, it is
  not part of equity.
- Feed-stuck detection (identical spot 3+ cycles during RTH → loud
  warning) — handover Phase 2R staleness rule, not yet wired into the
  snapshot job.
