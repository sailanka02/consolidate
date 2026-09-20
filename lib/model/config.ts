// Server-side model configuration. Read from the environment only; never sent to the browser
// (the /api/config route exposes model names, never the key).
import "server-only";

// Currently supported Haiku (see https://platform.claude.com/docs/en/about-claude/models); used only when
// ANTHROPIC_UTILITY_MODEL is unset. Verified against the models list by the live smoke test.
export const DEFAULT_UTILITY_MODEL = "claude-haiku-4-5";

export type AnthropicConfig = { apiKey: string | undefined; model: string | undefined; utilityModel: string | undefined };

export function anthropicConfig(): AnthropicConfig {
  const model = process.env.ANTHROPIC_MODEL?.trim() || undefined;
  return {
    apiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
    model,
    utilityModel: process.env.ANTHROPIC_UTILITY_MODEL?.trim() || DEFAULT_UTILITY_MODEL,
  };
}

// Model names for display / attribution. Uses the configured names, so it is valid before any request is made.
export function configuredModels(): { main: string | null; utility: string | null } {
  const provider = process.env.MODEL_PROVIDER || "claude-code";
  if (provider === "anthropic-api") {
    const c = anthropicConfig();
    return { main: c.model ?? null, utility: c.utilityModel ?? null };
  }
  return { main: process.env.CLAUDE_CODE_MODEL ?? null, utility: null };
}
