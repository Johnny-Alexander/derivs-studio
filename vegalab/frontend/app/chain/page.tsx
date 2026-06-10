"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import HeaderStrip from "@/components/HeaderStrip";
import Ticket, { TicketSeed } from "@/components/Ticket";
import { api, ChainOption } from "@/lib/api";
import { pct, px, shortExpiry } from "@/lib/format";

export default function ChainPage() {
  const [expiry, setExpiry] = useState<string | null>(null);
  const [ticket, setTicket] = useState<TicketSeed | null>(null);

  const head = useQuery({ queryKey: ["chain-meta"], queryFn: api.chainMeta });
  const expiries = head.data?.expiries ?? [];
  const activeExpiry = expiry ?? expiries[0] ?? null;

  const chain = useQuery({
    queryKey: ["chain", activeExpiry],
    queryFn: () => api.chain(activeExpiry ?? undefined),
    enabled: activeExpiry !== null,
  });

  const spot = chain.data?.spot ?? head.data?.spot ?? null;

  const rows = useMemo(() => {
    const byStrike = new Map<number, { call?: ChainOption; put?: ChainOption }>();
    for (const o of chain.data?.options ?? []) {
      const entry = byStrike.get(o.strike) ?? {};
      if (o.right === "C") entry.call = o;
      else entry.put = o;
      byStrike.set(o.strike, entry);
    }
    return [...byStrike.entries()].sort(([a], [b]) => a - b);
  }, [chain.data]);

  const atmStrike = useMemo(() => {
    if (spot == null || rows.length === 0) return null;
    return rows.reduce(
      (best, [k]) => (Math.abs(k - spot) < Math.abs(best - spot) ? k : best),
      rows[0][0],
    );
  }, [rows, spot]);

  // Center the chain on ATM when an expiry loads (once per expiry).
  const atmRef = useRef<HTMLTableRowElement | null>(null);
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (atmStrike != null && activeExpiry && scrolledFor.current !== activeExpiry) {
      scrolledFor.current = activeExpiry;
      atmRef.current?.scrollIntoView({ block: "center" });
    }
  }, [atmStrike, activeExpiry]);

  return (
    <>
      <HeaderStrip />
      <main className="p-3">
        <div className="mb-2 flex items-center gap-2 overflow-x-auto">
          <span className="label shrink-0">EXPIRY</span>
          {expiries.map((e) => (
            <button
              key={e}
              onClick={() => setExpiry(e)}
              className={`shrink-0 border px-2 py-1 text-[10px] uppercase tracking-[0.18em] ${
                e === activeExpiry
                  ? "border-amber text-amber"
                  : "border-edge text-dim hover:text-ink"
              }`}
            >
              {shortExpiry(e)}
            </button>
          ))}
          {head.isLoading && <span className="label">loading…</span>}
        </div>

        {head.data && expiries.length === 0 && (
          <div className="panel p-6 text-center text-dim">
            NO MARKET DATA YET — waiting for the first snapshot cycle.
          </div>
        )}

        {chain.isLoading && activeExpiry && <Skeleton />}

        {rows.length > 0 && (
          <div className="panel overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-edge">
                  <th colSpan={6} className="label py-1 text-center">CALLS</th>
                  <th className="label py-1 text-center">STRIKE</th>
                  <th colSpan={6} className="label py-1 text-center">PUTS</th>
                </tr>
                <tr className="label border-b border-edge [&>th]:px-2 [&>th]:py-1 [&>th]:text-right [&>th]:font-normal">
                  <th>VOL</th><th>OI</th><th>Δ</th><th>IV</th><th>BID</th><th>ASK</th>
                  <th className="!text-center">·</th>
                  <th>BID</th><th>ASK</th><th>IV</th><th>Δ</th><th>OI</th><th>VOL</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([strike, { call, put }]) => {
                  const atm = strike === atmStrike;
                  return (
                    <tr
                      key={strike}
                      ref={atm ? atmRef : undefined}
                      className={`border-b border-edge/50 ${atm ? "bg-amber/5" : ""}`}
                    >
                      <td className="cell text-dim">{call?.volume ?? "—"}</td>
                      <td className="cell text-dim">{call?.open_interest ?? "—"}</td>
                      <td className="cell">{call ? px(call.delta, 2) : "—"}</td>
                      <td className="cell text-iv">{call ? pct(call.iv) : "—"}</td>
                      <QuoteCell o={call} side="sell" onPick={setTicket} />
                      <QuoteCell o={call} side="buy" onPick={setTicket} />
                      <td
                        className={`cell !text-center font-bold ${
                          atm ? "text-amber" : "text-ink"
                        }`}
                      >
                        {strike}
                      </td>
                      <QuoteCell o={put} side="sell" onPick={setTicket} />
                      <QuoteCell o={put} side="buy" onPick={setTicket} />
                      <td className="cell text-iv">{put ? pct(put.iv) : "—"}</td>
                      <td className="cell">{put ? px(put.delta, 2) : "—"}</td>
                      <td className="cell text-dim">{put?.open_interest ?? "—"}</td>
                      <td className="cell text-dim">{put?.volume ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="label mt-2">
          click a BID to sell · an ASK to buy · ⚠ = synthesized quote
        </div>
      </main>

      {ticket && <Ticket seed={ticket} onClose={() => setTicket(null)} />}
    </>
  );
}

function QuoteCell({
  o,
  side,
  onPick,
}: {
  o?: ChainOption;
  side: "buy" | "sell";
  onPick: (seed: TicketSeed) => void;
}) {
  if (!o) return <td className="cell text-dim">—</td>;
  const value = side === "sell" ? o.bid : o.ask;
  return (
    <td
      className="cell clickable-quote"
      onClick={() => onPick({ option: o, side })}
      title={`${side} ${o.symbol}`}
    >
      {o.synthetic_quote && <span className="mr-0.5 text-amber/70">⚠</span>}
      {px(value)}
    </td>
  );
}

function Skeleton() {
  return (
    <div className="panel p-3">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="mb-1.5 h-4 animate-pulse bg-edge/60" />
      ))}
    </div>
  );
}
