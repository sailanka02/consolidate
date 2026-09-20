"use client";

import { useState } from "react";
import { Panel, Spinner } from "./ui";

// Shown by the server to any visitor without a valid session. The password is checked server-side; nothing about it lives in this bundle.
export default function LoginScreen() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Sign-in failed (HTTP ${res.status})`);
      window.location.reload(); // the server now sees the session cookie and renders the app
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-screen place-items-center px-5">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-emerald-400 to-sky-500 text-base font-bold text-zinc-950">C</span>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-50">Consolidate</h1>
        </div>
        <Panel className="p-7">
          <form onSubmit={submit} className="space-y-4">
            <div>
              <p className="text-sm font-medium text-zinc-100">Demo access</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">Enter the demo password to open Consolidate.</p>
            </div>
            <label className="block">
              <span className="sr-only">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                autoComplete="current-password"
                placeholder="Password"
                aria-label="Password"
                className="w-full rounded-xl bg-zinc-950/70 px-3.5 py-2.5 text-sm text-zinc-100 outline-none ring-1 ring-white/[0.08] transition placeholder:text-zinc-600 focus:ring-sky-500/50"
              />
            </label>
            {error && (
              <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-200 ring-1 ring-red-500/25">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy || !password} className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-sky-500 to-sky-600 px-3 py-2.5 text-sm font-semibold text-white shadow-lg shadow-sky-900/30 transition hover:from-sky-400 hover:to-sky-600 disabled:opacity-40">
              {busy && <Spinner className="!border-white/30 !border-t-white" />} Sign in
            </button>
          </form>
        </Panel>
        <p className="mt-4 text-center text-[11px] text-zinc-600">Private demo. Conversations and usage are stored on the server.</p>
      </div>
    </main>
  );
}
