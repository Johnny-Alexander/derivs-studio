# BACKLOG

- Pull SOFR daily instead of hardcoded `r = 0.0438` (q = 0.015 likewise).
- Multi-leg orders: v1 submits legs sequentially from the frontend; no
  atomic strategy object (per handover, Phase 3 trading rules).
- Money columns are floats; fine for a paper game, revisit if anyone
  starts caring about cents.
