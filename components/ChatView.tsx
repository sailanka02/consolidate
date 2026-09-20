"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import TraceView from "./TraceView";
import { Spinner } from "./ui";
import { reloadIfUnauthorized } from "@/lib/client";
import type { ChatMessage, ContextTrace as Trace, Conversation } from "@/lib/types";

type Config = { provider: string; model: string; devTools: boolean };
const LAST_KEY = "consolidate:lastConversation";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  reloadIfUnauthorized(res);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

type TurnOut = { userMessage: ChatMessage; assistantMessage: ChatMessage; trace: Trace };

// POSTs a turn with stream:true and reads newline-delimited JSON events: stage | delta | reset | generated | result | error.
type StageEvent = { stage: "understanding" | "selecting" | "building" | "responding" | "retrying" | "checking"; level?: "optimized" | "regenerated" | "expanded" | "full" };

async function streamTurn(convId: string, body: Record<string, unknown>, on: { delta: (t: string) => void; reset: () => void; answered: () => void; stage: (e: StageEvent) => void }): Promise<TurnOut> {
  const res = await fetch(`/api/conversations/${convId}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, stream: true }) });
  reloadIfUnauthorized(res);
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let out: TurnOut | null = null;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const e = JSON.parse(line);
    if (e.type === "delta") on.delta(e.text);
    else if (e.type === "reset") on.reset();
    else if (e.type === "generated") on.answered();
    else if (e.type === "stage") on.stage(e as StageEvent);
    else if (e.type === "error") throw new Error(e.error ?? "Request failed");
    else if (e.type === "result") out = e as TurnOut;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    lines.forEach(handle);
  }
  handle(buf);
  if (!out) throw new Error("The response stream ended before a result arrived.");
  return out;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });

export default function ChatView({ config }: { config: Config | null }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<string | null>(null); // optimistic user message
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [traceRunId, setTraceRunId] = useState<string | null>(null);
  const [force, setForce] = useState<"" | "optimized" | "all">("");
  const [benchmark, setBenchmark] = useState(false);
  const [streamed, setStreamed] = useState(""); // answer text as it arrives (replaced by the saved message when the turn ends)
  const [step, setStep] = useState<StageEvent>({ stage: "understanding" });
  const [ready, setReady] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const started = useRef(false); // StrictMode runs effects twice in dev; create at most one conversation

  const showRun = useCallback(async (runId: string) => {
    setTraceRunId(runId);
    try {
      const { trace } = await api<{ trace: Trace }>(`/api/runs/${runId}`);
      setTrace(trace);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load trace");
    }
  }, []);

  const open = useCallback(
    async (id: string) => {
      setActiveId(id);
      setError(null);
      setTrace(null);
      setTraceRunId(null);
      try {
        localStorage.setItem(LAST_KEY, id);
      } catch {}
      const { messages } = await api<{ messages: ChatMessage[] }>(`/api/conversations/${id}`);
      setMessages(messages);
      const lastRun = [...messages].reverse().find((m) => m.runId)?.runId;
      if (lastRun) await showRun(lastRun);
    },
    [showRun],
  );

  const create = useCallback(async () => {
    const { conversation } = await api<{ conversation: Conversation }>("/api/conversations", { method: "POST" });
    setConversations((c) => [conversation, ...c]);
    setMessages([]);
    setTrace(null);
    setTraceRunId(null);
    setActiveId(conversation.id);
    try {
      localStorage.setItem(LAST_KEY, conversation.id);
    } catch {}
    return conversation.id;
  }, []);

  // Initial load: reopen the last conversation, or start a fresh empty one.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const { conversations } = await api<{ conversations: Conversation[] }>("/api/conversations");
        setConversations(conversations);
        let last: string | null = null;
        try {
          last = localStorage.getItem(LAST_KEY);
        } catch {}
        const target = conversations.find((c) => c.id === last) ?? conversations[0];
        if (target) await open(target.id);
        else await create();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load conversations");
      } finally {
        setReady(true);
      }
    })();
  }, [open, create]);

  // Follow new messages smoothly; follow streamed text instantly so it does not fight the animation.
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending, busy, step]);
  useEffect(() => {
    if (streamed) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [streamed]);

  const send = async () => {
    const content = input.trim();
    if (!content || busy || !activeId) return;
    setBusy(true);
    setError(null);
    const runBenchmark = benchmark;
    setBenchmark(false); // one-shot: benchmark mode costs extra, so it never stays on for the next message
    setPending(content);
    setInput("");
    setStreamed("");
    setStep({ stage: "understanding" });
    try {
      const out = await streamTurn(activeId, { content, forceEvalFailure: force || undefined, benchmark: runBenchmark || undefined }, {
        delta: (t) => setStreamed((x) => x + t),
        reset: () => setStreamed(""), // a retry is starting: the streamed draft is being replaced
        answered: () => setStep((x) => ({ stage: "checking", level: x.level })),
        stage: setStep,
      });
      setMessages((m) => [...m, out.userMessage, out.assistantMessage]);
      setTrace(out.trace);
      setTraceRunId(out.assistantMessage.runId ?? null);
      const { conversations } = await api<{ conversations: Conversation[] }>("/api/conversations");
      setConversations(conversations);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      setInput(content); // nothing was saved: give the text back
    } finally {
      setPending(null);
      setStreamed("");
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this conversation and its memory and run history?")) return;
    await api(`/api/conversations/${id}`, { method: "DELETE" });
    const rest = conversations.filter((c) => c.id !== id);
    setConversations(rest);
    if (id === activeId) {
      if (rest[0]) await open(rest[0].id);
      else await create();
    }
  };

  const active = conversations.find((c) => c.id === activeId);

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[250px_minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl bg-zinc-900/50 ring-1 ring-white/[0.06]">
        <div className="p-3">
          <button
            onClick={() => void create().catch((e) => setError(e.message))}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-sky-500 to-sky-600 px-3 py-2.5 text-sm font-semibold text-white shadow-lg shadow-sky-900/30 transition hover:from-sky-400 hover:to-sky-600 active:scale-[0.99] disabled:opacity-40"
          >
            <span className="text-base leading-none">＋</span> New chat
          </button>
        </div>
        <p className="px-4 pb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-600">Conversations</p>
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {conversations.length === 0 && ready && <li className="px-3 py-4 text-xs text-zinc-600">No conversations yet.</li>}
          {conversations.map((c) => (
            <li key={c.id} className="group relative">
              <button
                onClick={() => !busy && void open(c.id)}
                className={`block w-full rounded-xl px-3 py-2 pr-7 text-left transition-colors ${c.id === activeId ? "bg-white/[0.07] text-zinc-100" : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"}`}
              >
                <span className="block truncate text-[13px]">{c.title}</span>
                <span className="text-[10px] text-zinc-600">{day(c.updatedAt)} · {time(c.updatedAt)}</span>
              </button>
              <button onClick={() => void remove(c.id)} disabled={busy} title="Delete conversation" aria-label="Delete conversation" className="absolute right-1.5 top-2 rounded p-1 text-zinc-700 opacity-0 transition hover:text-red-400 group-hover:opacity-100">
                ✕
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex min-h-[70vh] min-w-0 flex-col overflow-hidden rounded-2xl bg-zinc-900/40 ring-1 ring-white/[0.06] lg:min-h-0">
        <header className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-3.5">
          <h2 className="truncate text-sm font-semibold text-zinc-100">{active?.title ?? "Chat"}</h2>
          {config && <span className="shrink-0 text-[11px] text-zinc-600">{config.model}</span>}
        </header>
        <div ref={scroller} className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {!ready && (
            <div className="space-y-3" aria-busy>
              {[64, 96, 48].map((h) => <div key={h} className="animate-pulse rounded-2xl bg-white/[0.03]" style={{ height: h, width: h === 96 ? "80%" : "55%", marginLeft: h === 48 ? "auto" : 0 }} />)}
            </div>
          )}
          {ready && messages.length === 0 && !pending && (
            <div className="mx-auto mt-16 max-w-sm text-center">
              <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-sky-500/10 text-xl text-sky-300 ring-1 ring-sky-500/25">✦</div>
              <p className="text-base font-semibold text-zinc-100">Start a conversation</p>
              <p className="mt-1.5 text-sm leading-relaxed text-zinc-500">Ask anything. Behind the scenes Consolidate trims the history sent to Claude, and the trace on the right shows exactly what it did.</p>
            </div>
          )}
          {messages.map((m) => (
            <Bubble key={m.id} m={m} selected={!!m.runId && m.runId === traceRunId} onTrace={() => m.runId && void showRun(m.runId)} />
          ))}
          {pending && <Bubble m={{ id: "pending", conversationId: "", role: "user", content: pending, createdAt: new Date().toISOString(), localTokenEstimate: 0 }} />}
          {busy && streamed && <Bubble streaming m={{ id: "streaming", conversationId: "", role: "assistant", content: streamed, createdAt: new Date().toISOString(), localTokenEstimate: 0 }} />}
          {busy && <Progress step={step} answering={!!streamed} />}
        </div>
        <div className="space-y-2.5 border-t border-white/[0.06] p-4">
          {error && (
            <div role="alert" className="flex items-start justify-between gap-3 rounded-xl bg-red-500/10 px-3.5 py-2.5 text-xs text-red-200 ring-1 ring-red-500/25">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="text-red-300/70 hover:text-red-200" aria-label="Dismiss error">✕</button>
            </div>
          )}
          <div className="flex items-end gap-2 rounded-2xl bg-zinc-950/70 p-2 ring-1 ring-white/[0.08] transition focus-within:ring-sky-500/40">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              disabled={busy || !activeId}
              placeholder="Message Claude…"
              aria-label="Message"
              className="min-w-0 flex-1 resize-none bg-transparent px-2.5 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 disabled:opacity-50"
            />
            <button onClick={() => void send()} disabled={busy || !input.trim() || !activeId} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-sky-500 text-white transition hover:bg-sky-400 disabled:bg-zinc-800 disabled:text-zinc-600" aria-label="Send">
              {busy ? <Spinner className="!border-white/30 !border-t-white" /> : "↑"}
            </button>
          </div>
          <details className="text-[11px] text-zinc-600">
            <summary className="cursor-pointer list-none transition-colors hover:text-zinc-400">Options</summary>
            <div className="reveal mt-2 space-y-2 rounded-xl bg-white/[0.03] p-3">
              <label className="flex items-start gap-2 text-zinc-400">
                <input type="checkbox" checked={benchmark} onChange={(e) => setBenchmark(e.target.checked)} disabled={busy} className="mt-0.5" />
                <span><strong className="font-medium text-zinc-300">Benchmark this next message</strong> (costs extra, applies once): also generates a full-context answer so time and cost can be compared. Roughly doubles the model cost of that message and is limited to a few runs per hour.</span>
              </label>
              {config?.devTools && (
                <label className="flex items-center gap-2 text-zinc-500">
                  Developer: inject a failed quality check
                  <select value={force} onChange={(e) => setForce(e.target.value as typeof force)} className="rounded-lg bg-zinc-900 px-1.5 py-1 text-zinc-300 ring-1 ring-white/10">
                    <option value="">off</option>
                    <option value="optimized">first attempt (expect more context added)</option>
                    <option value="all">every attempt (expect full-context fallback)</option>
                  </select>
                </label>
              )}
            </div>
          </details>
        </div>
      </section>

      <TraceView trace={trace} loading={busy} />
    </div>
  );
}

const STEPS: { key: StageEvent["stage"]; label: string }[] = [
  { key: "understanding", label: "Understanding context…" },
  { key: "selecting", label: "Selecting relevant history…" },
  { key: "building", label: "Building optimized context…" },
  { key: "responding", label: "Claude is responding…" },
  { key: "checking", label: "Checking response…" },
];
const RETRY_LABEL: Record<string, string> = { expanded: "Adding more context…", regenerated: "Asking again with the same context…", full: "Retrying with the full context…" };

// What Consolidate is doing right now. Narrates pipeline stages only; no model reasoning is shown.
function Progress({ step, answering }: { step: StageEvent; answering: boolean }) {
  const current = step.stage === "retrying" ? 3 : Math.max(0, STEPS.findIndex((x) => x.key === step.stage));
  const label = step.stage === "retrying" ? (RETRY_LABEL[step.level ?? ""] ?? "Retrying…") : STEPS[current].label;
  return (
    <div className="flex items-center gap-3 rounded-xl bg-white/[0.03] px-4 py-3" role="status" aria-live="polite">
      <Spinner />
      <div className="min-w-0">
        <p className="shimmer text-sm font-medium" data-testid="progress-label">{step.stage === "responding" && answering ? "Claude is responding…" : label}</p>
        <div className="mt-1.5 flex gap-1" aria-hidden>
          {STEPS.map((x, i) => (
            <span key={x.key} className={`h-1 w-8 rounded-full transition-colors ${i < current ? "bg-emerald-400/80" : i === current ? "bg-sky-400" : "bg-white/10"}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Bubble({ m, selected, onTrace, streaming }: { m: ChatMessage; selected?: boolean; onTrace?: () => void; streaming?: boolean }) {
  const user = m.role === "user";
  return (
    <div className={`flex gap-3 ${user ? "flex-row-reverse" : ""}`}>
      <div className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${user ? "bg-zinc-700 text-zinc-200" : "bg-gradient-to-br from-emerald-400 to-sky-500 text-zinc-950"}`} aria-hidden>{user ? "You" : "C"}</div>
      <div className={`flex min-w-0 max-w-[85%] flex-col ${user ? "items-end" : "items-start"}`}>
        <div className={`whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${user ? "rounded-tr-md bg-sky-600/25 text-sky-50 ring-1 ring-sky-500/20" : "rounded-tl-md bg-white/[0.05] text-zinc-100 ring-1 ring-white/[0.06]"} ${selected ? "outline outline-1 outline-offset-2 outline-emerald-500/40" : ""}`}>
          {m.content}
          {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-sky-300/70 align-middle" />}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-zinc-600">
          <span>{time(m.createdAt)}</span>
          {m.runId && (
            <>
              <button onClick={onTrace} className={`rounded-full px-2 py-0.5 transition-colors ${selected ? "bg-emerald-500/15 text-emerald-300" : "bg-white/[0.04] text-sky-300/80 hover:bg-white/[0.08] hover:text-sky-200"}`}>{selected ? "Showing trace" : "View trace"}</button>
              {m.evaluationStatus === "FAIL" && m.fallbackLevel === 0 && !m.regenerated && <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-red-300">Quality check failed</span>}
              {m.regenerated && <span className={`rounded-full px-2 py-0.5 ${m.answerPassed ? "bg-orange-500/10 text-orange-300" : "bg-red-500/10 text-red-300"}`}>Regenerated once{m.answerPassed ? "" : " · still failing"}</span>}
              {!!m.fallbackLevel && <span className="rounded-full bg-orange-500/10 px-2 py-0.5 text-orange-300">{m.fallbackLevel === 1 ? "Added more context" : "Used full context"}</span>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
