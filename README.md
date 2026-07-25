# Derivs Studio

A browser-based derivatives pricer. No server, no build step — open
`v3/index.html` (or any version's `index.html`) and it runs.

## Layout

- **`black-scholes.html`** — the original single-file Black–Scholes calculator.
- **`v2/`** — multi-product pricer with a plugin architecture (models × products
  × engines): vanilla multi-leg, digital, autocallable. GBM only.
- **`v3/`** — adds Heston (Carr–Madan FFT + full-truncation Euler MC),
  multi-state simulation, antithetic sampling, a Levenberg–Marquardt
  calibrator, and a residual-heatmap UI. See [`v3/plan.md`](v3/plan.md) for
  the full expansion plan.
- **`v4/`** — in progress. Scaffolded from v3, targeting path-dependent
  payoffs (Asian, lookback, variance swap) priced against a calibrated
  surface, plus the Merton and SLV models v3 left as stubs. So far only the
  Poisson sampler underpinning Merton's jump steps has landed. See
  [`v4/plan.md`](v4/plan.md) for scope and phasing.

## Running locally

Each version is a static site. Launch a local HTTP server pointing at the
folder of the version you want:

```sh
cd v3
python3 -m http.server 8766
```

Then open <http://localhost:8766/>.

`.claude/launch.json` wires `preview_start` to small dev-server scripts
under `v2/.devserver.py`, `v3/.devserver.py` and `v4/.devserver.py` for use
with Claude Code (ports 8765, 8766 and 8767 respectively).

## Repository layout note

This repo lives at `~/Desktop/claude/derivs-studio/`. The parent `claude/`
folder is a plain container holding unrelated sibling projects (`vegalab/`,
`eq-fx-hybrid/`, `tk_gui_testing/`), each with its own git repo — the
container itself is deliberately **not** a repo, so nothing nests.

## Models in v3

- **GBM (Black–Scholes)** — closed-form for vanillas/digitals.
- **Heston** — Carr–Madan FFT pricer for vanillas, FT-Euler scheme for MC
  exotics. Calibrate `(v0, κ, θ, ξ, ρ)` from an implied-vol surface.
- **Local Vol / SLV** — stubs (planned for later phases).
