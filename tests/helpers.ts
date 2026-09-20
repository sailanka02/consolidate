// Test-only helpers: the coding-demo fixture and a scripted fake ModelProvider. Never imported by the app.
import demo from "./fixtures/coding-demo.json";
import { annotateMessage } from "@/lib/consolidate/classify";
import { applyStatements, extractStatements } from "@/lib/consolidate/memory";
import type { ModelProvider, ModelRequest, ModelResult } from "@/lib/model";
import { buildMessagesPayload } from "@/lib/model/prompt";
import type { HistoryMessage, MemoryItem, Role } from "@/lib/types";

export const DEMO = demo as { id: string; role: Role; content: string }[];

// Annotate + extract memory from user/system/developer messages exactly as the engine does.
export function prepare(messages: { id: string; role: Role; content: string }[]): { messages: HistoryMessage[]; memory: MemoryItem[] } {
  const annotated = messages.map((m) => ({ ...m, annotation: annotateMessage(m) }));
  let n = 0;
  const { items } = applyStatements(
    [],
    annotated.filter((m) => m.role !== "assistant").map((m) => ({ sourceId: m.id, statements: extractStatements(m.content).statements })),
    () => `mem${++n}`,
  );
  return { messages: annotated, memory: items };
}

export type Script = (req: ModelRequest, call: number) => string | Error;

export type FakeOptions = {
  // When set the fake behaves like the Anthropic API provider: priced models, provider token counts, API-billed usage.
  api?: {
    mainModel?: string;
    utilityModel?: string;
    // Deterministic pre-flight counter. Return an Error to simulate count_tokens failing.
    count?: (req: ModelRequest) => number | Error;
    cache?: { creation?: number; read?: number };
  };
};

// Stand-in "provider counter": 3 tokens per character of the exact rendered payload / 10, so it differs from the local estimate.
export const fakeCount = (req: ModelRequest) => Math.ceil(buildMessagesPayload(req).messages[0].content.length / 3) + 20;

// Deterministic fake provider that records every request it receives.
export class FakeProvider implements ModelProvider {
  readonly name = "fake";
  calls: ModelRequest[] = [];
  counted: ModelRequest[] = [];
  countTokens?: (input: ModelRequest) => Promise<number>;
  constructor(
    private script: Script,
    private opts: FakeOptions = {},
  ) {
    if (opts.api) {
      const api = opts.api;
      this.countTokens = async (req) => {
        this.counted.push(req);
        const n = (api.count ?? fakeCount)(req);
        if (n instanceof Error) throw n;
        return n;
      };
    }
  }
  // Like the Anthropic provider, expose model names so the cost-aware fast path can price before generating.
  models = this.opts.api ? () => ({ main: this.opts.api!.mainModel ?? "claude-sonnet-5", utility: this.opts.api!.utilityModel ?? "claude-haiku-4-5" }) : undefined;
  async generate(req: ModelRequest): Promise<ModelResult> {
    this.calls.push(req);
    const out = this.script(req, this.calls.length);
    if (out instanceof Error) throw out;
    const api = this.opts.api;
    if (!api) return { response: out, latencyMs: 1, provider: "fake", model: "fake-1", usage: { inputTokens: 100, outputTokens: 10 } };
    const model = req.tier === "utility" ? (api.utilityModel ?? "claude-haiku-4-5") : (api.mainModel ?? "claude-sonnet-5");
    req.onText?.(out);
    return {
      response: out,
      latencyMs: 1,
      provider: "fake",
      model,
      apiBilled: true,
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        ...(api.cache && req.tier !== "utility" ? { cacheCreationInputTokens: api.cache.creation ?? 0, cacheReadInputTokens: api.cache.read ?? 0 } : {}),
      },
    };
  }
}
