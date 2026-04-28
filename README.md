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

## Running locally

Each version is a static site. Launch a local HTTP server pointing at the
folder of the version you want:

```sh
cd v3
python3 -m http.server 8766
```

Then open <http://localhost:8766/>.

`.claude/launch.json` wires `preview_start` to small dev-server scripts
under `v2/.devserver.py` and `v3/.devserver.py` for use with Claude Code.

## Models in v3

- **GBM (Black–Scholes)** — closed-form for vanillas/digitals.
- **Heston** — Carr–Madan FFT pricer for vanillas, FT-Euler scheme for MC
  exotics. Calibrate `(v0, κ, θ, ξ, ρ)` from an implied-vol surface.
- **Local Vol / SLV** — stubs (planned for later phases).
