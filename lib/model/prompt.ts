// Builds the prompt from compiled context + current request. Compiler metadata (scores, actions) is never included.
import type { ModelRequest } from "./types";

export const CHAT_SYSTEM_PROMPT =
  "You are Claude, a helpful assistant in an ongoing conversation with a user. Earlier conversation may be supplied in <context>: " +
  "<instructions> are standing instructions, <structured_memory> lists durable facts, decisions and preferences extracted from the conversation and should be treated as established, " +
  "<compressed_context> holds faithful summaries of earlier messages, and <conversation_history> holds earlier messages verbatim. " +
  "Not every earlier message is included, so an earlier question that appears without an answer is not necessarily unanswered; only <current_request> needs a reply. Follow every constraint and preference stated in the context. " +
  "Reply naturally to <current_request>. If you are asked about something the context does not contain, say you do not have that information rather than guessing. Do not use tools.";

export const UTILITY_SYSTEM_PROMPT = "You are a precise analysis component in a software pipeline. Follow the output format exactly. Output only what is asked. Do not use tools.";

const esc = (s: string) => s.replace(/<(\/?)(context|current_request|structured_memory|compressed_context|conversation_history|instructions|additional_instruction)/gi, "<​$1$2");

export function buildPrompt(input: ModelRequest): string {
  if (input.mode === "raw") return input.request;
  const { context, request, guidance } = input;
  const instructions = context.filter((c) => !c.section && (c.role === "system" || c.role === "developer"));
  const memory = context.filter((c) => c.section === "memory");
  const compressed = context.filter((c) => c.section === "compressed");
  const history = context.filter((c) => !c.section && c.role !== "system" && c.role !== "developer");
  const block = (tag: string, body: string[]) => (body.length ? `<${tag}>\n${body.join("\n")}\n</${tag}>\n\n` : "");
  const ctx =
    block("instructions", instructions.map((c) => `[${c.role}] ${esc(c.content)}`)) +
    block("structured_memory", memory.map((c) => esc(c.content))) +
    block("compressed_context", compressed.map((c) => esc(c.content))) +
    block("conversation_history", history.map((c) => `[${c.role}] ${esc(c.content)}`));
  return (ctx ? `<context>\n${ctx}</context>\n\n` : "") + `<current_request>\n${esc(request)}\n</current_request>\n` + (guidance ? `\n<additional_instruction>\n${esc(guidance)}\n</additional_instruction>\n` : "");
}

// The exact Messages API content of a request: what is counted before generation AND what is sent.
// One code path serves both so a pre-flight count can never drift from the real payload.
export function buildMessagesPayload(input: ModelRequest): { system: string; messages: { role: "user"; content: string }[] } {
  return {
    system: input.system ?? (input.mode === "raw" ? UTILITY_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT),
    messages: [{ role: "user", content: buildPrompt(input) }],
  };
}
