"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import HeaderStrip from "@/components/HeaderStrip";
import { api, ApiError } from "@/lib/api";
import { prettySymbol, px, signClass, signedUsd, usd } from "@/lib/format";

export default function PositionsPage() {
  const qc = useQueryClient();
  const [hedgeMsg, setHedgeMsg] = useState<string | null>(null);

  const q = useQuery({ queryKey: ["positions"], queryFn: api.positions });
  const trades = useQuery({ queryKey: ["trades"], queryFn: api.trades });

  const flatten = useMutation({
    mutationFn: () => api.hedgeDelta(0),
    onSuccess: (res) => {
      setHedgeMsg(
        `HEDGED ${signedUsd(res.delta_hedge_notional)} NOTIONAL @ SPX ${px(res.spot)}`,
      );
      qc.invalidateQueries({ queryKey: ["positions"] });
    },
    onError: (err) =>
      setHedgeMsg(
        `HEDGE REJECTED — ${err instanceof ApiError ? err.message.toUpperCase() : "NETWORK"}`,
      ),
  });

  const d = q.data;
  const g = d?.net_greeks;

  return (
    <>
      <HeaderStrip />
      <main className="p-3">
        {q.isLoading && <div className="panel h-32 animate-pulse" />}

        {d && (
          <>
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              <Card label="EQUITY" value={usd(d.equity)} />
              <Card label="CASH" value={usd(d.cash)} />
              <Card
                label="NET Δ (INCL HEDGE)"
                value={d.net_delta_incl_hedge.toFixed(1)}
                vClass={signClass(d.net_delta_incl_hedge)}
              />
              <Card label="NET Γ" value={(g?.gamma ?? 0).toFixed(3)} vClass={signClass(g?.gamma)} />
              <Card label="NET Θ" value={(g?.theta ?? 0).toFixed(0)} vClass={signClass(g?.theta)} />
              <Card label="NET 𝒱" value={(g?.vega ?? 0).toFixed(0)} vClass={signClass(g?.vega)} />
              <Card
                label="MARK PNL"
                value={signedUsd(d.equity - d.starting_capital)}
                vClass={signClass(d.equity - d.starting_capital)}
              />
            </div>

            <div className="panel mb-3 flex flex-wrap items-center gap-3 p-3">
              <div>
                <div className="label">HEDGE PANEL · SYNTHETIC SPX</div>
                <div className="mt-1 tabular-nums">
                  NOTIONAL{" "}
                  <span className={signClass(d.delta_hedge_notional)}>
                    {usd(d.delta_hedge_notional)}
                  </span>
                  {d.spot != null && d.delta_hedge_notional !== 0 && (
                    <span className="label ml-2">
                      ≈ {(d.delta_hedge_notional / d.spot).toFixed(1)} SHARE-EQUIV Δ
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => flatten.mutate()}
                disabled={flatten.isPending}
                className="ml-auto border border-amber px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-amber hover:bg-amber hover:text-bg disabled:opacity-40"
              >
                {flatten.isPending ? "hedging…" : "FLATTEN DELTA"}
              </button>
              {hedgeMsg && <div className="label w-full text-amber">{hedgeMsg}</div>}
            </div>

            {d.positions.length === 0 ? (
              <div className="panel p-6 text-center text-dim">
                NO OPEN POSITIONS — hit the CHAIN tab and click a quote.
              </div>
            ) : (
              <div className="panel overflow-x-auto">
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr className="label border-b border-edge [&>th]:px-2 [&>th]:py-1 [&>th]:text-right [&>th]:font-normal">
                      <th className="!text-left">INSTRUMENT</th>
                      <th>QTY</th><th>AVG</th><th>MARK</th>
                      <th>UNREAL</th><th>REAL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.positions.map((p) => (
                      <tr key={p.symbol} className="border-b border-edge/50">
                        <td className="cell !text-left">
                          {prettySymbol(p.symbol)}
                          {p.synthetic_quote && <span className="ml-1 text-amber/70">⚠</span>}
                        </td>
                        <td className={`cell ${signClass(p.qty)}`}>
                          {p.qty > 0 ? `+${p.qty}` : p.qty}
                        </td>
                        <td className="cell">{px(p.avg_cost)}</td>
                        <td className="cell">{px(p.mark)}</td>
                        <td className={`cell ${signClass(p.unrealized_pnl)}`}>
                          {signedUsd(p.unrealized_pnl)}
                        </td>
                        <td className={`cell ${signClass(p.realized_pnl)}`}>
                          {signedUsd(p.realized_pnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="label mb-1 mt-4">TRADE BLOTTER</div>
            {trades.data && trades.data.length === 0 && (
              <div className="panel p-4 text-center text-dim">NO FILLS YET.</div>
            )}
            {trades.data && trades.data.length > 0 && (
              <div className="panel overflow-x-auto">
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr className="label border-b border-edge [&>th]:px-2 [&>th]:py-1 [&>th]:text-right [&>th]:font-normal">
                      <th className="!text-left">TIME (UTC)</th>
                      <th className="!text-left">INSTRUMENT</th>
                      <th>SIDE</th><th>QTY</th><th>FILL</th><th>QUALITY</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.data.map((t) => (
                      <tr key={t.trade_id} className="border-b border-edge/50">
                        <td className="cell !text-left text-dim">
                          {t.traded_at.replace("T", " ").slice(0, 16)}
                        </td>
                        <td className="cell !text-left">{prettySymbol(t.symbol)}</td>
                        <td className={`cell ${t.side === "buy" ? "text-up" : "text-down"}`}>
                          {t.side.toUpperCase()}
                        </td>
                        <td className="cell">{t.qty}</td>
                        <td className="cell">{px(t.fill_px)}</td>
                        <td className="cell">
                          {t.fill_quality === "synthetic" ? (
                            <span className="text-amber/80">⚠ SYN</span>
                          ) : (
                            <span className="text-dim">REAL</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}

function Card({
  label,
  value,
  vClass = "text-ink",
}: {
  label: string;
  value: string;
  vClass?: string;
}) {
  return (
    <div className="panel p-2.5">
      <div className="label">{label}</div>
      <div className={`mt-1 text-[15px] tabular-nums ${vClass}`}>{value}</div>
    </div>
  );
}
