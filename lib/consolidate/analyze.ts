// Request analysis: what is being asked, and which terms drive retrieval. Deterministic, no model.
import { tokenize } from "./relevance";

const TASKS: [RegExp, string][] = [
  [/\b(what did we|remind me|do you remember|recall|earlier|we (?:decided|discussed|agreed|said)|you (?:said|mentioned))\b/i, "recall"],
  [/\b(fix|debug|why|cause|causing|error|fail\w*|broken|crash\w*|bug|issue|slow|not working)\b/i, "debugging"],
  [/\b(add|create|build|implement|scaffold|write|generate|set up|draft|refactor)\b/i, "creation"],
  [/\b(explain|describe|summari[sz]e|compare|how does|what is|what are|what's)\b/i, "explanation"],
  [/\b(decide|choose|should we|which|recommend|better)\b/i, "decision support"],
];

const MAX_TERMS = 8;

export type RequestAnalysis = { task: string; keyTerms: string[] };

export function analyzeRequest(request: string): RequestAnalysis {
  const seen = new Set<string>();
  const keyTerms: string[] = [];
  for (const word of request.match(/[A-Za-z0-9][A-Za-z0-9_.-]*/g) ?? []) {
    const [term] = tokenize(word);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    keyTerms.push(word.toLowerCase());
  }
  const kind = TASKS.find(([re]) => re.test(request))?.[1] ?? (request.includes("?") ? "question" : "general request");
  return { task: kind, keyTerms: keyTerms.slice(0, MAX_TERMS) };
}
