# VEGALAB — Finish-It Handover (Phases 2R → 5)

**Context:** Phase 1 (quant core) is done and signed off — 85/85 tests, on `main` at `c0ec47f`. Tradier is no longer available to us. This doc replaces the Phase 2 handover’s Tradier sections and carries the project all the way to a deployed, testable site.

**End state:** a live URL where 3 users can log in (bearer token), trade SPX options at bid/ask, see live Greeks, flatten delta, and view PnL attribution + three leaderboards. Free hosting throughout.

Work through the phases IN ORDER. Each has verification gates. Stop and report at the end of each phase.

-----

## DATA LAYER CHANGE (read first)

### New primary source: CBOE delayed quotes JSON

```
GET https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json
Headers: User-Agent: Mozilla/5.0 (required — blocks default python UA)
```

- Free, no API key, 15-min delayed
- Returns the ENTIRE chain (all expiries) in one call, plus `data.current_price` for spot
- Each option row includes: option symbol (OCC-ish format), bid, ask, iv, delta, gamma, theta, vega, volume, open_interest, last_trade_price
- One request per snapshot = trivially inside any rate limit. Cache it for the whole snapshot cycle.

### Fallback source: yfinance

```python
import yfinance as yf
t = yf.Ticker("^SPX")
expiries = t.options                  # list of date strings
chain = t.option_chain(expiries[i])   # .calls / .puts DataFrames
spot = t.history(period="1d")["Close"].iloc[-1]
```

Known problems with Yahoo SPX options (handle all of these):

- bid/ask frequently 0.0 or stale, especially outside RTH and on illiquid strikes
- impliedVolatility column is unreliable (sometimes placeholder ~1e-5)
- one HTTP call per expiry → slower, more failure surface

### Provider abstraction

```python
# backend/vegalab/data/providers/base.py
class ChainProvider(Protocol):
    async def get_snapshot(self, symbol: str = "SPX") -> ChainSnapshot: ...

@dataclass
class ChainSnapshot:
    underlying_px: float
    fetched_at: datetime
    options: list[OptionQuote]   # same pydantic model as before

# providers/cboe.py    -> CboeProvider (primary)
# providers/yahoo.py   -> YahooProvider (fallback)
# providers/__init__.py -> get_provider(settings.data_provider)
```

`settings.data_provider: Literal["cboe", "yahoo"] = "cboe"`. The snapshot job tries primary; on failure, logs a warning and tries fallback; on double failure, skips the cycle (do NOT write partial snapshots).

### Data-quality rules (apply in BOTH providers, after parsing)

1. **IV**: if provider IV is missing, zero, or < 0.005, recompute from mid with our Brent solver (`iv_solver.py`). If mid is unusable too, drop the strike from the snapshot.
1. **Bid/ask**: if bid == 0 and ask > 0, synthesize bid = max(0.05, ask − synthetic_spread) where synthetic_spread = max(0.30, 0.025 × mid_estimate). Flag the row `synthetic_quote=True` (new column on market_snapshots, default false). If both are 0, drop the strike.
1. **Filter the universe**: only persist strikes with |delta| between 0.01 and 0.99 (computed or provider), within ±15% of spot, expiries ≤ 120 DTE. Keeps snapshot size sane (full SPX chain is enormous).
1. **Staleness**: store `fetched_at`; the frontend shows quote age. If the snapshot job sees identical spot 3+ cycles in a row during RTH, log a loud warning (feed is stuck).

### Consequence for fills (IMPORTANT, tell the user in README)

With Tradier we trusted bid/ask. With CBOE it’s still decent; with Yahoo fallback, fills may execute on synthetic quotes. Trades store `fill_quality: 'real' | 'synthetic'` so the league can argue about disputed fills later. This is a paper-trading game; perfect is not required, honest labeling is.

-----

## PHASE 2R — Data layer (rewritten)

Everything from the original Phase 2 handover stands EXCEPT Tradier. Recap of deliverables:

1. Python 3.11 venv, new deps: `httpx`, `pydantic` v2, `pydantic-settings`, `sqlalchemy` 2.x, `alembic`, `psycopg[binary]`, `tenacity`, `yfinance`, plus existing `numpy scipy pytest`
1. `config.py` — as before, minus tradier fields, plus `data_provider`
1. `symbols.py` — unchanged spec (OCC ↔ tuple ↔ pretty, round-trip tests). NOTE: CBOE option symbols look like `SPX260620C05850000` or sometimes `SPXW...` for weeklies — parse the root properly, don’t assume 3 chars. Keep both SPX and SPXW roots; they’re both fine to trade in the game.
1. `models.py` — 8 tables per original schema, plus `market_snapshots.synthetic_quote bool default false` and `trades.fill_quality text default 'real'`. No generated columns. Same indexes/uniques.
1. `db.py` + Alembic — unchanged spec. `001_initial.py` committed.
1. Providers as above, with tests:

- `test_cboe.py` — mocked httpx (respx/pytest-httpx): happy path, missing IV triggers solver path, bid=0 synthesis, both-zero drop, universe filter, User-Agent header present
- `test_yahoo.py` — mock yfinance objects: stale IV (1e-5) triggers solver, zero bid/ask handling
- Save ONE real CBOE response (trimmed to ~30 options) as `tests/fixtures/cboe/_SPX_sample.json`

1. CLI scripts: `fetch_chain` (pretty-print, no DB), `seed` (season + 3 users + accounts, idempotent), `ingest_snapshot` (idempotent upsert)

### Gates 2R

- [ ] pytest all green (Phase 1 + 2R)
- [ ] `alembic upgrade head` clean on fresh SQLite AND fresh Supabase Postgres
- [ ] `fetch_chain` against live CBOE returns >100 filtered strikes with <20% synthetic quotes during RTH
- [ ] `ingest_snapshot` run twice in the same minute writes once
- [ ] Switching `DATA_PROVIDER=yahoo` and re-running `fetch_chain` also works (degraded is fine, crash is not)

-----

## PHASE 3 — Backend app (FastAPI + trading + snapshot job)

### App skeleton

```
backend/vegalab/
├── api/
│   ├── app.py            # FastAPI factory, CORS (allow the Vercel origin + localhost)
│   ├── deps.py           # auth: Bearer token -> User; 401 otherwise
│   └── routes/
│       ├── chain.py      # GET /chain?expiry=
│       ├── trades.py     # POST /trade, GET /me/trades
│       ├── positions.py  # GET /me/positions, POST /me/hedge_delta
│       ├── pnl.py        # GET /me/pnl?granularity=snapshot|daily
│       ├── leaderboard.py# GET /leaderboard?metric=pnl|sharpe|attribution
│       └── jobs.py       # POST /jobs/snapshot (protected by JOB_SECRET header)
└── services/
    ├── trading.py        # fill logic, position updates, cash accounting
    ├── snapshots.py      # the engine: ingest + per-account attribution
    └── leaderboards.py   # metric computations
```

### Trading rules (services/trading.py)

- Buy fills at ask, sell at bid, from the LATEST market_snapshot for that instrument. Reject (422) if the latest snapshot is older than 30 minutes (“market data stale”).
- Cash: buy → cash −= fill × qty × 100; sell → cash += fill × qty × 100. Negative cash allowed (margin is out of scope) but reject if |cash| would exceed 5 × starting_capital (sanity cap).
- Position update: standard average-cost; realized PnL on reducing trades goes to `positions.realized_pnl`.
- Multi-leg: v1 = the frontend submits legs sequentially; no atomic strategy object. Note in BACKLOG.md.
- `POST /me/hedge_delta {target_delta: 0}` → compute account delta from latest snapshot Greeks, set `delta_hedge_notional = -(account_delta − target) × S`. Store; financing handled by snapshot job.

### Snapshot engine (services/snapshots.py) — the heart

On `POST /jobs/snapshot`:

1. Fetch chain via provider (with fallback). Upsert instruments + market_snapshots.
1. For each account with open positions or nonzero hedge:
   a. Load previous snapshot ts (last pnl_attribution row, or position open time)
   b. For each position: build snap_t0/snap_t1 dicts (S, σ, T, price=mid… see note), call `quant.attribution.attribute`
   c. Mark price for PnL = mid. Fills happen at bid/ask, marks at mid — standard. The crossing cost shows up as immediate negative PnL on entry, which is honest.
   d. Hedge leg: pnl += hedge_notional × (S₁/S₀ − 1); financing −= r × |hedge_notional| × Δt. Add to the financing bucket per the Phase 1 math.
   e. Sum buckets across positions → one pnl_attribution row per account per snapshot ts.
1. Greeks where σ missing at t0 or t1 → that position’s interval PnL goes 100% to residual (don’t fabricate).
1. Idempotent: unique (account_id, snapshot_ts); re-run = no-op.
1. Wrap the whole thing in one transaction per account; one account failing must not poison the others.

### Leaderboards (services/leaderboards.py)

- pnl: SUM(total) season-to-date per account
- sharpe: daily PnL series (sum buckets per day) → mean/std × √252; require ≥5 trading days else null
- attribution accuracy: per day, 1 − |residual_day| / max(|total_day|, 100); season average; days with |total| < $100 excluded (noise)

### Auth

- `users.api_token`, compared constant-time. `Authorization: Bearer <token>`.
- `POST /jobs/snapshot` requires `X-Job-Secret: <JOB_SECRET>` env match instead.

### Tests

- trading: fill at correct side, avg-cost math, realized PnL on reduce, stale-data rejection, cash cap
- snapshots: end-to-end with two fabricated chain snapshots → attribution rows exist, buckets sum to actual, idempotency
- leaderboards: synthetic attribution rows → correct ordering on all 3 metrics
- auth: 401 without token, 200 with

### Gates 3

- [ ] pytest all green (everything so far)
- [ ] Local end-to-end: seed → ingest_snapshot → POST /trade via curl → ingest_snapshot again (RTH, prices moved) → GET /me/pnl shows attribution rows whose buckets sum to total
- [ ] GET /leaderboard returns all 3 metrics
- [ ] Snapshot endpoint rejects without JOB_SECRET

-----

## PHASE 4 — Frontend (Next.js on Vercel)

Use the existing mockup (`spx_league_mockup.jsx`) as the visual reference — keep the dark, dense, monospaced terminal aesthetic, amber accents, green/red strictly for direction/PnL sign.

- Next.js 14 app router, Tailwind, TanStack Query (30s polling), Recharts
- Token entry screen → stored in localStorage → attached as Bearer on all calls (NOTE: this is a real deployed Next.js app, not a Claude artifact — localStorage is fine here)
- Five screens per the mockup: Chain (expiry tabs, click bid/ask → ticket), Ticket (fill preview, Greeks current/trade/after, scenario bars), Positions (blotter, net-Greek cards, FLATTEN DELTA button, hedge panel), PnL (stacked attribution area chart, bucket breakdown bars, explained-% card), Leaderboard (3 tabs, attribution-accuracy explainer)
- Header strip always shows: spot, quote age (“DELAYED 15m · as of HH:MM”), account equity, net Δ Γ Θ 𝒱
- Show `synthetic_quote` rows with a subtle ⚠ in the chain and on fills
- Empty states for fresh accounts; loading skeletons; that’s enough polish for v1

### Gates 4

- [ ] `npm run build` clean
- [ ] Full flow locally against local backend: log in with seeded token, trade from chain, see position, flatten delta, see attribution after next snapshot
- [ ] Works on a phone screen (the league will check standings from phones)

-----

## PHASE 5 — Deploy (free tier everywhere)

Claude Code writes configs + docs; the HUMAN does the dashboard clicks. Document every manual step in `DEPLOY.md`.

1. **Supabase**: human creates project, gets session-pooler URI → `alembic upgrade head` → `seed`
1. **Fly.io backend**: `fly launch` (no Postgres, no Redis), `fly secrets set DATABASE_URL=... JOB_SECRET=... DATA_PROVIDER=cboe`, deploy, hit `/health`
1. **Vercel frontend**: import repo, root `frontend/`, env `NEXT_PUBLIC_API_URL=https://<app>.fly.dev`, deploy
1. **GitHub Actions cron** (`.github/workflows/snapshot.yml`):

- schedule: `*/5 13-21 * * 1-5` (UTC, covers RTH year-round with slack; the job itself exits early outside 09:30–16:00 ET or on weekends — do the ET check in the job, handles DST)
- step: curl POST `$FLY_URL/jobs/snapshot` with `X-Job-Secret: ${{ secrets.JOB_SECRET }}`, retry 3×, fail loudly
- second workflow `season.yml`: monthly on the 1st, calls `/jobs/rollover` (archive standings, create new season + accounts at $100k)

1. **Health**: `/health` returns last snapshot ts + provider used; README documents “if last snapshot > 20 min old during RTH, check Actions tab”

### Gates 5 (final)

- [ ] Live URL loads, all 3 tokens log in
- [ ] Trade placed in prod lands in Supabase
- [ ] Two consecutive cron runs → attribution rows in prod
- [ ] Leaderboard renders with real (small) numbers
- [ ] Cold-start note: first request after idle may take ~30s on free Fly — document, don’t fight it

-----

## Conventions carried forward

- Greeks at t₀ for attribution; mark at mid; Vega per vol-point; Theta per day; Charm per year (docstring it); multiplier 100 applied in attribution/trading, never pricing
- r = 0.0438, q = 0.015 hardcoded (BACKLOG: pull SOFR daily)
- All timestamps UTC in DB; ET only at display/cron-guard edges
- Commit per phase: `phase-2r: data layer (cboe/yahoo)`, `phase-3: api + engine`, `phase-4: frontend`, `phase-5: deploy`

## Report back after each phase with

- Test counts + any deviations from this spec and why
- Phase 2R: sample `fetch_chain` output + synthetic-quote % during RTH
- Phase 3: the curl transcript of the end-to-end gate
- Phase 4: screenshot of chain + pnl screens
- Phase 5: the live URL + first real attribution row

## Estimated effort

2R: 4–5h · 3: 6–8h · 4: 8–12h · 5: 2–3h (plus human dashboard time). Roughly two weekends.

Extra note: Deploy configs assume repo root — Vercel and Fly need to point at vegalab/frontend and vegalab/backend rather than the root. That’s a one-line setting in each (“root directory” in Vercel, fly.toml path for Fly), and worth adding to the kickoff prompt so Claude Code writes DEPLOY.md with the right paths.
