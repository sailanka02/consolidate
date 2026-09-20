// Shared domain types. Everything the compiler consumes and produces is described here; the compiler
// itself is pure and knows nothing about SQLite, HTTP, or how the model is invoked.

export type Role = "system" | "developer" | "user" | "assistant";

export type ContentType = "fact" | "decision" | "preference" | "constraint" | "code" | "log" | "tool_output" | "discussion" | "other";

export type Action = "KEEP" | "MEMORY" | "RETRIEVE" | "COMPRESS" | "OMIT";

export type Protection = { level: "critical" | "high"; reason: string; method: "deterministic" | "semantic" };

// "heuristic" = the semantic classifier was unavailable, so a best-guess deterministic label is used until it can be resolved.
export type ClassMethod = "deterministic" | "semantic" | "heuristic";

// What the pipeline has learned about one message. Persisted so old messages are never re-analysed.
export type Annotation = {
  contentType: ContentType;
  classMethod: ClassMethod;
  protection: Protection | null;
  // True when the message's durable content is fully captured by its memory items (nothing else worth keeping).
  memoryComplete: boolean;
  // True when only the semantic classifier can settle this message (deterministic rules were not confident).
  ambiguous: boolean;
};

export type HistoryMessage = {
  id: string;
  role: Role;
  content: string;
  createdAt?: string;
  annotation?: Annotation;
};

// One entry of the context sent to a model. `section` marks compiler-built entries; plain messages have none.
export type CompiledEntry = { id: string; role: Role; content: string; section?: "memory" | "compressed" };

export type MemoryType = "fact" | "decision" | "preference" | "state" | "constraint";

export type MemoryItem = {
  id: string;
  key: string;
  value: string;
  type: MemoryType;
  sourceIds: string[]; // every message that stated this key, including superseded statements
  confidence: number;
  active: boolean;
  previousValues: string[]; // values replaced by a newer statement
  createdAt?: string;
  updatedAt?: string;
};

export type MemoryStatement = { key: string; value: string; type: MemoryType; confidence: number; op: "set" | "remove" };

export type CompressedGroup = {
  id: string;
  kind: "duplicate" | "related_logs" | "discussion" | "summary";
  method: "deterministic" | "semantic";
  sourceIds: string[];
  originalTokenEstimate: number;
  compressedTokenEstimate: number;
  summary: string;
  reason: string;
  cacheKey?: string;
};

// Tokens saved per mechanism. Partitions (original - compiled) exactly, so nothing is double counted.
// `memory` is net of the memory block itself and can be negative when the block costs more than it replaced.
export type Savings = Record<"omission" | "memory" | "compression" | "deduplication", number>;

export type Signals = { lexical: number; typeFactor: number; importance: number; recency: number; memory: number; semantic: number };

export type Decision = {
  id: string;
  role: Role;
  preview: string;
  tokens: number;
  contentType: ContentType;
  classMethod: ClassMethod;
  protected: boolean;
  protectionReason?: string;
  protectionMethod?: Protection["method"];
  score: number;
  signals: Signals;
  action: Action;
  reason: string;
  groupId?: string;
  duplicateOf?: string;
  continuity?: boolean;
  antecedent?: boolean; // brought back because the request refers to it ("these failures"), see referential.ts
  matched: string[];
};

export type CompileMetrics = {
  originalTokenEstimate: number;
  compiledTokenEstimate: number;
  tokensAvoided: number;
  reductionPercent: number;
  keepCount: number;
  memoryCount: number;
  retrieveCount: number;
  compressCount: number;
  omitCount: number;
  totalItems: number;
};

// The request refers to something recently presented ("these failures"): what was detected and which messages it points at.
export type ReferentialInfo = {
  kind: "error" | "output" | "code" | "decision" | "any";
  noun: string;
  phrase: string;
  candidateIds: string[]; // compatible messages found in the recent window
  selectedIds: string[]; // the coherent block brought back (members already kept for other reasons included)
  needsSearch: boolean; // nothing compatible was found deterministically: a bounded semantic search may look (and may abstain)
  searchedIds?: string[]; // the recent-window messages a bounded semantic search was shown (protected ones included)
  semanticSelectedIds?: string[]; // the subset that search chose (empty = it abstained)
};

export type CompileResult = {
  decisions: Decision[]; // one per history message, in conversation order
  compiledContext: CompiledEntry[];
  metrics: CompileMetrics;
  memoryInjected: MemoryItem[];
  groups: CompressedGroup[];
  savings: Savings;
  // Messages worth a semantic summary that no deterministic route could shrink (see semantic.ts).
  summaryCandidates: string[];
  // True when lexical retrieval found nothing usable and a semantic retrieval pass could help.
  lexicallyInsufficient: boolean;
  // The request is a short follow-up that points back at earlier context ("what else can I add?") without naming it.
  referentialFollowUp: boolean;
  referentialObject?: ReferentialInfo;
  requestTerms: string[];
};

export type EvalLayer = "deterministic" | "semantic";
export type EvalCheck = { name: string; passed: boolean; reason?: string; layer: EvalLayer };

export type EvalResult = { passed: boolean; checks: EvalCheck[] };

// Internal Consolidate model calls. Classification and memory extraction happen in ONE batched call, so they are one kind.
export type UtilityKind = "classification_memory" | "semantic_retrieval" | "compression" | "evaluation";

export type UtilityCall = {
  kind: UtilityKind;
  purpose: string;
  ok: boolean;
  latencyMs: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  costUsd?: number | null; // null = usage reported but the model is not in the pricing config
  error?: string;
  note?: string;
};

export type GenerationUsage = { inputTokens: number | null; outputTokens: number | null; cacheCreationInputTokens: number | null; cacheReadInputTokens: number | null };

export type CountSource = "provider_count" | "local_estimate";

// regenerated = same optimized context (plus a corrective instruction), asked again once; no history is added.
export type AttemptLevel = "optimized" | "regenerated" | "expanded" | "full";

// Why an attempt did not pass. Only MISSING_CONTEXT (and a failed deterministic check) may restore history:
// a bad answer, a violated instruction or an unsupported claim is not fixed by sending more of the conversation.
export type SemanticCategory = "PASS" | "MISSING_CONTEXT" | "ANSWER_QUALITY" | "INSTRUCTION_VIOLATION" | "UNSUPPORTED_CLAIM" | "UNCERTAIN";
export type FailureCategory = SemanticCategory | "CHECK_FAILED"; // CHECK_FAILED = a deterministic check failed

export type RoutingCounts = { keep: number; memory: number; retrieve: number; compress: number; omit: number };

// Compact per-message routing of one attempt, persisted so a fallback never hides what the first compile decided.
export type AttemptDecision = {
  id: string;
  action: Action;
  tokens: number;
  score: number;
  reason: string;
  // Enough to explain the decision in plain language without the compile result (optional: older runs lack them).
  role?: Role;
  preview?: string;
  contentType?: ContentType;
  classMethod?: ClassMethod;
  protected?: boolean;
  protectionReason?: string;
  protectionMethod?: Protection["method"];
  signals?: Signals;
  matched?: string[];
  continuity?: boolean;
  antecedent?: boolean;
  groupId?: string;
  duplicateOf?: string;
};
export type AttemptGroup = { id: string; kind: CompressedGroup["kind"]; method: CompressedGroup["method"]; sourceIds: string[]; originalTokens: number; compressedTokens: number; summary: string; reason: string };
export type AttemptMemory = { key: string; value: string; type: MemoryType; sourceIds: string[]; memoryTokens: number };

export type AttemptTrace = {
  level: AttemptLevel;
  passed: boolean;
  reason: string;
  checks: EvalCheck[];
  contextTokens: number; // local estimate of the context sent (kept for comparison with provider counts)
  countedInputTokens?: number | null; // provider pre-flight count of the exact request payload, when available
  failureCategory?: FailureCategory; // PASS when the attempt passed
  missingIds?: string[]; // omitted messages the evaluator said were needed
  fullCountedTokens?: number | null; // provider count of the full-context payload this attempt is measured against
  reductionPercent?: number; // this attempt's context vs full context (provider counts when both exist, else local estimates)
  routing?: RoutingCounts; // absent for the full-context attempt (nothing was routed)
  contextAdded?: { id: string; tokens: number; reason?: string }[]; // entries this attempt has that the previous attempt did not (local estimate tokens)
  decisions?: AttemptDecision[];
  groups?: AttemptGroup[];
  memoryInjected?: AttemptMemory[];
  referential?: ReferentialInfo; // what "these failures"-style wording pointed at in THIS attempt's compile
  response: string; // persisted so a failed optimized answer stays inspectable
  modelLatencyMs: number;
  providerInputTokens?: number; // ACTUAL usage reported after generation (uncached input only)
  providerOutputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  model?: string;
  costUsd?: number | null;
};

export type TokenCount = {
  source: CountSource;
  fullTokens: number; // original context (full, unoptimized request)
  compiledTokens: number; // context that produced the returned answer
  tokensAvoided: number;
  reductionPercent: number;
  // What the FIRST compile achieved before any fallback. fullTokens/compiledTokens above describe the request that
  // actually produced the returned answer, so after a fallback they can be worse than this.
  initialCompiledTokens: number;
  initialTokensAvoided: number;
  initialReductionPercent: number;
  fullEstimate: number; // old local estimator, always recorded so its error can be measured
  compiledEstimate: number;
  latencyMs: number;
  error?: string; // why provider counting was not used
};

export type CostSummary = {
  pricingModel: string;
  fullInputCostUsd: number;
  compiledInputCostUsd: number;
  grossInputSavingsUsd: number;
  optimizerCostUsd: number;
  fallbackWasteCostUsd: number;
  netSavingsUsd: number;
  generationCostUsd: number | null; // actual cost of all main-model generations (final + discarded attempts)
  generationInputCostUsd: number | null;
  generationOutputCostUsd: number | null;
};

// Cost-aware fast path decision (lib/consolidate/economics.ts), made after both contexts are counted and before generation.
//  optimized            the savings justify an optimized generation + semantic validation (today's path)
//  bypass_full_context  savings smaller than the expected validation cost x margin: one full-context generation, no semantic evaluator
//  equivalent_context   the compiled context is not smaller than the full one: nothing to validate, full context sent
//  safety_full_context  a compile-time structural check failed: full context sent regardless of economics (not an economic bypass)
export type EconomicDecision = "optimized" | "bypass_full_context" | "equivalent_context" | "safety_full_context";
export type EconomicsDecision = {
  decision: EconomicDecision;
  reason: string;
  source: CountSource; // what the sizes below are: provider counts or (fallback) local estimates
  margin: number;
  fullTokens: number;
  wouldBeCompiledTokens: number; // the compiled context's size had it been sent
  tokensAvoided: number; // potential, not achieved, when the request was bypassed
  expectedGrossInputSavingsUsd: number | null;
  expectedEvaluationCostUsd: number | null;
  thresholdUsd: number | null; // expectedEvaluationCostUsd x margin
  evalUsageSource: "history" | "default";
  expectedEvalInputTokens: number;
  expectedEvalOutputTokens: number;
};

export type BenchmarkSide = { response: string; modelLatencyMs: number; countedInputTokens: number | null; usage: GenerationUsage; costUsd: number | null; checksPassed: boolean; failedChecks: string[] };

// Benchmark mode only: a full-context baseline generated next to the Consolidate answer. Never produced in normal mode.
export type BenchmarkResult = { full: BenchmarkSide | null; consolidate: BenchmarkSide; baselineError?: string };

export type TracePreview = { id: string; preview: string };

export type ContextTrace = {
  economics?: EconomicsDecision; // absent on runs stored before the cost-aware fast path
  requestAnalysis: {
    request: string;
    task: string;
    keyTerms: string[];
    historyScanned: number;
    originalTokenEstimate: number;
    memoryAvailable: number;
  };
  classification: {
    counts: Record<ContentType, number>;
    total: number;
    methods: Record<ClassMethod, number>;
    newlyClassified: number; // classified during this request (the rest came from the persisted cache)
    items: (TracePreview & { contentType: ContentType; method: ClassMethod })[];
  };
  protection: { items: (TracePreview & { reason: string; method: Protection["method"]; level: Protection["level"] })[] };
  memory: {
    changes: { key: string; value: string; type: MemoryType; change: "created" | "updated" | "unchanged" | "removed"; sourceIds: string[]; previousValue?: string }[];
    injected: { key: string; value: string; type: MemoryType; sourceIds: string[]; confidence: number; originalTokens: number; memoryTokens: number; previousValues: string[] }[];
    totalActive: number;
    blockTokens: number;
    netTokensSaved: number;
  };
  retrieval: {
    items: (TracePreview & { score: number; signals: Signals; matched: string[]; reason: string; continuity: boolean; antecedent?: boolean })[];
    referential?: ReferentialInfo;
    semanticUsed: boolean;
    semanticNote?: string;
  };
  compression: {
    groups: (Omit<CompressedGroup, "originalTokenEstimate" | "compressedTokenEstimate"> & { originalTokens: number; compressedTokens: number; cached: boolean })[];
    deduplicated: { id: string; duplicateOf: string; tokens: number; preview: string }[];
  };
  omission: {
    totalCount: number;
    tokensRemoved: number;
    items: (TracePreview & { tokens: number; score: number; reason: string; duplicate: boolean })[]; // largest first
  };
  compilation: {
    originalTokenEstimate: number;
    compiledTokenEstimate: number;
    tokensAvoided: number;
    reductionPercent: number;
    counts: { keep: number; memory: number; retrieve: number; compress: number; omit: number };
    savings: Savings;
    providerInputTokens: number | null;
    providerOutputTokens: number | null;
    compilerLatencyMs: number;
    modelLatencyMs: number;
    // Newer runs only (older stored traces predate provider counting).
    tokenCount?: TokenCount;
    usage?: GenerationUsage; // ACTUAL usage across all main-model generations; never overwrites tokenCount
    costs?: CostSummary | null;
    model?: string | null;
    utilityModel?: string | null;
  };
  evaluation: {
    status: "PASS" | "FAIL";
    checks: EvalCheck[];
    semanticEvaluatorUsed: boolean;
    semanticSkipReason?: string;
    attempts: AttemptTrace[];
    fallbackApplied: boolean;
    fallbackLevel: 0 | 1 | 2; // 0 none, 1 expanded retrieval, 2 full context
    fallbackReason?: string;
  };
  utilityCalls: UtilityCall[];
  benchmark?: BenchmarkResult;
};

// ---- persisted / API shapes ----

export type Conversation = { id: string; title: string; createdAt: string; updatedAt: string };

export type ChatMessage = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  localTokenEstimate: number;
  runId?: string; // set on assistant messages
  fallbackLevel?: number;
  evaluationStatus?: "PASS" | "FAIL"; // of the FIRST attempt
  regenerated?: boolean; // the answer was regenerated once with the same context
  answerPassed?: boolean; // whether the attempt behind the returned answer passed
};

export type RunSummary = {
  id: string;
  conversationId: string;
  conversationTitle?: string;
  userMessageId: string;
  originalTokens: number;
  compiledTokens: number;
  tokensAvoided: number;
  reductionPercent: number; // FINAL: the request that produced the returned answer (same value as finalReductionPercent)
  finalReductionPercent: number;
  // INITIAL: what the compiler achieved on the first attempt, before any fallback restored context.
  initialCompiledTokens: number;
  initialReductionPercent: number;
  failureCategory: FailureCategory | null; // of the first attempt; null on older runs
  compilerLatencyMs: number;
  modelLatencyMs: number;
  evaluationStatus: "PASS" | "FAIL";
  fallbackApplied: boolean;
  fallbackLevel: number;
  providerInputTokens: number | null;
  providerOutputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  countSource: CountSource;
  fullEstimateTokens: number | null;
  compiledEstimateTokens: number | null;
  costs: Omit<CostSummary, "generationInputCostUsd" | "generationOutputCostUsd"> | null;
  savings: Savings;
  model: string | null;
  createdAt: string;
  // Cost-aware fast path (null on runs stored before it existed).
  economicDecision: EconomicDecision | null;
  economicDecisionReason: string | null;
  expectedGrossInputSavingsUsd: number | null;
  expectedEvaluationCostUsd: number | null;
  economicsMargin: number | null;
  economicsSource: CountSource | null;
  potentialCompiledTokens: number | null;
};
