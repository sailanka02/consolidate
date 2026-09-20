// Referential follow-ups ("what else can I add?") find the message they point back at, without loosening any
// threshold and without restoring full history.
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { compileContext, isReferentialFollowUp } from "@/lib/consolidate/compile";
import { RETRIEVE_THRESHOLD } from "@/lib/consolidate/relevance";
import { openDatabase } from "@/lib/db";
import * as repo from "@/lib/db/repo";
import { runTurn, type TurnEvent } from "@/lib/engine/turn";
import { FakeProvider, prepare, type Script } from "./helpers";

describe("isReferentialFollowUp", () => {
  it.each([
    "what else can I add?",
    "What are some additional features I can add?",
    "can you expand on that?",
    "what other options do I have?",
    "how can I improve this?",
    "what about this?",
    "can you make it better?",
    "what should I do next?",
    "tell me more",
  ])("recognizes %j", (q) => expect(isReferentialFollowUp(q)).toBe(true));

  it.each([
    "whats a hackathon",
    "Explain what a monad is in functional programming.",
    "Tell me something else interesting.",
    "Write a poem about the sea",
    "Which frontend framework should I use?",
    "",
  ])("does not treat %j as a follow-up", (q) => expect(isReferentialFollowUp(q)).toBe(false));

  it("ignores long, self-contained requests that merely contain a trigger phrase", () => {
    const long = "Please write a detailed comparison of relational databases and document stores, covering consistency, indexing, scaling, tooling, hosting cost, and what else matters for a small team building an internal analytics product";
    expect(isReferentialFollowUp(long)).toBe(false);
  });
});

// The shape of the real failure: a project description, then turns that share no words with the follow-up.
const CONVO = [
  { id: "u1", role: "user" as const, content: "i want to make a cli app that is customizable whether that be color or something else" },
  { id: "a1", role: "assistant" as const, content: "Nice idea. Decide on a language and a config format first. " + "Themes, flags and config files all matter here. ".repeat(20) },
  { id: "u2", role: "user" as const, content: "i need to use react for this" },
  { id: "a2", role: "assistant" as const, content: "Use Ink, a React renderer for terminals. " + "Components map to terminal widgets. ".repeat(20) },
  { id: "u3", role: "user" as const, content: "i must use react for this" },
  { id: "a3", role: "assistant" as const, content: "Understood, React it is. " + "Ink components handle layout and input. ".repeat(15) },
];

describe("compiler gate", () => {
  const { messages } = prepare(CONVO);

  it("asks for semantic retrieval for a follow-up even though few messages sit outside continuity", () => {
    const r = compileContext({ messages, request: "what are some additional features i can add" });
    expect(r.referentialFollowUp).toBe(true);
    expect(r.lexicallyInsufficient).toBe(true);
    // The original description and its answer are outside the recent turns and were omitted lexically.
    expect(r.decisions.find((d) => d.id === "u1")!.action).toBe("OMIT");
  });

  it("does not change the answer for a self-contained request", () => {
    const r = compileContext({ messages, request: "whats a hackathon" });
    expect(r.referentialFollowUp).toBe(false);
    expect(r.lexicallyInsufficient).toBe(false); // the >= 6 outside-continuity gate is unchanged
  });

  it("does not search when the follow-up already matches earlier history lexically", () => {
    const r = compileContext({ messages, request: "what are some additional features for my customizable cli app" });
    expect(r.decisions.some((d) => d.score >= RETRIEVE_THRESHOLD && !d.continuity && !d.protected)).toBe(true);
    expect(r.lexicallyInsufficient).toBe(false);
  });

  it("uses model-selected matches without restoring anything else, and leaves protection and continuity alone", () => {
    const base = compileContext({ messages, request: "what are some additional features i can add" });
    const r = compileContext({ messages, request: "what are some additional features i can add", semanticMatches: { u1: 0.6 } });
    const changed = r.decisions.filter((d, i) => d.action !== base.decisions[i].action).map((d) => d.id);
    expect(changed).toEqual(["u1"]);
    expect(r.decisions.find((d) => d.id === "u1")!.action).toBe("RETRIEVE");
    expect(r.decisions.filter((d) => d.protected).every((d) => d.action === "KEEP")).toBe(true);
    expect(r.decisions.filter((d) => d.continuity).map((d) => d.id)).toEqual(base.decisions.filter((d) => d.continuity).map((d) => d.id));
    expect(r.metrics.omitCount).toBeGreaterThan(0); // bounded: not full history
  });
});

describe("engine", () => {
  let db: DatabaseSync;
  let convId: string;
  beforeEach(() => {
    db = openDatabase(":memory:");
    convId = repo.createConversation(db).id;
  });
  const isRaw = (r: { mode?: string }) => r.mode === "raw";
  const answer = (n: number) => `Answer ${n}. ` + "Ink components handle layout and input for terminal apps. ".repeat(25);

  // The utility model picks the project description; everything else is inert.
  const script = (picked: { ids: string[] }): Script => (req, n) => {
    if (isRaw(req)) {
      if (req.request.includes("Earlier messages:")) {
        const first = repo.listMessages(db, convId)[0];
        picked.ids.push(first.id);
        return JSON.stringify({ ids: [first.id] });
      }
      if (req.request.includes("evaluating an AI assistant")) return '{"criteria":[],"category":"PASS","missing_ids":[]}';
      if (req.request.includes("context-management")) return '{"results":[]}';
      return "{}";
    }
    return answer(n);
  };

  const seed = async (p: FakeProvider) => {
    await runTurn(db, p, { conversationId: convId, content: "i want to make a cli app that is customizable whether that be color or something else" });
    await runTurn(db, p, { conversationId: convId, content: "i need to use react for this" });
    await runTurn(db, p, { conversationId: convId, content: "i must use react for this" });
  };

  it("retrieves the project description for 'what are some additional features i can add', without missing-context fallback", async () => {
    const picked = { ids: [] as string[] };
    const p = new FakeProvider(script(picked), { api: {} });
    await seed(p);
    const before = p.calls.length;
    const out = await runTurn(db, p, { conversationId: convId, content: "what are some additional features i can add" });

    const first = repo.listMessages(db, convId)[0];
    const chats = p.calls.slice(before).filter((c) => !isRaw(c));
    expect(chats).toHaveLength(1); // no expanded / full retry was needed
    expect(chats[0].context.map((c) => c.id)).toContain(first.id);
    expect(out.run).toMatchObject({ evaluationStatus: "PASS", fallbackLevel: 0 });
    expect(out.trace.retrieval.semanticUsed).toBe(true);
    expect(out.trace.retrieval.semanticNote).toMatch(/follow-up that refers back/);
    expect(out.trace.utilityCalls.filter((u) => u.kind === "semantic_retrieval")).toHaveLength(1);
    // Bounded: the follow-up prompt asks for at most 3 messages and full history was not restored.
    const retrievalPrompt = p.calls.slice(before).find((c) => isRaw(c) && c.request.includes("Earlier messages:"))!.request;
    expect(retrievalPrompt).toMatch(/up to 3 earlier messages/);
    expect(chats[0].context.length).toBeLessThan(repo.listMessages(db, convId).length);
    expect(out.run.finalReductionPercent).toBeGreaterThan(0);
  });

  it("does not run semantic retrieval for a self-contained question with little history", async () => {
    const picked = { ids: [] as string[] };
    const p = new FakeProvider(script(picked), { api: {} });
    await seed(p);
    const before = p.calls.length;
    const out = await runTurn(db, p, { conversationId: convId, content: "whats a hackathon" });
    expect(out.trace.retrieval.semanticUsed).toBe(false);
    expect(picked.ids).toHaveLength(0);
    expect(p.calls.slice(before).some((c) => isRaw(c) && c.request.includes("Earlier messages:"))).toBe(false);
  });

  it("narrates progress in order, without exposing any model output", async () => {
    const p = new FakeProvider(script({ ids: [] }), { api: {} });
    const events: TurnEvent[] = [];
    await runTurn(db, p, { conversationId: convId, content: "hello there", onEvent: (e) => events.push(e) });
    const stages = events.flatMap((e) => (e.type === "stage" ? [e.stage] : []));
    expect(stages).toEqual(["understanding", "selecting", "building", "responding", "checking"]);
  });
});
