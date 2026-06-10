# VEGALAB — Deploy runbook (phone-browser edition)

Every step below works from a phone browser. No CLI is ever required on
your side: migrations run from Fly's network on every deploy
(`release_command = "alembic upgrade head"` in `fly.toml`), and deploys
run from GitHub Actions.

Order matters: **1 → 2 → 3 → 4 → 5**.

---

## 1. Supabase — schema + seed (SQL Editor, over HTTPS)

1. In the [Supabase dashboard](https://supabase.com/dashboard), open your
   project → **SQL Editor** → **New query**.
2. Paste the full contents of `vegalab/deploy/supabase_schema.sql` → **Run**.
   Expected result: 8 tables + `alembic_version` stamped at `002`.
3. New query → paste the **seed SQL** (delivered separately — it contains
   the three live API tokens, so it is never committed) → **Run**.
4. Verify in **Table Editor**: `users` has alice/bob/carol, `accounts` has
   three rows with `cash = 100000`, `seasons` has `Season 2026-06`.
5. Grab the database URL for step 3:
   **Project Settings → Database → Connection string**, pick
   **Session pooler** (port **5432** — not the transaction pooler on 6543;
   psycopg uses prepared statements, which transaction pooling breaks).
   Replace `[YOUR-PASSWORD]` with the real DB password. It looks like:

   ```
   postgresql://postgres.<ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres
   ```

## 2. Fly.io — create a deploy token

1. Sign up / log in at [fly.io](https://fly.io) (needs a payment card on
   file, but this app fits in the lowest tier: one shared-cpu-1x / 512 MB
   machine that auto-stops when idle).
2. Dashboard → **Tokens** (or `fly.io/user/personal_access_tokens`) →
   **Create token**. An org-wide token is needed because the workflow
   creates the app on first run. Copy it.

Note: the app name `vegalab-api` is global across Fly. If someone has
taken it, pick another name and change it in `vegalab/fly.toml` (`app =`)
and in the three workflow files (`vegalab-api` appears in `deploy.yml`,
`snapshot.yml`, `season.yml`, and the API URL becomes
`https://<new-name>.fly.dev`).

## 3. GitHub — add the four Actions secrets

Repo → **Settings → Secrets and variables → Actions → New repository
secret**, four times:

| Secret | Value |
|---|---|
| `FLY_API_TOKEN` | the Fly token from step 2 |
| `DATABASE_URL` | the session-pooler URI from step 1.5 |
| `JOB_SECRET` | a long random string you generate (e.g. two UUIDs glued together); the cron workflows send it as `X-Job-Secret` |
| `CORS_ORIGINS` | `https://<project>.vercel.app,http://localhost:3000` — your planned Vercel domain (you pick the project name in step 5; `vegalab.vercel.app` if free) |

These are pushed to the Fly app as runtime secrets **on the first deploy
only** (the run where `flyctl apps create` succeeds). To change one later,
update it in the Fly dashboard → app → **Secrets** (that also restarts the
machine), or delete the Fly app and let the next deploy re-bootstrap.

## 4. Deploy the backend

1. Merge the phase-5 PR into `main`. The `deploy-backend` workflow
   triggers on any push to `main` touching `vegalab/backend/**` (plus the
   Docker/Fly files); first run creates the app, sets secrets, migrates
   (release command), and deploys. Watch it in the **Actions** tab. You
   can also start it manually: Actions → deploy-backend → **Run workflow**.
2. Smoke check: open `https://vegalab-api.fly.dev/health` — expect
   `{"status":"ok","last_snapshot_ts":null,"provider":"cboe"}`.
   `last_snapshot_ts` stays null until the first snapshot cron fires
   during RTH (or you run the snapshot workflow manually during RTH).

## 5. Vercel — frontend

1. [vercel.com/new](https://vercel.com/new) → **Import** this repo.
2. Settings on the import screen:
   - **Root Directory**: `vegalab/frontend`  ← the one setting that matters
   - Framework preset: Next.js (auto-detected via `vercel.json`)
   - **Environment variable**: `NEXT_PUBLIC_API_URL` = `https://vegalab-api.fly.dev`
3. **Deploy**. If the final domain differs from what you put in
   `CORS_ORIGINS` (step 3), fix the Fly secret: Fly dashboard →
   vegalab-api → Secrets → edit `CORS_ORIGINS`.

---

## Post-deploy smoke checklist (Gates 5)

- [ ] The Vercel URL loads, and all **3 tokens** log in (token screen →
      header shows equity $100,000).
- [ ] During RTH, place a small trade → row appears in Supabase **Table
      Editor → trades** with `fill_quality`.
- [ ] Two consecutive snapshot-cron runs (Actions tab, ~5 min apart) →
      rows in **pnl_attribution** whose buckets sum to `total_pnl`.
- [ ] Leaderboard renders with real (small) numbers on all 3 tabs.
- [ ] `/health` shows a recent `last_snapshot_ts` during RTH. If it goes
      >20 min stale during RTH, check the Actions tab — the snapshot
      workflow fails loudly on purpose.

## Things to know

- **Cold start**: the Fly machine auto-stops when idle; the first request
  after a quiet spell takes ~10–30 s. Don't fight it — it keeps the bill
  at pennies. The snapshot cron's `--retry-all-errors` already absorbs it.
- **Quotes are 15-min delayed** (CBOE), snapshots every 5 min during RTH
  only. Marks move only when a snapshot lands.
- **Season rollover** is automatic: 1st of each month, 13:00 UTC, the
  `season-rollover` workflow hits `/jobs/rollover` — archives the old
  season's standings (accounts are per-season, so history freezes in
  place), creates `Season YYYY-MM`, and gives every user a fresh $100k
  account. Idempotent; safe to run manually from the Actions tab.
- **Rotating a token**: Supabase SQL Editor →
  `UPDATE users SET api_token = '<new-hex>' WHERE name = 'alice';`
