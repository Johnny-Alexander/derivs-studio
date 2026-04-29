# Derivs Studio v3 — Expansion Plan

## 1. Goal

v2 ships a clean plugin architecture (models × products × engines) but only one
real model: Black–Scholes / GBM. The other entries in `models.js` (`HESTON_STUB`,
`LV_STUB`, `SLV_STUB`) advertise themselves as "soon".

v3 turns those stubs into working pricers and adds the products that *need* a
richer model to be interesting (barriers, Asians, cliquets, variance products).
The bar for v3 is: **pricing under a non-flat vol surface, with a visible
calibration step, end-to-end in the browser.**

Non-goals: no server, no real market data feed, no interest-rate dynamics
(rates stay constant). Still educational, still single-page.

---

## 2. What v2 already gives us

The contracts to extend are clear from the code:

- **Model interface** in [models.js](../v2/models.js):
  `{ id, name, paramSchema, simulatePath(...), analyticVanilla?, analyticDigital? }`
- **Product interface** in [products.js](../v2/products.js):
  `{ id, name, defaultSpec, requiredGrid, evaluatePath, accumulate?, auxInit?, auxFinalize?, analyticPrice? }`
- **Engines** in [engines.js](../v2/engines.js): `priceAnalytic` and
  `priceMonteCarlo` (worker-backed via [mc-worker.js](../v2/mc-worker.js)).
- Pure-math primitives in [core.js](../v2/core.js): `bs`, `bsDigital`, `erf`, `N`,
  `mulberry32`, `makeNormal`, `welford`.

Everything below slots into those contracts. Where a contract has to grow, it is
called out explicitly.

---

## 3. New models

Each new model adds a `simulatePath` and, where possible, a fast pricer for
vanillas so a calibration loop is cheap. Models that don't have closed form
fall back to MC.

### 3.1 Heston (stochastic volatility)

State: `(S_t, v_t)` with mean-reverting variance.

```
dS  = (r - q) S dt + sqrt(v) S dW1
dv  = κ(θ - v) dt + ξ sqrt(v) dW2
corr(dW1, dW2) = ρ
```

- **Parameters:** `v0, κ (kappa), θ (theta), ξ (xi/volvol), ρ`.
- **Simulation:** full-truncation Euler on `v` (cheap, robust). QE scheme is a
  later optimization — not needed for v3.
- **Vanilla pricer:** semi-analytic via the **Carr–Madan FFT** of the
  characteristic function. New file `v3/transforms.js` with a small FFT and
  the Heston char. function. Reused for calibration.
- **Greeks under Heston:** delta/gamma by FFT bumps (analytic from the
  characteristic function is doable but overkill for v3); theta/rho
  numerical bumps as v2 already does for digitals.
- **Tests:** with `ξ = 0` and `κ` large, prices must collapse to BS at
  `sqrt(θ)` within a few bp — a sanity test we run on load.

### 3.2 Dupire local volatility

A deterministic surface `σ(S, t)` that *exactly* reprices a given vanilla grid.

- **Inputs:** an implied-vol surface entered on a `(strike%, maturity)` grid
  (defaulted to a parametric SVI-lite shape so the user has something to play
  with on day 1). New file `v3/surface.js`.
- **Construction:** Dupire's formula on the *total implied variance* surface
  with monotone-cubic interpolation in `k = log(K/F)` and linear in `T`.
  Floor `σ_loc²` at a small positive number to keep MC stable.
- **Simulation:** Euler on `log S` with `σ` looked up at `(S_i, t_i)`.
- **No closed form** for vanillas under Dupire — vanillas under LV are *defined*
  to match the input surface, so the "analytic" pricer for LV vanillas just
  reads off the surface directly. That keeps calibration trivial.

### 3.3 Stochastic Local Vol (SLV)

LV multiplied by a Heston-style leverage factor:

```
dS = (r - q) S dt + L(S, t) sqrt(v) S dW1
```

- Calibration of `L` to make SLV match the LV surface uses a particle method
  (Guyon–Henry-Labordère). Heavy. v3 ships a **single-pass particle calibration
  on a coarse grid** (~50 strikes × 20 maturities, ~50k particles). Anything
  more lives in v4.
- Run-time pricing is MC only.

### 3.4 Merton jump-diffusion (cheap bonus)

Adding jumps is a small amount of code and gives the user a second non-Gaussian
marginal to compare with Heston:

```
dS = (r - q - λ m) S dt + σ S dW + (e^J - 1) S dN
J ~ N(μ_J, σ_J), λ = jump intensity, m = E[e^J - 1]
```

- Series-form closed form for vanillas (sum of BS prices weighted by Poisson
  probabilities) — fits the existing `analyticVanilla` slot exactly.
- Truncated at `n = 40` jumps, way more than enough at typical params.

---

## 4. New products

Products that are boring under flat-vol GBM and *interesting* under v3 models:

### 4.1 Barrier options (single-asset, continuous monitoring)

Up-and-out, down-and-out, up-and-in, down-and-in × call/put.

- `requiredGrid(spec)` returns a fine time grid (e.g. 252 steps/year) so the
  Brownian-bridge correction can run in `evaluatePath`.
- `accumulate` collects barrier-touch probabilities per maturity bucket.
- Closed form under GBM (reflection principle) — fills the `analyticPrice` slot
  so users can A/B closed-form vs MC vs Heston-MC on the same screen.

### 4.2 Asian options

Arithmetic-average call/put on the period `[T_obs_start, T]`.

- No closed form (arithmetic average); MC only.
- **Variance reduction:** geometric-average control variate (geometric Asian
  *does* have closed form under GBM). Wire this in as a generic mechanism on
  the product interface — see §6.

### 4.3 Lookback options

Fixed-strike and floating-strike, on min/max of the path.

- Closed form under GBM, MC otherwise.

### 4.4 Cliquet / forward-start ladder

A series of forward-starting calls with global cap and local cap/floor — the
classic "1-year cliquet, monthly resets, local cap 2%, local floor -1%, global
cap 8%". Fundamentally smile-sensitive: forward-skew dominates the price, so
this is the showcase product for SLV vs Heston vs LV.

### 4.5 Variance swap and volatility swap

- **Variance swap:** model-free replication via a strip of OTM options. Closed
  form even under v2. Used as a calibration target for §3.
- **Volatility swap:** convexity adjustment, MC-only.

### 4.6 Multi-asset basket / worst-of (stretch)

Requires extending the model interface to `simulatePathsMulti(S0[], grid, …)`
with a Cholesky factor. Plumb it as optional — only enable products under
models that implement it. Likely deferred to v4 if scope tightens.

---

## 5. Calibration

The reason any of this matters. New "Calibrate" tab between Model and Product:

1. User picks/edits an implied-vol surface (or imports a CSV).
2. User picks a model (Heston / Merton / SLV).
3. v3 runs least-squares on weighted IV errors:
   - **Heston:** Levenberg–Marquardt on `(v0, κ, θ, ξ, ρ)` using the FFT
     pricer. ~50–100 surface points, converges in seconds.
   - **Merton:** LM on `(σ, λ, μ_J, σ_J)` using the Poisson-weighted BS sum.
   - **SLV:** LV first (closed form from the surface), then particle-method
     leverage calibration as one expensive step (web worker, progress bar).
4. Display residuals as a heatmap on the same `(K, T)` grid.

New file `v3/calibration.js` (main thread for LM driving, FFT pricing in a
worker so the UI stays responsive). Calibrated params get pushed back into
`state.model.params` exactly the way v2 already wires manual sliders.

---

## 6. Architecture deltas

These changes ripple through more than one file, so we list them up front.

### 6.1 Multi-state simulation

v2's `simulatePath(S0, grid, market, params, normals, out)` only carries `S`.
Heston/SLV need a vector state.

**Change:** add `model.stateDim` (default 1) and a `simulateState(S0, grid,
market, params, normalsMatrix, outState)` where `outState` is a flat
`Float64Array` of length `grid.length × stateDim`. Keep `simulatePath` as a
backwards-compatible wrapper that returns the `S` slice, so v2 products keep
working unchanged.

### 6.2 Variance-reduction hooks

Add optional `controlVariate(spec, market, modelParams)` on a product:

```
{ analyticPV, evaluateOnPath(grid, path) -> pvCV }
```

The MC engine subtracts `pvCV - analyticPV` from each path's PV — variance
drops, mean is unchanged. Geometric Asian is the first user.

### 6.3 Antithetic + Sobol (low-discrepancy)

In [mc-worker.js](../v2/mc-worker.js), wrap the normals generator. Two new
modes alongside the current pseudo-random path:

- **Antithetic:** for each path use `Z` and `-Z`, halving variance for
  payoff-symmetric products at no extra simulation cost.
- **Sobol + inverse-normal CDF:** add a small Sobol sequence (`v3/sobol.js`)
  with Owen scrambling. Big win on smooth payoffs (vanillas under Heston),
  modest on barriers.

User picks `pseudo / antithetic / sobol` from a new sampling dropdown.

### 6.4 Pricing-job manager

Right now each product UI calls `priceMonteCarlo` and tracks one worker. With
calibration we'll have N workers and want to cancel them as a group. New
`v3/jobs.js` — thin pool with `submit(job)`, `cancelAll(tag)`. Reuse it for
single-product MC too.

### 6.5 Surface inputs

A reusable component for editing a `(K, T)` matrix with paste-from-Excel
support, plus a heatmap renderer (extends [charts.js](../v2/charts.js)). Used
by LV input, calibration residuals, local-vol-after-Dupire visualization.

---

## 7. UI

- **New "Surface" card** in the inputs column, visible whenever the selected
  model needs one (LV, SLV) or the user opens calibration.
- **Per-product chart additions:**
  - Barriers: barrier-touch probability over time.
  - Asian: distribution of average vs spot at maturity.
  - Cliquet: per-period return histogram, capped/floored.
  - Variance swap: replication strip overlay on the smile.
- **Engine badge** in each product card: `analytic | MC pseudo | MC sobol |
  MC antithetic`, with stderr when applicable. Already partly there in v2 —
  generalize.
- Mobile: the calibration heatmap is a separate scroll region; the plan is
  to keep one card per row at <640px the way v2 already does.

---

## 8. File layout

Following v2's flat layout (it is working — don't over-engineer):

```
v3/
  index.html                 (extends v2 with calibration tab)
  app.js                     (state additions: surface, calibration result)
  styles.css                 (v2 + heatmap, residual cells, badge variants)
  core.js                    (re-exports v2 + new: complex-arith, fft helpers)
  models.js                  (GBM unchanged + heston, merton, localvol, slv)
  products.js                (v2 + barrier, asian, lookback, cliquet, varswap)
  engines.js                 (+ control-variate, sampling-mode plumbing)
  mc-worker.js               (sampling modes, multi-state)
  fft-worker.js              (Carr–Madan pricing for calibration)
  calibration.js             (LM driver, residuals, push-to-state)
  surface.js                 (IV surface model, Dupire, interpolation)
  transforms.js              (FFT, characteristic functions)
  sobol.js                   (Sobol + inverse-normal CDF)
  jobs.js                    (worker-pool wrapper)
  charts.js                  (v2 + heatmap, residual map, barrier-touch chart)
  ui-vanilla.js              (unchanged, except engine badge)
  ui-digital.js              (unchanged)
  ui-autocallable.js         (gains model picker — Heston/SLV runs)
  ui-barrier.js
  ui-asian.js
  ui-lookback.js
  ui-cliquet.js
  ui-varswap.js
  ui-calibration.js
  manifest.webmanifest, sw.js, icon.svg
```

---

## 9. Phasing

Each phase ends with the app demoably better than the previous phase. Pick up
where the previous phase left off — no big-bang merges.

**Phase 1 — Plumbing (smallest first).**
Multi-state simulation, control-variate hook, antithetic, jobs.js. No new
models or products yet. Verify by re-running v2 vanillas and seeing identical
prices.

**Phase 2 — Heston end-to-end.**
`transforms.js`, FFT pricer, Heston `simulateState`, plug into existing
`vanilla` and `digital` products. Add **autocallable under Heston** (the
existing MC product gets richer with no UI change). Sanity test against BS in
the `ξ → 0` limit.

**Phase 3 — Calibration.**
Surface input component, LM, residual heatmap. Heston-only at first; Merton
follows in days. **This is the headline feature of v3** — everything before it
is enabling work, everything after consumes the calibrated model.

**Phase 4 — Smile-sensitive products.**
v3 ships **Barriers** (closed form via Reiner–Rubinstein under GBM, MC under
Heston) and **Cliquet** (MC only, the demo product for "calibrate → price →
see how much the model choice matters"). Asian, lookback, and variance swap
are explicitly **deferred to v4** — see §12.

**Phase 5 — Local vol & SLV.**
Dupire from the calibrated/edited surface. SLV particle calibration. Visualize
local-vol slices and the SLV leverage function. Slowest phase — the particle
method is the only genuinely heavy piece of code in v3.

**Phase 6 — Sobol + polish.**
Sobol sampling, antithetic toggles per product, error budgets in the UI,
exportable reports. If multi-asset is going to ship in v3, it slots in here.

---

## 10. Risks and how we'll know

- **FFT correctness.** Easy to get integration-grid choices wrong. Mitigation:
  unit-test against BS at `ξ → 0` and against published Heston test cases on
  app start; show a visible warning if the self-test drifts.
- **Dupire stability near the wings.** Floor `σ_loc²`, refuse to extrapolate
  beyond the input surface, and *say so* in the UI — no silent garbage.
- **SLV calibration is slow.** Cap particle count and surface resolution; show
  a progress bar; let the user opt out (LV-only) if they don't want to wait.
- **Worker count on mobile.** `jobs.js` caps concurrency at
  `navigator.hardwareConcurrency - 1` (min 1) so we don't tank the UI thread
  on phones — same conservative posture v2 already takes.
- **Scope creep.** Multi-asset and rate dynamics are tempting but blow the
  scope. They are explicitly v4.

---

## 11. Definition of done for v3

- All four models (GBM, Heston, Merton, LV) price vanillas with closed form or
  semi-analytic, and price every product via MC.
- A user can paste an IV surface, click Calibrate, see Heston params and a
  residual heatmap within ~5 seconds on a recent laptop.
- A user can switch a cliquet between LV / Heston / SLV and see the price
  *move* — the whole point of v3.
- All v2 prices are reproduced exactly under GBM (regression, not regression-
  with-asterisks). The plumbing rewrite must be invisible to v2 users.

---

## 12. Deferred to v4

Items punted out of v3 to keep scope tight. Each is "ready to write" — the
plumbing is already in place, only the product/UI files are missing.

- **Asian options** (arithmetic and geometric average). MC only with the
  geometric-average control variate (the `controlVariate` hook on the product
  interface is already plumbed in `mc-worker.js` — just needs a producer). The
  control variate is the v4 demo for "MC variance reduction in action".
- **Lookback options** (fixed-strike and floating-strike, on min/max of the
  path). Closed form under GBM, MC otherwise. Sub-grid Brownian-bridge for
  the running max/min would shrink discretization bias — same hook a
  Brownian-bridge correction for barriers would use.
- **Variance swap & volatility swap.** Variance swap has a model-free strip
  replication that's a fun visual; volatility swap is MC-only with a convexity
  adjustment. Pairs naturally with the calibration card (use the calibrated
  Heston to price varswap, then check vs the strip price).
- **Brownian-bridge correction for barriers.** v3 ships barriers with a fine
  grid (252 obs/yr) and accepts the discrete-monitoring bias (~5–15% on short
  maturities). Adding the per-step bridge correction would close that gap and
  let users run barriers with much coarser grids.
- **Multi-asset / basket / worst-of.** Requires extending the model interface
  to `simulatePathsMulti`. Out of scope for v4 too unless a use case forces it.
