// Terminal-style number formatting: fixed widths, explicit signs on PnL.

export function px(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  return v.toFixed(dp);
}

export function usd(v: number | null | undefined, dp = 0): string {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

export function signedUsd(v: number | null | undefined, dp = 0): string {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  return `${v >= 0 ? "+" : "-"}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

export function pct(v: number | null | undefined, dp = 1): string {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  return `${(v * 100).toFixed(dp)}%`;
}

export function signClass(v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0) return "text-ink";
  return v > 0 ? "text-up" : "text-down";
}

export function quoteAge(fetchedAt: string | null | undefined): string {
  if (!fetchedAt) return "NO DATA";
  const iso = /Z|[+-]\d{2}:?\d{2}$/.test(fetchedAt) ? fetchedAt : `${fetchedAt}Z`;
  const t = new Date(iso);
  const mins = Math.max(0, Math.round((Date.now() - t.getTime()) / 60_000));
  const hhmm = t.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `DELAYED 15m · as of ${hhmm} (${mins}m ago)`;
}

export function prettySymbol(symbol: string): string {
  // SPXW260710C06000000 -> SPXW 10JUL26 6000 C
  const m = symbol.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return symbol;
  const [, root, yy, mm, dd, right, strike8] = m;
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const strike = parseInt(strike8, 10) / 1000;
  return `${root} ${dd}${months[parseInt(mm, 10) - 1]}${yy} ${strike} ${right}`;
}

export function shortExpiry(expiry: string): string {
  const [y, m, d] = expiry.split("-").map(Number);
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  return `${String(d).padStart(2, "0")}${months[m - 1]}${String(y).slice(2)}`;
}
