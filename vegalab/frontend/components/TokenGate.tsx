"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, clearToken, getToken, setToken } from "@/lib/api";

const LogoutContext = createContext<() => void>(() => {});

// Token entry screen → localStorage → Bearer on all calls. Children render
// only once a token is present; a 401 from any screen calls `logout` below.

export default function TokenGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    setAuthed(Boolean(getToken()));
    setReady(true);
  }, []);

  if (!ready) return null;
  if (!authed) return <Login onAuthed={() => setAuthed(true)} />;
  return <LogoutContext.Provider value={() => setAuthed(false)}>{children}</LogoutContext.Provider>;
}

export function useLogout() {
  const qc = useQueryClient();
  const setLoggedOut = useContext(LogoutContext);
  return () => {
    clearToken();
    qc.clear();
    setLoggedOut();
  };
}

function Login({ onAuthed }: { onAuthed: () => void }) {
  const [token, setTokenInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setError(null);
    setToken(token.trim());
    try {
      await api.positions(); // any authed call validates the token
      onAuthed();
    } catch (err) {
      clearToken();
      setError(
        err instanceof ApiError && err.status === 401
          ? "INVALID TOKEN"
          : `BACKEND UNREACHABLE — ${err instanceof Error ? err.message : "unknown"}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="panel w-full max-w-sm p-6">
        <div className="mb-1 text-lg tracking-[0.3em] text-amber">VEGALAB</div>
        <div className="label mb-6">SPX league · delayed quotes · paper fills</div>
        <label className="label mb-2 block" htmlFor="token">
          API token
        </label>
        <input
          id="token"
          type="password"
          autoFocus
          value={token}
          onChange={(e) => setTokenInput(e.target.value)}
          className="mb-4 w-full border border-edge bg-bg px-3 py-2 text-ink outline-none focus:border-amber"
          placeholder="paste your bearer token"
        />
        <button
          type="submit"
          disabled={busy || !token.trim()}
          className="w-full border border-amber bg-bg px-3 py-2 text-[11px] uppercase tracking-[0.18em] text-amber hover:bg-amber hover:text-bg disabled:opacity-40"
        >
          {busy ? "checking…" : "log in"}
        </button>
        {error && <div className="mt-3 text-[11px] text-down">{error}</div>}
      </form>
    </main>
  );
}
