// Production provider: the Anthropic Messages API through the official TypeScript SDK.
// Configuration is read server-side only. The main model produces the user-facing answer; the utility model
// (a cheaper Haiku by default) runs Consolidate's internal semantic steps.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { anthropicConfig } from "./config";
import { buildMessagesPayload } from "./prompt";
import { ProviderError, type ModelProvider, type ModelRequest, type ModelResult } from "./types";

const MAIN_MAX_TOKENS = 16_000; // non-streaming ceiling that stays under SDK HTTP timeouts
const UTILITY_MAX_TOKENS = 8_192;
const DEFAULT_TIMEOUT_MS = 120_000;

export function mapAnthropicError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError("timeout", "Anthropic request timed out.");
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError("unavailable", `Could not reach the Anthropic API: ${e.message}`);
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ProviderError("auth", "Anthropic rejected the API key (invalid, revoked, or not permitted).");
  if (e instanceof Anthropic.RateLimitError) return new ProviderError("rate_limit", "Anthropic rate limit reached (429). Wait a moment and retry.");
  if (e instanceof Anthropic.NotFoundError) return new ProviderError("model", `Model not available to this API key: ${e.message}`);
  if (e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message)) return new ProviderError("credits", "Anthropic account has insufficient credits. Add credits in the Console.");
  if (e instanceof Anthropic.APIError && e.status === 402) return new ProviderError("credits", "Anthropic account has insufficient credits. Add credits in the Console.");
  if (e instanceof Anthropic.APIError && typeof e.status === "number" && e.status >= 500) return new ProviderError("server", `Anthropic server error (${e.status}). Retry shortly.`);
  return new ProviderError("provider", e instanceof Error ? e.message.slice(0, 300) : "Anthropic API error");
}

export class AnthropicApiProvider implements ModelProvider {
  readonly name = "anthropic-api";

  models() {
    const { model, utilityModel } = anthropicConfig();
    return { main: model ?? null, utility: utilityModel ?? model ?? null };
  }

  private setup(input: ModelRequest) {
    const { apiKey, model, utilityModel } = anthropicConfig();
    if (!apiKey || !model) throw new ProviderError("config", "MODEL_PROVIDER=anthropic-api requires ANTHROPIC_API_KEY and ANTHROPIC_MODEL (server-side environment variables).");
    const utility = input.tier === "utility";
    const client = new Anthropic({ apiKey, timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxRetries: 2 });
    return { client, model: utility ? (utilityModel ?? model) : model, utility };
  }

  // Exact input-token count for the payload generate() would send, from Anthropic's count_tokens endpoint,
  // using the same model that will generate.
  async countTokens(input: ModelRequest): Promise<number> {
    const { client, model } = this.setup({ ...input, timeoutMs: input.timeoutMs ?? 30_000 });
    try {
      const { system, messages } = buildMessagesPayload(input);
      const r = await client.messages.countTokens({ model, system, messages });
      return r.input_tokens;
    } catch (e) {
      throw mapAnthropicError(e);
    }
  }

  async generate(input: ModelRequest): Promise<ModelResult> {
    const { client, model, utility } = this.setup(input);
    const { system, messages } = buildMessagesPayload(input);
    const params = {
      model,
      max_tokens: utility ? UTILITY_MAX_TOKENS : MAIN_MAX_TOKENS,
      system,
      messages,
      // Utility calls are short structured analyses: no reasoning tokens. The main model keeps its default behavior.
      ...(utility ? { thinking: { type: "disabled" as const } } : {}),
    };
    const started = performance.now();
    try {
      let msg: Anthropic.Message;
      if (input.onText && !utility) {
        const stream = client.messages.stream(params).on("text", (delta) => input.onText!(delta));
        msg = await stream.finalMessage();
      } else msg = await client.messages.create(params);
      const response = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
      if (!response) throw new ProviderError("malformed", `Claude returned no text (stop_reason: ${msg.stop_reason}).`);
      const u = msg.usage;
      return {
        response,
        latencyMs: Math.round(performance.now() - started),
        provider: this.name,
        model: msg.model,
        apiBilled: true,
        usage: {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          ...(u.cache_creation_input_tokens != null ? { cacheCreationInputTokens: u.cache_creation_input_tokens } : {}),
          ...(u.cache_read_input_tokens != null ? { cacheReadInputTokens: u.cache_read_input_tokens } : {}),
        },
      };
    } catch (e) {
      throw mapAnthropicError(e);
    }
  }
}
