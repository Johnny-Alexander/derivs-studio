# Derivs Studio v4 — Path-Dependent & Variance Plan

## 1. Goal

v3 made the model layer interesting: GBM, Heston (with FFT calibration), and
Dupire local vol all price every product end-to-end, with a Sobol/antithetic
sampler picker driving Monte Carlo. Calibration is wired, the LV surface is
editable, the cliquet card visibly moves under different models — the headline
demo of v3 works.

What v3 *doesn't* have, by deliberate scope cut, is a coherent story for
**path-dependent payoffs that consume a calibrated surface** beyond barriers
and cliquets, and it doesn't finish the model lineup it advertises (Merton,
SLV). v4 closes both gaps.

The bar for v4 is: **a user can calibrate Heston (or build an LV surface),
price an Asian / lookback / variance swap against it with a working
variance-reduction story, and see error budgets that justify the run.**

Non-goals: still no server, still no live market data, still constant rates.
Multi-asset is gated on a real use case appearing — see §12.

---

## 2. What v3 already gives us

The contracts to extend are the same shape as v3, plus the extras v3 added:

- **Model interface** in [models.js](../v3/models.js):
  `{ id, name, paramSchema, simulatePath?, simulateState?, stateDim,
     analyticVanilla?, analyticDigital?, effectiveVol? }`
- **Product interface** in [products.js](../v3/products.js):
  `{ id, name, defaultSpec, requiredGrid, evaluatePath, accumulate?,
     auxInit?, auxFinalize?, analyticPrice?, controlVariate? }`
- **Engines** in [engines.js](../v3/engines.js): `priceAnalytic`,
  `priceMonteCarlo` with sampler routing.
- **Sampling** in [mc-worker.js](../v3/mc-worker.js) +
  [sobol.js](../v3/sobol.js): pseudo / antithetic / Sobol' (Joe-Kuo + CP
  rotation, first 17 dims QMC, tail falls back to pseudo).
- **Calibration** in [calibration.js](../v3/calibration.js) and
  [transforms.js](../v3/transforms.js): Heston Carr–Madan + LM driver.
- **Surface** in [surface.js](../v3/surface.js) +
  [localvol.js](../v3/localvol.js): editable IV grid + Dupire bilinear LV
  lookup, suitable for use in MC hot loops.
- **Job manager** in [jobs.js](../v3/jobs.js): worker-pool wrapper used by
  every product card.

The `controlVariate` hook on products is **plumbed but unused** in v3. v4 is
the first time it earns its keep.

---

## 3. Carryover from v3

Two pieces deliberately deferred mid-v3, plus one polish bucket. These come
first in v4 because the rest of v4 leans on them.

### 3.1 Merton jump-diffusion

Cheap and visually distinct from Heston. The closed form for vanillas is a
Poisson-weighted sum of BS prices:

```
C(S, K, T) = Σ_{n=0..N}  e^{-λT} (λT)^n / n!  *  BS(S, K, T; σ_n, r_n)
σ_n² = σ² + n σ_J² / T
r_n  = r - λ m + n (μ_J + σ_J²/2) / T
m    = exp(μ_J + σ_J²/2) - 1
```

- **Parameters:** `σ, λ, μ_J, σ_J`. Truncate at `n = 40`.
- **Simulation:** Euler with Poisson jump increments per step. Trivial.
- **Slot:** drops straight into `analyticVanilla` and `simulatePath`. No
  multi-state plumbing, no surface plumbing.
- **Calibration:** LM on the same surface input v3 already exposes; reuses
  the residual heatmap UI from `ui-calibration.js`.
- **Sanity:** with `λ = 0`, prices must match BS at `σ` to ~1bp — assert on
  load the same way v3 asserts the Heston FFT collapses.

### 3.2 SLV (stochastic local vol) — particle calibration

LV times a Heston-style leverage:

```
dS = (r - q) S dt + L(S, t) sqrt(v) S dW1
dv = κ(θ - v) dt + ξ sqrt(v) dW2
```

`L(S, t)` is calibrated so the SLV model reprices the LV surface. Use the
**Guyon–Henry-Labordère particle method** at coarse resolution:

- ~50 strikes × 20 maturities, ~50k particles, ~30 timesteps/yr.
- Single-pass: at each maturity bucket, estimate `E[v | S=K]` from the
  particle cloud, set `L²(K, T) = σ_LV²(K, T) / E[v | S=K]`.
- Run in a worker, progress bar, **cancellable** (re-uses
  [jobs.js](../v3/jobs.js)).
- Falls back to "LV-only" if the user kills it — graceful degradation, no
  hidden retries.

The leverage surface gets visualized as a heatmap in the LV card so the user
sees what calibration produced, and the cliquet card gains "SLV" alongside
"LV / Heston" on its model picker. **This finishes the v3 demo story.**

### 3.3 Error-budget UI + exportable reports

v3 shows MC stderr on individual cards. v4 adds:

- A consolidated **error budget panel** on each MC product: stderr, 95% CI,
  bias estimate (where applicable — e.g. discrete-barrier bias from §6.4),
  and the marginal cost in paths to halve the CI.
- **Exportable reports**: a "Copy results as Markdown" button per product
  that dumps spec + market + model + price + error budget + sampler choice.
  No PDF, no charts in the export — keeps the surface area tiny. Works
  offline (which the rest of the app already does via the service worker).

---

## 4. New products

The v3§12 "deferred" list, plus one tooling piece.

### 4.1 Asian options (the control-variate showcase)

Arithmetic-average call/put on `[T_obs_start, T]`, fixed strike.

- `requiredGrid` returns the obs-time grid (default ~daily for ~252 obs/yr).
- `evaluatePath` averages along the obs slice.
- **Control variate:** geometric-average Asian. Has closed form under GBM
  (Kemna–Vorst); for non-GBM models the geometric average's PV under GBM-at-
  ATM-vol is still a useful CV — bias is zero, variance shrinks, the engine
  doesn't care that the CV is a different model. **First real consumer of
  the `controlVariate` hook plumbed in v3.**
- Variance-reduction badge on the card: shows the empirical variance ratio
  vs. naive MC so the user can *see* the CV working.

### 4.2 Lookback options

Fixed-strike and floating-strike, on `min`/`max` of the path.

- Closed form under GBM (Goldman–Sosin–Gatto).
- MC under Heston/LV/Merton — the running min/max is the obvious source of
  discretization bias, so this product is the first user of the
  Brownian-bridge correction in §6.4.
- `accumulate` collects the running-extremum distribution at maturity for
  the chart.

### 4.3 Variance swap

Model-free replication via a strip of OTM options:

```
K_var = (2/T) [ ∫₀^F P(K)/K² dK  +  ∫_F^∞ C(K)/K² dK ]  +  small forward term
```

- Replication strip is computed from the **input IV surface directly** — no
  model needed. This is the "honest" price.
- Alongside it: the **model price** under each available model (closed form
  under Heston is doable but use MC for v4 — keeps code small).
- The card visualizes the replication strip as a smile overlay, which
  doubles as a sanity check on the user's surface.

### 4.4 Volatility swap

`E[√(realized variance)]`. MC-only, with the Brockhaus–Long convexity
adjustment as a control-variate-style correction (subtract `K_var^{1/2}`,
add a Jensen-gap estimate). Smaller, simpler card than varswap; mostly there
to make the convexity gap visible.

### 4.5 Forward starting vanilla (small)

Forward-start call/put at `T_start`, expiry at `T_end`. Closed form under
GBM and Heston (via FFT on the forward characteristic function). Useful as
the simplest forward-skew product — bridges the gap between vanillas and
cliquet for the user.

---

## 5. Calibration extensions

v3 calibrates Heston only. v4 broadens:

1. **Merton calibration** — same LM driver, new objective. Add a "Model:"
   dropdown to the calibration card. Falls back gracefully if the user picks
   a model that can't be calibrated (e.g. SLV uses §3.2's particle method
   instead of LM).
2. **Joint Heston ↔ SLV chain** — when SLV is the active model, "Calibrate"
   runs Heston-LM first, then SLV-particle, displayed as two stages with
   their own progress.
3. **Calibration history** — the last N calibration results are stored in
   `localStorage` so the user can roll back. Surface in a small "History"
   button next to "Calibrate".
4. **CSV import** for surfaces. v3 has a built-in editable grid; v4 adds
   "Paste from clipboard" / "Load CSV" so a user can drop a market surface
   in. Validates monotonicity / arbitrage at import time and refuses obvious
   garbage with a readable error.

---

## 6. Architecture deltas

Smaller than v3§6 — most plumbing already exists.

### 6.1 Path-stat hook on products

Asian / lookback / varswap all want **summary statistics over the simulated
path**, not just the terminal value. v3's `evaluatePath(grid, path)` already
gets the full path; what's missing is a clean way to report extra stats
(running max, average, realized variance) into `aux` for the chart.

Extend the existing `auxInit` / `auxFinalize` shape to support pushing
per-path summary samples (capped at ~20k samples per run, same convention as
v3's cliquet card) without bloating worker → main message size.

### 6.2 Control-variate engine path

Already plumbed in v3's `mc-worker.js`. v4 just **uses** it:

- Engine subtracts `(pvCV - analyticCV)` from each path PV.
- Reports the empirical β (regression coefficient) and the achieved variance
  reduction in the badge.
- Asian + volswap are the v4 consumers; lookback/barrier with a
  Brownian-bridge correction may pick this up too.

### 6.3 Multi-state for SLV

v3 introduced `simulateState` / `stateDim` for Heston (state = `(S, v)`).
SLV reuses the same shape — state stays at `stateDim = 2`, only the drift /
diffusion of `S` changes (multiplied by `L(S, t)`). No new plumbing.

### 6.4 Brownian-bridge correction for barriers and lookbacks

For path-extremum products under continuous monitoring, discrete-grid
Monte Carlo systematically *underestimates* barrier hits / extremum
distance. The standard fix: between every pair `(S_i, S_{i+1})` on a path,
compute the Brownian-bridge probability of touching the barrier (or sample
the conditional running extremum analytically).

- For barriers: replace the indicator `1{min S_i ≤ B}` with the
  bridge-corrected probability per step. **Closes the discretization gap
  without making users run finer grids.**
- For lookbacks: sample the conditional max/min from each bridge analytically
  (closed-form distribution).
- Implemented as an opt-in flag on the product (`monitoring: 'discrete' |
  'bridge'`), default `'bridge'` for new cards. Show the gap in the error
  budget.

### 6.5 Sobol' dimension count

v3's Sobol' generator covers 17 dimensions; longer paths fall back to pseudo
on the tail. For Asian / lookback / barrier on daily grids, the path
dimension easily exceeds 17, defeating most of the QMC win.

Two cheap wins:
- **Brownian-bridge construction** of the path: spend the first few Sobol'
  dimensions on the *most variance-explaining* components (terminal point,
  midpoint, quartile points…) and fill the rest with pseudo. Big win on
  smooth-payoff path-dependents.
- **Extend Joe-Kuo direction numbers** to dim = 64 or 128. Static data,
  ~1KB, no algorithmic change.

Pick one or both; bridge construction has more impact for the products
v4 ships.

### 6.6 Worker pool: priority lanes

v3's `jobs.js` has a single FIFO. v4 adds two lanes: `interactive` (UI
recomputes — typing in a strike box) and `bulk` (calibration, multi-product
sweeps). Bulk yields to interactive. Single-line config change.

---

## 7. UI

- **Asian / lookback / varswap / volswap / forward-start** product cards,
  one per file (`ui-asian.js`, `ui-lookback.js`, …) following the v3 pattern.
- **Error-budget panel** on every MC card. Compact, collapsed by default;
  expands to show stderr, CI, bias estimate (if any), CV reduction factor,
  and "paths to halve CI".
- **Calibration card v2:** model dropdown, history dropdown, CSV import
  button. SLV calibration shows two-stage progress.
- **LV card:** add a leverage-surface heatmap when the active model is SLV.
- **Sampler hint** in the model card grows a footnote explaining when Sobol'
  +bridge construction is the right call (smooth payoffs, daily-grid
  path-dependents).
- **Export-as-Markdown** button on every product card. Toast confirms
  copied-to-clipboard.
- Mobile: error-budget panel collapses; CSV import is a file picker, not a
  paste box.

---

## 8. File layout

Same flat layout as v3, additions only:

```
v4/
  index.html              (extends v3 with new product tabs + export buttons)
  app.js                  (state additions: cal history, error-budget config)
  styles.css              (v3 + leverage heatmap, error-budget panel,
                           reduction-ratio badge variants)
  core.js                 (v3 + Brownian-bridge helpers, Poisson sampler)
  models.js               (v3 + merton, slv)
  products.js             (v3 + asian, lookback, varswap, volswap,
                           forward-start)
  engines.js              (v3 + control-variate β reporting,
                           bridge-monitoring routing)
  mc-worker.js            (v3 + bridge sampler for extrema, Poisson jumps,
                           SLV state evolution)
  transforms.js           (v3 + Merton char. function, forward-start char.
                           function)
  calibration.js          (v3 + Merton LM, SLV particle driver, history)
  surface.js              (v3 + CSV importer, arb checks)
  localvol.js             (v3 + leverage surface storage for SLV)
  sobol.js                (v3 + extended direction numbers, bridge builder)
  jobs.js                 (v3 + priority lanes)
  charts.js               (v3 + leverage heatmap, replication strip,
                           running-extremum distribution)
  ui-vanilla.js           (+ error-budget panel, export button)
  ui-digital.js           (+ panel + export)
  ui-autocallable.js      (+ panel + export)
  ui-barrier.js           (+ bridge-monitoring toggle, panel, export)
  ui-cliquet.js           (+ panel + export)
  ui-asian.js             (new — control-variate showcase)
  ui-lookback.js          (new)
  ui-varswap.js           (new — replication strip overlay)
  ui-volswap.js           (new)
  ui-forwardstart.js      (new)
  ui-calibration.js       (+ model dropdown, history, CSV import,
                           SLV two-stage progress)
  ui-localvol.js          (+ leverage heatmap for SLV)
  reports.js              (new — markdown serializer)
  manifest.webmanifest, sw.js (cache bump), icon.svg
```

---

## 9. Phasing

Same posture as v3 — every phase ends shippable. Pick up where the previous
phase left off.

**Phase 1 — Carryover.**
Merton model + analytic + simulation + calibration. SLV particle calibration
on top of the existing LV card. Error-budget panel + Markdown export.
End-of-phase smoke test: cliquet under SLV must price (it didn't in v3).

**Phase 2 — Path-stat hook + Asian.**
Wire `auxInit`/`auxFinalize` extension for per-path summary samples. Build
Asian product end-to-end with the geometric-average control variate.
**This is the v4 headline for variance reduction** — show the empirical
variance ratio in the card. Without this phase, the CV hook v3 plumbed
remains unused.

**Phase 3 — Brownian-bridge for extrema + lookback + barrier upgrade.**
Bridge sampler for running extremum, retrofit into barriers (toggle, default
on for new cards) and use it in the new lookback card. Error-budget shows
the discrete-vs-bridge gap so the user understands what changed.

**Phase 4 — Variance / volatility / forward-start.**
Variance swap with the surface-replication strip (no model needed for the
honest price). Volswap with the convexity adjustment. Forward-start
(closed form under GBM/Heston, FFT char. function). Closes the §4 list.

**Phase 5 — Sobol' + sampler upgrades.**
Brownian-bridge construction on Sobol' (rank-1 first), extended direction
numbers if needed. Per-product sampler heuristic ("Sobol' + bridge
recommended") shown in the card hint when path-dim is high.

**Phase 6 — Calibration polish + multi-asset gate.**
CSV import for surfaces, calibration history, priority lanes in
`jobs.js`. If a real multi-asset use case has appeared, scope it here;
otherwise it stays deferred to v5.

---

## 10. Risks and how we'll know

- **SLV particle calibration is the genuinely heavy code.** v3 punted it.
  Mitigation: cap particle count and surface resolution at the start, show
  a progress bar, allow cancel. If a single calibration on a recent laptop
  takes >30s, cut grid resolution before optimizing the inner loop.
- **Control-variate β instability** with small path counts. The engine
  computes β as `Cov(PV, CV) / Var(CV)`; with <500 paths this is noisy.
  Mitigation: floor path count for CV products at 2000; warn in the
  error-budget panel if estimated β is outside a sensible range.
- **Brownian-bridge sampler correctness.** Easy to misuse the conditional
  extremum distribution under non-GBM dynamics. v4 only applies the bridge
  *between Euler steps* — locally GBM-like — and tests against a fine
  discrete grid (10x density) on a known case at app start.
- **Sobol' bridge construction's payoff isn't free.** It costs a permutation
  of the time grid and hurts cache locality. Measure on the cliquet first;
  if the win on Asian is <20% variance reduction, leave bridge construction
  off by default and only expose it as a power-user toggle.
- **Markdown export leaking secrets.** Surface inputs and calibrated params
  could be sensitive in some contexts. Mitigation: the export button copies
  to *clipboard*, never to a server; the markdown explicitly does not
  include URLs or environment info. We document what's in the export so the
  user can audit.
- **Surface CSV imports.** The biggest source of bad data. Validate on
  import, show errors per cell, refuse to load surfaces with arbitrage
  violations beyond a tolerance.
- **Scope creep.** Multi-asset and rate dynamics still tempt. Multi-asset
  is gated on a use case in §12; rate dynamics is v5.

---

## 11. Definition of done for v4

- All five v3-deferred products (Asian, lookback, varswap, volswap,
  forward-start) ship and price under every applicable model.
- Geometric-average CV demonstrably reduces Asian variance by ≥4× at
  default settings (variance ratio shown on the card).
- Brownian-bridge correction closes the discrete-monitoring barrier gap
  to <1% on the standard test case (down from ~5–15% with discrete
  monitoring at 252 obs/yr).
- SLV calibrates to the user's LV surface in <30s on a recent laptop and
  the cliquet card prices under SLV alongside Heston/LV.
- Merton calibrates from the calibration card alongside Heston, with the
  same residual heatmap.
- Every MC card shows an error-budget panel, and "Copy as Markdown"
  reproduces a result in a separate tab.
- All v3 prices are unchanged under GBM, Heston, and LV — the carryover
  and plumbing work must be invisible to v3 users.

---

## 12. Deferred to v5

Items punted out of v4 to keep scope tight.

- **Multi-asset / basket / worst-of.** Plumbing requires
  `simulatePathsMulti(S0[], grid, …)` with a Cholesky factor and a
  correlation-matrix UI. Real demand has not appeared. If it does mid-v4,
  it slots in at the end of Phase 6; otherwise v5.
- **Stochastic interest rates** (Hull–White / G2++). Useful only with
  multi-curve / FX, which is a much larger change. v5 at earliest.
- **American options / early exercise.** Longstaff–Schwartz on top of the
  existing MC engine is doable in a phase-sized chunk, but doesn't fit the
  v4 "consume-the-surface" theme. v5.
- **PDE engine for vanillas under Heston/LV.** A finite-difference engine
  would beat MC on speed and stderr for vanillas. Real value only if
  calibration moves to PDE-based pricing too — a much bigger commitment.
- **CVA / counterparty stuff.** Out of scope until the app has real-world
  trade-capture, which it doesn't and shouldn't.
- **Server-backed market data feed.** Out of scope — v4 stays a
  single-page, offline-capable app. Live data is a different product.
