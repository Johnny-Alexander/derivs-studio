"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, ChainOption, TradeResponse } from "@/lib/api";
import { pct, prettySymbol, px, signClass, signedUsd, usd } from "@/lib/format";

export interface TicketSeed {
  option: ChainOption;
  side: "buy" | "sell";
}

const MULT = 100;
const SCENARIO_MOVES = [-0.02, -0.01, -0.005, 0, 0.005, 0.01, 0.02];

// Order ticket: fill preview, Greeks current/trade/after, scenario bars.
// Full-screen sheet on phones, right-hand slide-over on desktop.
export default function Ticket({ seed, onClose }: { seed: TicketSeed; onClose: () => void }) {
  const { option } = seed;
  const [side, setSide] = useState(seed.side);
  const [qty, setQty] = useState(1);
  const [fill, setFill] = useState<TradeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const positions = useQuery({ queryKey: ["positions"], queryFn: api.positions });
  const chainHead = useQuery({ queryKey: ["chain-meta"], queryFn: api.chainMeta });
  const spot = chainHead.data?.spot ?? positions.data?.spot ?? 0;

  const fillPx = side === "buy" ? option.ask : option.bid;
  const signedQty = side === "buy" ? qty : -qty;
  const cost = fillPx * qty * MULT;

  const trade = useMutation({
    mutationFn: () => api.trade(option.symbol, side, qty),
    onSuccess: (res) => {
      setFill(res);
      setError(null);
      qc.invalidateQueries({ queryKey: ["positions"] });
      qc.invalidateQueries({ queryKey: ["trades"] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : "trade failed — network?"),
  });

  const tradeGreeks = useMemo(
    () => ({
      delta: signedQty * MULT * option.delta,
      gamma: signedQty * MULT * option.gamma,
      theta: signedQty * MULT * option.theta,
      vega: signedQty * MULT * option.vega,
    }),
    [signedQty, option],
  );
  const current = positions.data?.net_greeks ?? { delta: 0, gamma: 0, theta: 0, vega: 0 };
  const after = {
    delta: current.delta + tradeGreeks.delta,
    gamma: current.gamma + tradeGreeks.gamma,
    theta: current.theta + tradeGreeks.theta,
    vega: current.vega + tradeGreeks.vega,
  };

  // Δ+½Γ estimate of this trade's PnL across spot scenarios.
  const scenarios = useMemo(() => {
    return SCENARIO_MOVES.map((m) => {
      const dS = spot * m;
      const pnl =
        signedQty * MULT * (option.delta * dS + 0.5 * option.gamma * dS * dS);
      return { move: m, pnl };
    });
  }, [signedQty, option, spot]);
  const maxAbs = Math.max(1, ...scenarios.map((s) => Math.abs(s.pnl)));

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-bg/70" onClick={onClose}>
      <div
        className="panel h-full w-full overflow-y-auto p-4 sm:max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between">
          <div>
            <div className="label">TICKET</div>
            <div className="text-base text-ink">{prettySymbol(option.symbol)}</div>
            <div className="label mt-0.5">
              IV <span className="text-iv">{pct(option.iv)}</span> · Δ {px(option.delta, 2)} ·
              MID {px(option.mid)}
              {option.synthetic_quote && <span className="ml-1 text-amber">⚠ SYNTHETIC</span>}
            </div>
          </div>
          <button onClick={onClose} className="label cursor-pointer hover:text-down">
            ✕ CLOSE
          </button>
        </div>

        <div className="mt-4 flex gap-2">
          {(["buy", "sell"] as const).map((s) => (
            <button
              key={s}
              onClick={() => { setSide(s); setFill(null); }}
              className={`flex-1 border px-3 py-2 text-[11px] uppercase tracking-[0.18em] ${
                side === s
                  ? s === "buy"
                    ? "border-up text-up"
                    : "border-down text-down"
                  : "border-edge text-dim"
              }`}
            >
              {s === "buy" ? `BUY @ ${px(option.ask)}` : `SELL @ ${px(option.bid)}`}
            </button>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span className="label">QTY</span>
          <button onClick={() => setQty((q) => Math.max(1, q - 1))} className="border border-edge px-3 py-1 hover:border-amber">−</button>
          <input
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            className="w-16 border border-edge bg-bg px-2 py-1 text-center tabular-nums outline-none focus:border-amber"
          />
          <button onClick={() => setQty((q) => q + 1)} className="border border-edge px-3 py-1 hover:border-amber">+</button>
          <span className="label ml-auto">×100 MULT</span>
        </div>

        <div className="panel mt-4 p-3">
          <div className="label mb-2">FILL PREVIEW</div>
          <Row k="FILL" v={`${qty} × ${px(fillPx)} (${side === "buy" ? "ask" : "bid"})`} />
          <Row
            k={side === "buy" ? "CASH OUT" : "CASH IN"}
            v={usd(cost, 2)}
            vClass={side === "buy" ? "text-down" : "text-up"}
          />
          <Row k="QUALITY" v={option.synthetic_quote ? "⚠ SYNTHETIC" : "REAL"} />
        </div>

        <div className="panel mt-3 p-3">
          <div className="label mb-2">GREEKS · CURRENT / TRADE / AFTER</div>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="label [&>th]:py-0.5 [&>th]:text-right [&>th]:font-normal">
                <th className="!text-left">·</th><th>CURRENT</th><th>TRADE</th><th>AFTER</th>
              </tr>
            </thead>
            <tbody>
              {(["delta", "gamma", "theta", "vega"] as const).map((k) => (
                <tr key={k} className="[&>td]:py-0.5 [&>td]:text-right [&>td]:tabular-nums">
                  <td className="label !text-left">{{ delta: "Δ", gamma: "Γ", theta: "Θ", vega: "𝒱" }[k]}</td>
                  <td>{current[k].toFixed(k === "gamma" ? 3 : 1)}</td>
                  <td className={signClass(tradeGreeks[k])}>{tradeGreeks[k].toFixed(k === "gamma" ? 3 : 1)}</td>
                  <td className="text-amber">{after[k].toFixed(k === "gamma" ? 3 : 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel mt-3 p-3">
          <div className="label mb-2">SCENARIO · TRADE PNL VS SPOT (Δ+½Γ EST)</div>
          {scenarios.map((s) => (
            <div key={s.move} className="mb-1 flex items-center gap-2">
              <span className="label w-12">{(s.move * 100).toFixed(1)}%</span>
              <div className="relative h-3 flex-1 bg-bg">
                <div className="absolute inset-y-0 left-1/2 w-px bg-edge" />
                <div
                  className={`absolute inset-y-0 ${s.pnl >= 0 ? "left-1/2 bg-up/70" : "bg-down/70"}`}
                  style={
                    s.pnl >= 0
                      ? { width: `${(s.pnl / maxAbs) * 50}%` }
                      : { right: "50%", width: `${(-s.pnl / maxAbs) * 50}%` }
                  }
                />
              </div>
              <span className={`w-20 text-right tabular-nums ${signClass(s.pnl)}`}>
                {signedUsd(s.pnl)}
              </span>
            </div>
          ))}
        </div>

        {fill ? (
          <div className="panel mt-3 border-up/40 p-3">
            <div className="label mb-1 text-up">FILLED</div>
            <Row k="TRADE" v={`#${fill.trade_id} ${fill.side.toUpperCase()} ${fill.qty} @ ${px(fill.fill_px)}`} />
            <Row k="QUALITY" v={fill.fill_quality === "synthetic" ? "⚠ SYNTHETIC" : "REAL"} />
            <Row k="POSITION" v={`${fill.position_qty} @ ${px(fill.position_avg_cost)}`} />
            <Row k="CASH" v={usd(fill.cash, 2)} />
          </div>
        ) : (
          <button
            onClick={() => trade.mutate()}
            disabled={trade.isPending}
            className={`mt-4 w-full border px-3 py-3 text-[11px] uppercase tracking-[0.18em] disabled:opacity-40 ${
              side === "buy"
                ? "border-up text-up hover:bg-up hover:text-bg"
                : "border-down text-down hover:bg-down hover:text-bg"
            }`}
          >
            {trade.isPending ? "sending…" : `${side} ${qty} @ ${px(fillPx)} · ${usd(cost, 2)}`}
          </button>
        )}
        {error && <div className="mt-2 text-[11px] text-down">{error.toUpperCase()}</div>}
      </div>
    </div>
  );
}

function Row({ k, v, vClass = "text-ink" }: { k: string; v: string; vClass?: string }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="label">{k}</span>
      <span className={`tabular-nums ${vClass}`}>{v}</span>
    </div>
  );
}
