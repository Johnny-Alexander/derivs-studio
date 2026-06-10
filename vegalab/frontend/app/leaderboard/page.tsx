"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import HeaderStrip from "@/components/HeaderStrip";
import { api } from "@/lib/api";
import { pct, signClass, signedUsd } from "@/lib/format";

const METRICS = [
  { key: "pnl", label: "PNL" },
  { key: "sharpe", label: "SHARPE" },
  { key: "attribution", label: "ATTRIBUTION" },
] as const;

type Metric = (typeof METRICS)[number]["key"];

export default function LeaderboardPage() {
  const [metric, setMetric] = useState<Metric>("pnl");
  const q = useQuery({
    queryKey: ["leaderboard", metric],
    queryFn: () => api.leaderboard(metric),
  });

  return (
    <>
      <HeaderStrip />
      <main className="p-3">
        <div className="mb-3 flex gap-2">
          {METRICS.map((m) => (
            <button
              key={m.key}
              onClick={() => setMetric(m.key)}
              className={`border px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] ${
                metric === m.key ? "border-amber text-amber" : "border-edge text-dim"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {q.isLoading && <div className="panel h-40 animate-pulse" />}

        {q.data && (
          <div className="panel overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="label border-b border-edge [&>th]:px-2 [&>th]:py-1.5 [&>th]:text-right [&>th]:font-normal">
                  <th className="!text-left">#</th>
                  <th className="!text-left">PLAYER</th>
                  <th>{metric.toUpperCase()}</th>
                  <th>SEASON PNL</th>
                  <th>DAYS</th>
                </tr>
              </thead>
              <tbody>
                {q.data.standings.map((s) => (
                  <tr key={s.account_id} className="border-b border-edge/50">
                    <td className="cell !text-left text-dim">{s.rank}</td>
                    <td className={`cell !text-left ${s.rank === 1 ? "text-amber" : "text-ink"}`}>
                      {s.user.toUpperCase()}
                      {s.rank === 1 && <span className="label ml-2 text-amber">▲ LEAD</span>}
                    </td>
                    <td className="cell">
                      {s.value === null ? (
                        <span className="text-dim">—</span>
                      ) : metric === "pnl" ? (
                        <span className={signClass(s.value)}>{signedUsd(s.value)}</span>
                      ) : metric === "sharpe" ? (
                        <span className={signClass(s.value)}>{s.value.toFixed(2)}</span>
                      ) : (
                        <span className="text-iv">{pct(s.value)}</span>
                      )}
                    </td>
                    <td className={`cell ${signClass(s.season_pnl)}`}>
                      {signedUsd(s.season_pnl)}
                    </td>
                    <td className="cell text-dim">{s.trading_days}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {metric === "sharpe" && (
          <p className="label mt-3 max-w-xl normal-case leading-relaxed tracking-normal">
            Sharpe = mean(daily PnL) / stdev(daily PnL) × √252. Needs at least 5
            trading days — “—” means not enough history yet.
          </p>
        )}
        {metric === "attribution" && (
          <p className="label mt-3 max-w-xl normal-case leading-relaxed tracking-normal">
            Attribution accuracy scores how well your Greeks explain your PnL:
            per day, 1 − |residual| / max(|total|, $100), averaged over the
            season. Days under $100 of |total PnL| are excluded as noise. High
            score = your PnL came from the risks you meant to take.
          </p>
        )}
      </main>
    </>
  );
}
