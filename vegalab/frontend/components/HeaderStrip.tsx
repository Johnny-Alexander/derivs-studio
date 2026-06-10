"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { px, quoteAge, signClass, usd } from "@/lib/format";
import { useLogout } from "./TokenGate";

const TABS = [
  { href: "/chain", label: "CHAIN" },
  { href: "/positions", label: "POSITIONS" },
  { href: "/pnl", label: "PNL" },
  { href: "/leaderboard", label: "LEADERBOARD" },
];

// Persistent header: spot, quote age, equity, net Δ Γ Θ 𝒱 — always visible,
// wraps to two rows on phones.
export default function HeaderStrip() {
  const pathname = usePathname();
  const logout = useLogout();
  const chain = useQuery({ queryKey: ["chain-meta"], queryFn: api.chainMeta });
  const positions = useQuery({ queryKey: ["positions"], queryFn: api.positions });

  const spot = positions.data?.spot ?? chain.data?.spot;
  const g = positions.data?.net_greeks;

  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-panel">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
        <span className="tracking-[0.3em] text-amber">VEGALAB</span>
        <Stat label="SPX" value={spot != null ? px(spot) : "—"} valueClass="text-ink" />
        <span className="label">{quoteAge(chain.data?.fetched_at)}</span>
        <Stat
          label="EQUITY"
          value={positions.data ? usd(positions.data.equity) : "—"}
          valueClass="text-ink"
        />
        <div className="flex items-center gap-3">
          <Greek sym="Δ" value={positions.data?.net_delta_incl_hedge} dp={1} />
          <Greek sym="Γ" value={g?.gamma} dp={2} />
          <Greek sym="Θ" value={g?.theta} dp={0} />
          <Greek sym="𝒱" value={g?.vega} dp={0} />
        </div>
        <button
          onClick={logout}
          className="label ml-auto cursor-pointer hover:text-down"
          title="forget token"
        >
          LOGOUT
        </button>
      </div>
      <nav className="flex gap-0 overflow-x-auto border-t border-edge">
        {TABS.map((t) => {
          const active = pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`px-4 py-2 text-[10px] uppercase tracking-[0.18em] ${
                active
                  ? "border-b-2 border-amber text-amber"
                  : "text-dim hover:text-ink"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

function Stat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass: string;
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="label">{label}</span>
      <span className={`tabular-nums ${valueClass}`}>{value}</span>
    </span>
  );
}

function Greek({ sym, value, dp }: { sym: string; value?: number; dp: number }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="label">{sym}</span>
      <span className={`tabular-nums ${value != null ? signClass(value) : "text-dim"}`}>
        {value != null ? value.toFixed(dp) : "—"}
      </span>
    </span>
  );
}
