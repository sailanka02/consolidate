// Provider-neutral model interface. The compiler never imports from here; it only produces context.
import type { CompiledEntry } from "../types";

export type ModelRequest = {
  // "chat": context + request are rendered as a conversation turn. "raw": `request` is the whole prompt (utility calls).
  mode?: "chat" | "raw";
  context: CompiledEntry[];
  request: string;
  // Chat mode only: a corrective instruction for a regeneration (rendered after the request, so it counts toward the payload).
  guidance?: string;
  system?: string; // overrides the default chat system prompt
  timeoutMs?: number;
  // "main" (default) is the user-facing model; "utility" is the cheaper model for internal semantic steps.
  tier?: "main" | "utility";
  // Chat mode only: called with each text delta as it arrives (providers that cannot stream ignore it).
  onText?: (delta: string) => void;
};

export type ModelUsage = {
  inputTokens?: number; // uncached input tokens only (cache tokens are reported separately)
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
};

export type ModelResult = {
  response: string;
  latencyMs: number;
  provider: string;
  model?: string;
  // Only set when the runtime reports it.
  usage?: ModelUsage;
  // True when usage is exact Messages API usage billed at API rates (so cost can be computed from it).
  apiBilled?: boolean;
};

export interface ModelProvider {
  readonly name: string;
  generate(input: ModelRequest): Promise<ModelResult>;
  // Provider-side exact token count of the request that generate() WOULD send. Optional: providers without it
  // (e.g. the local Claude Code CLI) make the engine fall back to the local estimator.
  countTokens?(input: ModelRequest): Promise<number>;
  // Names of the models this provider will use, so cost-aware decisions can be priced BEFORE generation. Optional.
  models?(): { main: string | null; utility: string | null };
}

export type ProviderErrorCode = "unavailable" | "auth" | "credits" | "model" | "rate_limit" | "server" | "timeout" | "exit" | "malformed" | "config" | "provider";

export class ProviderError extends Error {
  constructor(
    public code: ProviderErrorCode,
    message: string,
  ) {
    super(message);
  }
}
