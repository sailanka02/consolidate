import "server-only";
import { AnthropicApiProvider } from "./anthropic-api";
import { ClaudeCodeProvider } from "./claude-code";
import { ProviderError, type ModelProvider } from "./types";

// MODEL_PROVIDER=claude-code (default, local) | anthropic-api (production)
export function getProvider(): ModelProvider {
  const which = process.env.MODEL_PROVIDER || "claude-code";
  if (which === "claude-code") return new ClaudeCodeProvider();
  if (which === "anthropic-api") return new AnthropicApiProvider();
  throw new ProviderError("config", `Unknown MODEL_PROVIDER "${which}". Use "claude-code" or "anthropic-api".`);
}

export * from "./types";
