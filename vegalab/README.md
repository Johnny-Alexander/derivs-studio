# VEGALAB

SPX paper-trading league with full PnL attribution by Greek bucket.

See `../HANDOVER.md` (or the original handover doc) for product spec and roadmap.

## Phase 1 — pure quant core

This is what's implemented today. No API, no DB, no frontend yet.

- `backend/vegalab/quant/pricing.py` — Black-Scholes price + closed-form Greeks
  (delta, gamma, vega, theta, vanna, charm, volga) for European options on a
  dividend-paying underlying.
- `backend/vegalab/quant/iv_solver.py` — Brent fallback to back out IV from a
  mid price when ORATS doesn't supply one.
- `backend/vegalab/quant/attribution.py` — bucket the PnL change of a single
  position between two snapshots into delta / gamma / vega / theta /
  vanna / charm / volga / financing / residual.

### Conventions

- `T` is in years (`days / 365`, calendar days).
- `sigma` is a decimal (0.20 = 20 vol points).
- `right` is `'C'` or `'P'`.
- Theta returned per-day (closed-form expression divided by 365).
- Vega returned per vol-point (closed-form expression divided by 100).
- All other Greeks per the natural BS units.
- SPX multiplier (100x) is applied at attribution time, not in pricing.

## Running tests

```sh
cd backend
../.venv/bin/python -m pytest -v
```

## Roadmap

- **Phase 2**: Tradier client, Postgres schema, Alembic migrations.
- **Phase 3**: FastAPI REST, auth, snapshot cron, leaderboard endpoints.
- **Phase 4**: Next.js frontend (mockup in `spx_league_mockup.jsx`).
