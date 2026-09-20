"use client";

import { useEffect, useState } from "react";
import ChatView from "@/components/ChatView";
import Dashboard from "@/components/Dashboard";

type Config = { provider: string; model: string; devTools: boolean };

export default function AppShell({ authEnabled }: { authEnabled: boolean }) {
  const [tab, setTab] = useState<"chat" | "dashboard">("chat");
  const [config, setConfig] = useState<Config | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    window.location.reload(); // the server renders the login screen for a visitor without a session
  };

  const tabBtn = (t: typeof tab, label: string) => (
    <button
      onClick={() => setTab(t)}
      role="tab"
      aria-selected={tab === t}
      className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${tab === t ? "bg-white/10 text-zinc-50 shadow-sm" : "text-zinc-500 hover:text-zinc-300"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-screen flex-col text-zinc-200">
      <header className="flex items-center gap-5 px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-emerald-400 to-sky-500 text-sm font-bold text-zinc-950">C</span>
          <h1 className="text-[15px] font-semibold tracking-tight text-zinc-50">Consolidate</h1>
          <span className="hidden text-xs text-zinc-600 sm:inline">send Claude less, keep the answer</span>
        </div>
        <nav role="tablist" className="ml-2 flex gap-0.5 rounded-xl bg-black/30 p-1 ring-1 ring-white/[0.06]">
          {tabBtn("chat", "Chat")}
          {tabBtn("dashboard", "Dashboard")}
        </nav>
        {config && <span className="ml-auto hidden text-[11px] text-zinc-600 md:inline">{config.provider} · {config.model}</span>}
        {authEnabled && (
          <button onClick={() => void logout()} className={`rounded-lg px-3 py-1.5 text-xs text-zinc-400 ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.05] hover:text-zinc-100 ${config ? "" : "ml-auto"}`}>
            Log out
          </button>
        )}
      </header>
      <main className="min-h-0 flex-1 px-5 pb-5">
        <div className={tab === "chat" ? "h-full" : "hidden"}>
          <ChatView config={config} />
        </div>
        {tab === "dashboard" && (
          <div className="h-full overflow-y-auto">
            <Dashboard active={tab === "dashboard"} />
          </div>
        )}
      </main>
    </div>
  );
}
