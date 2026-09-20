// Maps real Anthropic SDK error classes to ProviderError codes. No network.
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { mapAnthropicError } from "@/lib/model/anthropic-api";

const api = (status: number, message: string) => Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message } }, message, new Headers());

describe("mapAnthropicError", () => {
  it.each([
    [401, "invalid x-api-key", "auth"],
    [403, "forbidden", "auth"],
    [404, "model: claude-nope", "model"],
    [429, "rate limited", "rate_limit"],
    [500, "boom", "server"],
    [529, "overloaded", "server"],
    [400, "Your credit balance is too low to access the Anthropic API", "credits"],
    [402, "payment required", "credits"],
    [400, "messages: bad shape", "provider"],
  ])("%i %s -> %s", (status, message, code) => {
    expect(mapAnthropicError(api(status, message)).code).toBe(code);
  });
  it("maps timeouts and connection failures", () => {
    expect(mapAnthropicError(new Anthropic.APIConnectionTimeoutError()).code).toBe("timeout");
    expect(mapAnthropicError(new Anthropic.APIConnectionError({ message: "ECONNRESET" })).code).toBe("unavailable");
  });
});
