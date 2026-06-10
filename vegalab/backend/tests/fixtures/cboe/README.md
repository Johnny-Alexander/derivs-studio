# CBOE fixture provenance

`_SPX_sample.json` is a **real capture** of
`https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json`, taken
2026-06-10 09:07:11 UTC (pre-market — quotes reflect the prior close book)
from a browser, since the dev sandbox's network allowlist blocks
`cdn.cboe.com` directly.

The full payload (31,362 options, ~14 MB) was trimmed to 28 rows chosen to
cover every data-quality path with real data:

- 18 survivors: calls + puts at the 3 strikes nearest spot (7386.65) for
  three expiries — SPXW 2026-06-10 (0 DTE), SPX 2026-06-18 (8 DTE),
  SPXW 2026-07-17 (37 DTE)
- 2 × `iv: 0.0` with live two-sided quotes → Brent solver path (survive)
- 2 × `bid: 0.0` far-OTM teenies → dropped on the ±15% moneyness filter
- 2 × both-sides-zero, 464 DTE → dropped on the 120-DTE filter
- 2 × |delta| > 0.99 deep-ITM puts → dropped on the delta band
- 2 × 128 DTE with good quotes → dropped on the 120-DTE filter

Expected outcome (asserted in `tests/test_cboe.py` with the clock frozen at
the capture instant): 20 survive, 0 synthetic, 8 dropped.

The capture had no in-universe rows needing bid synthesis (the zero-bid
rows all live in the far wings), so the synthesis paths are exercised by
constructed rows in `tests/test_cboe.py` / `tests/test_quality.py` instead.
