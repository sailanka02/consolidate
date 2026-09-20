// LOCAL provider: runs the installed, already-authenticated Claude Code CLI as a one-shot generator.
// The prompt is written to stdin (data, never a shell string); all flags are fixed constants.
import "server-only";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrompt, CHAT_SYSTEM_PROMPT, UTILITY_SYSTEM_PROMPT } from "./prompt";
import { ProviderError, type ModelProvider, type ModelRequest, type ModelResult } from "./types";

const TIMEOUT_MS = 180_000;
const MAX_STDOUT = 2_000_000;
const MAX_STDERR = 64_000;

// No tools, no session file, no user/project settings, no skills, no MCP: a plain text generation.
// The system prompt is replaced so Claude Code's default agent prompt is not added to every request.
const fixedArgs = (system: string) => [
  "-p",
  "--output-format", "json",
  "--tools", "",
  "--no-session-persistence",
  "--disable-slash-commands",
  "--strict-mcp-config",
  "--setting-sources", "",
  "--system-prompt", system,
];

// Empty working directory so nothing from this project (CLAUDE.md, files) is visible to the model.
let dir: string | undefined;
const workdir = () => (dir ??= mkdtempSync(join(tmpdir(), "consolidate-cc-")));

type CliJson = {
  result?: unknown;
  is_error?: boolean;
  subtype?: string;
  usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
  modelUsage?: Record<string, unknown>;
};

export class ClaudeCodeProvider implements ModelProvider {
  readonly name = "claude-code";

  async generate(input: ModelRequest): Promise<ModelResult> {
    const bin = process.env.CLAUDE_BIN || "claude";
    const model = process.env.CLAUDE_CODE_MODEL;
    if (model && !/^[A-Za-z0-9._\-[\]]{1,64}$/.test(model)) throw new ProviderError("config", "CLAUDE_CODE_MODEL contains unsupported characters.");
    const system = input.system ?? (input.mode === "raw" ? UTILITY_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT);
    const args = model ? [...fixedArgs(system), "--model", model] : fixedArgs(system);
    const timeoutMs = input.timeoutMs ?? TIMEOUT_MS;

    // Force subscription login: an API key in the environment would switch Claude Code to API billing.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const started = performance.now();
    const { stdout, stderr, code, timedOut } = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(bin, args, { cwd: workdir(), env, stdio: ["pipe", "pipe", "pipe"], shell: false });
      let out = "";
      let err = "";
      let timedOut = false;
      const kill = () => child.kill("SIGKILL");
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => {
        out += d;
        if (out.length > MAX_STDOUT) kill();
      });
      child.stderr.on("data", (d: Buffer) => {
        if (err.length < MAX_STDERR) err += d;
      });
      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(new ProviderError("unavailable", e.code === "ENOENT" ? `Claude Code CLI ("${bin}") not found on PATH. Install it and run \`claude\` once to log in.` : `Could not start Claude Code: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout: out, stderr: err, code, timedOut });
      });
      child.stdin.on("error", () => {}); // process may exit before reading stdin
      child.stdin.end(buildPrompt(input));
    });
    const latencyMs = Math.round(performance.now() - started);

    if (timedOut) throw new ProviderError("timeout", `Claude Code did not respond within ${timeoutMs / 1000}s and was killed.`);

    let json: CliJson | null = null;
    try {
      json = JSON.parse(stdout) as CliJson;
    } catch {
      /* handled below */
    }
    const detail = (stderr.trim() || (typeof json?.result === "string" ? json.result : "")).slice(0, 300);
    if (json?.is_error || (code !== 0 && !json)) {
      const auth = /log ?in|auth|credential|401/i.test(detail);
      throw new ProviderError(auth ? "auth" : "exit", auth ? `Claude Code is not logged in. Run \`claude\` and /login. (${detail})` : `Claude Code failed (exit ${code}): ${detail || "no output"}`);
    }
    if (!json || typeof json.result !== "string" || !json.result.trim()) throw new ProviderError("malformed", "Claude Code returned no text result.");

    const u = json.usage;
    const inputTokens = u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : undefined;
    return {
      response: json.result.trim(),
      latencyMs,
      provider: this.name,
      model: json.modelUsage ? Object.keys(json.modelUsage)[0] : model,
      usage: u ? { inputTokens, outputTokens: u.output_tokens } : undefined, // inputTokens here INCLUDES cache tokens and CLI runtime overhead
    };
  }
}
