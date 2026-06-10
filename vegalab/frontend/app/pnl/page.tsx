"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import HeaderStrip from "@/components/HeaderStrip";
import { api, Bucket, BUCKETS } from "@/lib/api";
import { pct, signClass, signedUsd } from "@/lib/format";

// One color per bucket. Violet is the hedge MTM; green/red appear only in
// sign-coloured numbers, never as series colours.
const BUCKET_COLORS: Record<Bucket, string> = {
  delta_pnl: "#ffb454",
  gamma_pnl: "#e0af68",
  vega_pnl: "#5ac8d8",
  theta_pnl: "#7aa2f7",
  vanna_pnl: "#9d7cd8",
  charm_pnl: "#5a7ec8",
  volga_pnl: "#3d8fa8",
  hedge_pnl: "#b48ead",
  financing_pnl: "#8a93a8",
  residual_pnl: "#5c6a82",
};

const BUCKET_LABELS: Record<Bucket, string> = {
  delta_pnl: "DELTA",
  gamma_pnl: "GAMMA",
  vega_pnl: "VEGA",
  theta_pnl: "THETA",
  vanna_pnl: "VANNA",
  charm_pnl: "CHARM",
  volga_pnl: "VOLGA",
  hedge_pnl: "HEDGE",
  financing_pnl: "FINANCING",
  residual_pnl: "RESIDUAL",
};

export default function PnlPage() {
  const [granularity, setGranularity] = useState<"snapshot" | "daily">("snapshot");
  const q = useQuery({
    queryKey: ["pnl", granularity],
    queryFn: () => api.pnl(granularity),
  });

  const d = q.data;
  // Cumulative stacked series: each point carries running bucket sums.
  const series = (() => {
    if (!d) return [];
    const running = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
    let totalRun = 0;
    return d.series.map((p) => {
      const out: Record<string, number | string> = {
        t: granularity === "snapshot"
          ? (p.snapshot_ts ?? "").replace("T", " ").slice(5, 16)
          : (p.date ?? ""),
      };
      for (const b of BUCKETS) {
        running[b] += p[b];
        out[b] = running[b];
      }
      totalRun += p.total_pnl;
      out.total = totalRun;
      return out;
    });
  })();

  const totals = d?.season_totals;
  const explained =
    totals && Math.abs(totals.total_pnl) > 0
      ? 1 - Math.abs(totals.residual_pnl) / Math.max(Math.abs(totals.total_pnl), 100)
      : null;

  const bars = totals
    ? BUCKETS.map((b) => ({ name: BUCKET_LABELS[b], bucket: b, value: totals[b] }))
    : [];

  return (
    <>
      <HeaderStrip />
      <main className="p-3">
        <div className="mb-3 flex items-center gap-2">
          <span className="label">GRANULARITY</span>
          {(["snapshot", "daily"] as const).map((g) => (
            <button
              key={g}
              onClick={() => setGranularity(g)}
              className={`border px-2 py-1 text-[10px] uppercase tracking-[0.18em] ${
                granularity === g ? "border-amber text-amber" : "border-edge text-dim"
              }`}
            >
              {g}
            </button>
          ))}
        </div>

        {q.isLoading && <div className="panel h-64 animate-pulse" />}

        {d && d.series.length === 0 && (
          <div className="panel p-6 text-center text-dim">
            NO ATTRIBUTION YET — rows appear after the first snapshot cycle
            following your first trade.
          </div>
        )}

        {d && d.series.length > 0 && totals && (
          <>
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Card
                label="SEASON TOTAL"
                value={signedUsd(totals.total_pnl)}
                vClass={signClass(totals.total_pnl)}
              />
              <Card
                label="EXPLAINED"
                value={explained != null ? pct(explained) : "—"}
                vClass="text-iv"
                sub="1 − |residual| / max(|total|, $100)"
              />
              <Card
                label="HEDGE MTM"
                value={signedUsd(totals.hedge_pnl)}
                vClass="text-hedge"
              />
              <Card
                label="RESIDUAL"
                value={signedUsd(totals.residual_pnl)}
                vClass={signClass(-Math.abs(totals.residual_pnl))}
              />
            </div>

            <div className="panel p-3">
              <div className="label mb-2">CUMULATIVE ATTRIBUTION · STACKED BY BUCKET</div>
              <div className="h-64 sm:h-80">
                <ResponsiveContainer>
                  <AreaChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                    <CartesianGrid stroke="#1c2530" strokeDasharray="2 4" />
                    <XAxis
                      dataKey="t"
                      tick={{ fill: "#5c6a82", fontSize: 10, fontFamily: "monospace" }}
                      tickLine={false}
                      axisLine={{ stroke: "#1c2530" }}
                      minTickGap={40}
                    />
                    <YAxis
                      tick={{ fill: "#5c6a82", fontSize: 10, fontFamily: "monospace" }}
                      tickLine={false}
                      axisLine={{ stroke: "#1c2530" }}
                      tickFormatter={(v: number) => `${v >= 0 ? "" : "-"}$${Math.abs(v / 1000).toFixed(1)}k`}
                      width={56}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "#0f1419",
                        border: "1px solid #1c2530",
                        fontFamily: "monospace",
                        fontSize: 11,
                      }}
                      labelStyle={{ color: "#5c6a82" }}
                      formatter={(value, name) => [
                        signedUsd(Number(value)),
                        BUCKET_LABELS[name as Bucket] ?? name,
                      ]}
                    />
                    <ReferenceLine y={0} stroke="#5c6a82" />
                    {BUCKETS.map((b) => (
                      <Area
                        key={b}
                        type="stepAfter"
                        dataKey={b}
                        stackId="1"
                        stroke={BUCKET_COLORS[b]}
                        fill={BUCKET_COLORS[b]}
                        fillOpacity={0.45}
                        strokeWidth={1}
                        isAnimationActive={false}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {BUCKETS.map((b) => (
                  <span key={b} className="label flex items-center gap-1">
                    <span className="inline-block h-2 w-2" style={{ background: BUCKET_COLORS[b] }} />
                    {BUCKET_LABELS[b]}
                  </span>
                ))}
              </div>
            </div>

            <div className="panel mt-3 p-3">
              <div className="label mb-2">SEASON BUCKET BREAKDOWN</div>
              <div className="h-56">
                <ResponsiveContainer>
                  <BarChart data={bars} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                    <CartesianGrid stroke="#1c2530" strokeDasharray="2 4" />
                    <XAxis
                      dataKey="name"
                      tick={{ fill: "#5c6a82", fontSize: 9, fontFamily: "monospace" }}
                      tickLine={false}
                      axisLine={{ stroke: "#1c2530" }}
                      interval={0}
                      angle={-40}
                      textAnchor="end"
                      height={50}
                    />
                    <YAxis
                      tick={{ fill: "#5c6a82", fontSize: 10, fontFamily: "monospace" }}
                      tickLine={false}
                      axisLine={{ stroke: "#1c2530" }}
                      tickFormatter={(v: number) => `${v >= 0 ? "" : "-"}$${Math.abs(v / 1000).toFixed(1)}k`}
                      width={56}
                    />
                    <Tooltip
                      cursor={{ fill: "#1c2530", opacity: 0.4 }}
                      contentStyle={{
                        background: "#0f1419",
                        border: "1px solid #1c2530",
                        fontFamily: "monospace",
                        fontSize: 11,
                      }}
                      labelStyle={{ color: "#5c6a82" }}
                      formatter={(value) => [signedUsd(Number(value)), "SEASON"]}
                    />
                    <ReferenceLine y={0} stroke="#5c6a82" />
                    <Bar dataKey="value" isAnimationActive={false}>
                      {bars.map((b) => (
                        <Cell key={b.bucket} fill={BUCKET_COLORS[b.bucket as Bucket]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
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
  sub,
}: {
  label: string;
  value: string;
  vClass?: string;
  sub?: string;
}) {
  return (
    <div className="panel p-2.5">
      <div className="label">{label}</div>
      <div className={`mt-1 text-[15px] tabular-nums ${vClass}`}>{value}</div>
      {sub && <div className="label mt-0.5 normal-case tracking-normal">{sub}</div>}
    </div>
  );
}
