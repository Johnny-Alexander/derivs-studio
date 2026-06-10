# BACKLOG

- Pull SOFR daily instead of hardcoded `r = 0.0438` (q = 0.015 likewise).
- Replace `tests/fixtures/cboe/_SPX_sample.json` with a real live capture
  (blocked in the dev sandbox — `cdn.cboe.com` not on the network
  allowlist; see `backend/tests/fixtures/cboe/README.md`).
- Multi-leg orders: v1 submits legs sequentially from the frontend; no
  atomic strategy object (per handover, Phase 3 trading rules).
- Money columns are floats; fine for a paper game, revisit if anyone
  starts caring about cents.
