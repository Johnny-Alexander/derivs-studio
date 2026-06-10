// Typed client for the vegalab backend. The bearer token lives in
// localStorage (this is a real deployed Next.js app, not an artifact).

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const TOKEN_KEY = "vegalab_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json();
}

// ---- response shapes (mirror backend routes) ----

export interface ChainOption {
  symbol: string;
  root: string;
  expiry: string;
  strike: number;
  right: "C" | "P";
  bid: number;
  ask: number;
  mid: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  volume: number;
  open_interest: number;
  synthetic_quote: boolean;
}

export interface ChainResponse {
  snapshot_ts: string | null;
  fetched_at: string | null;
  spot: number | null;
  expiries: string[];
  options: ChainOption[];
}

export interface ChainMeta {
  snapshot_ts: string | null;
  fetched_at: string | null;
  spot: number | null;
  expiries: string[];
}

export interface PositionRow {
  symbol: string;
  expiry: string;
  strike: number;
  right: "C" | "P";
  qty: number;
  avg_cost: number;
  mark: number | null;
  unrealized_pnl: number | null;
  realized_pnl: number;
  synthetic_quote: boolean | null;
  opened_at: string;
}

export interface PositionsResponse {
  positions: PositionRow[];
  cash: number;
  starting_capital: number;
  equity: number;
  delta_hedge_notional: number;
  net_greeks: { delta: number; gamma: number; theta: number; vega: number };
  net_delta_incl_hedge: number;
  spot: number | null;
}

export const BUCKETS = [
  "delta_pnl",
  "gamma_pnl",
  "vega_pnl",
  "theta_pnl",
  "vanna_pnl",
  "charm_pnl",
  "volga_pnl",
  "hedge_pnl",
  "financing_pnl",
  "residual_pnl",
] as const;

export type Bucket = (typeof BUCKETS)[number];

export type PnlPoint = Record<Bucket, number> & {
  total_pnl: number;
  snapshot_ts?: string;
  date?: string;
};

export interface PnlResponse {
  granularity: "snapshot" | "daily";
  series: PnlPoint[];
  season_totals: Record<Bucket, number> & { total_pnl: number };
}

export interface Standing {
  rank: number;
  account_id: number;
  user: string;
  metric: string;
  value: number | null;
  season_pnl: number;
  trading_days: number;
}

export interface LeaderboardResponse {
  metric: string;
  standings: Standing[];
}

export interface TradeResponse {
  trade_id: number;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  fill_px: number;
  fill_quality: "real" | "synthetic";
  traded_at: string;
  position_qty: number;
  position_avg_cost: number;
  realized_pnl: number;
  cash: number;
}

export interface TradeRow {
  trade_id: number;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  fill_px: number;
  fill_quality: "real" | "synthetic";
  traded_at: string;
}

export interface HedgeResponse {
  account_delta_shares: number;
  target_delta: number;
  spot: number;
  delta_hedge_notional: number;
}

// ---- calls ----

export const api = {
  chainMeta: () => request<ChainMeta>("/chain/meta"),
  chain: (expiry?: string) =>
    request<ChainResponse>(`/chain${expiry ? `?expiry=${expiry}` : ""}`),
  positions: () => request<PositionsResponse>("/me/positions"),
  pnl: (granularity: "snapshot" | "daily" = "snapshot") =>
    request<PnlResponse>(`/me/pnl?granularity=${granularity}`),
  trades: () => request<TradeRow[]>("/me/trades"),
  leaderboard: (metric: string) =>
    request<LeaderboardResponse>(`/leaderboard?metric=${metric}`),
  trade: (symbol: string, side: "buy" | "sell", qty: number) =>
    request<TradeResponse>("/trade", {
      method: "POST",
      body: JSON.stringify({ symbol, side, qty }),
    }),
  hedgeDelta: (target_delta = 0) =>
    request<HedgeResponse>("/me/hedge_delta", {
      method: "POST",
      body: JSON.stringify({ target_delta }),
    }),
};
