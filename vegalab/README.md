# VEGALAB

SPX paper-trading league with full PnL attribution by Greek bucket.

See `../HANDOVER_FINISH.md` for the product spec and roadmap (Phases 2R → 5).

## Phase 1 — pure quant core

- `backend/vegalab/quant/pricing.py` — Black-Scholes price + closed-form Greeks
  (delta, gamma, vega, theta, vanna, charm, volga) for European options on a
  dividend-paying underlying.
- `backend/vegalab/quant/iv_solver.py` — Brent fallback to back out IV from a
  mid price when the feed doesn't supply one.
- `backend/vegalab/quant/attribution.py` — bucket the PnL change of a single
  position between two snapshots into delta / gamma / vega / theta /
  vanna / charm / volga / financing / residual.

## Phase 2R — data layer (CBOE primary, Yahoo fallback)

- `backend/vegalab/config.py` — settings (`DATABASE_URL`, `DATA_PROVIDER`,
  r/q). `DATA_PROVIDER=cboe|yahoo`, default `cboe`.
- `backend/vegalab/symbols.py` — OCC ↔ tuple ↔ pretty symbol handling;
  variable-length roots, so both `SPX` and `SPXW` (weeklies) parse and trade.
- `backend/vegalab/models.py` + `backend/alembic/` — the 8-table schema
  (users, seasons, accounts, instruments, market_snapshots, trades,
  positions, pnl_attribution) and migration `001_initial`.
- `backend/vegalab/data/` — provider abstraction:
  - `providers/cboe.py` — one GET of
    `https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json`
    (browser User-Agent required; CBOE blocks the default python UA) returns
    the whole chain + spot, 15-min delayed.
  - `providers/yahoo.py` — yfinance fallback, one call per expiry.
  - `quality.py` — shared data-quality rules applied after parsing by BOTH
    providers: bad/missing IV recomputed from mid via Brent (else drop);
    one-sided quotes synthesized (`bid = max(0.05, ask − max(0.30,
    0.025·mid_estimate))`) and flagged `synthetic_quote=True`; both-sides-zero
    dropped; universe filtered to |delta| ∈ [0.01, 0.99], strikes within ±15%
    of spot, ≤ 120 DTE.
  - The snapshot job tries the configured provider, falls back to the other
    on failure, and skips the cycle entirely on double failure — partial
    snapshots are never written.

### ⚠ Fill quality (read this before disputing a fill)

With Tradier we trusted bid/ask. CBOE delayed quotes are still decent; on
the Yahoo fallback, fills may execute against **synthesized** quotes (Yahoo
frequently serves 0.0 bids outside RTH and on illiquid strikes). Every
snapshot row carries `synthetic_quote`, and every trade stores
`fill_quality: 'real' | 'synthetic'`, so the league can argue about disputed
fills with the receipts in hand. This is a paper-trading game; perfect is
not required, honest labeling is.

### CLI

```sh
cd vegalab
# one-time setup
python3.11 -m venv .venv && .venv/bin/pip install -e '.[dev]'
cd backend
alembic upgrade head                          # uses DATABASE_URL (default: sqlite)

python -m vegalab.scripts.fetch_chain         # pretty-print the chain, no DB
python -m vegalab.scripts.seed                # season + 3 users + accounts (idempotent)
python -m vegalab.scripts.ingest_snapshot     # fetch + persist one snapshot (idempotent
                                              # per minute: re-runs in the same minute no-op)
```

### Conventions

- `T` in years (calendar days / 365); expiries marked at 21:00 UTC ≈ 4pm ET.
- `sigma` decimal (0.20 = 20 vol points); theta per calendar day; vega per
  vol-point; charm per year.
- SPX multiplier (100×) applied at attribution/trading time, never pricing.
- r = 0.0438, q = 0.015 hardcoded (see BACKLOG).
- All DB timestamps UTC; ET only at display/cron-guard edges.

## Running tests

```sh
cd vegalab
.venv/bin/python -m pytest -v
```

`tests/fixtures/cboe/_SPX_sample.json` is schema-accurate but generated, not
a live capture — see `backend/tests/fixtures/cboe/README.md` for why and how
to replace it with a real one.

## Roadmap

- **Phase 3**: FastAPI REST, auth, snapshot engine, leaderboard endpoints.
- **Phase 4**: Next.js frontend (mockup in `spx_league_mockup.jsx`).
- **Phase 5**: deploy — Supabase + Fly.io + Vercel + GitHub Actions cron.
