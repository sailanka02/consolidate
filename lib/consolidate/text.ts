// Small text helpers shared by classification, protection, and memory extraction.

// Sentence split that keeps fenced code blocks and inline code intact enough for pattern matching.
export const sentencesOf = (content: string): string[] =>
  content
    .replace(/```[\s\S]*?```/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

export const hasFence = (s: string) => /```/.test(s);
export const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

// A question or a request for the assistant to do something: never a durable statement.
const REQUEST_START =
  /^(?:(?:hey|hi|hello|ok|okay|so|and|but|now|also|then|well|thanks|thank you)[\s,!.]+)*(?:can|could|would|will|should|shall|may|do|does|did|is|are|was|were|how|what|why|when|where|who|which|whose|please|pls|tell|explain|show|help|write|make|create|generate|give|list|fix|debug|find|check|summari[sz]e|translate|draft|compare|describe|implement|add|remove|update|refactor|review|run|build)\b/i;
export const isQuestionOrRequest = (sentence: string) => sentence.includes("?") || REQUEST_START.test(sentence.trim());

// Extract the pieces of text whose exact form usually matters.
export const EXACT_TOKEN_RE = /`[^`\n]+`|https?:\/\/\S+|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[\w.-]+\/[\w./-]+\b|\b[\w-]+\.(?:ts|tsx|js|jsx|json|md|css|ya?ml|py|go|rs|sql|env|toml|sh)\b|\b\d+(?:\.\d+){1,3}\b/g;
export const exactTokens = (s: string) => [...new Set((s.match(EXACT_TOKEN_RE) ?? []).map((t) => t.replace(/^`|`$/g, "")))];
