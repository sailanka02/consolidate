# Consolidate

Consolidate is a **context compiler for AI chat**. Every turn, instead of resending the whole conversation to the model, it decides what the model actually needs to see, sends that, checks the answer, and repairs it only when the context choice plausibly caused a problem. Every number it shows (tokens, cost, savings, waste) comes from provider-counted usage and persisted runs, not estimates.

Stack: Next.js 16 (App Router, Turbopack), TypeScript, Node's built-in `node:sqlite`, the Anthropic API (Sonnet 5 for answers, Haiku 4.5 for utility calls).

> This repository uses a Next.js version with breaking changes. See `AGENTS.md` and `node_modules/next/dist/docs/` before changing framework-level code.

## How a turn works

1. **Analyze and classify** each earlier message and route it: `KEEP`, `MEMORY`, `RETRIEVE`, `COMPRESS` or `OMIT`.
   - Protected requirements (standing instructions, constraints) are never dropped.
   - The last two unprotected messages are always kept for continuity.
   - Referential follow-ups ("these failures", "that approach") are detected and resolved against recent, compatible antecedent blocks, then bounded semantic search.
2. **Compile** the payload and count it with Anthropic's `messages.countTokens`.
3. **Economics fast path**: if the optimized payload would not save enough to pay for the optimizer (margin `CONSOLIDATE_ECONOMICS_MARGIN`, default 1.5), send full context instead.
4. **Generate** the answer with Sonnet, streamed as NDJSON events.
5. **Evaluate** with deterministic checks plus a semantic auditor (Haiku). Failures are categorized:

   | Category | What happens |
   |---|---|
   | `PASS` | Nothing |
   | `MISSING_CONTEXT` | Bounded, budgeted expansion, only with concrete evidence and information not already in the payload. Full context is the last resort. |
   | `INSTRUCTION_VIOLATION` | One corrective regeneration, only with four proofs (exact instruction, source, evidence, applies to this request; superseded instructions do not count) |
   | `UNSUPPORTED_CLAIM` | Retry only if tied to a compiler choice |
   | `UNCERTAIN` | Expansion only if a specific omitted message is named |
   | `ANSWER_QUALITY` | Warning only. Never buys a second generation. |
   | `CHECK_FAILED` | Bounded expansion, then full context |

6. **Economic guard**: optional retries are priced first and skipped if they would cost more than they can plausibly save.
7. **Persist** every attempt (initial and final reduction, decisions, evaluator evidence, retry decision, costs) so the Context Trace and Dashboard can be reconstructed exactly.

## Product surface

- **Chat**: streaming answers, stage stepper, status badges, optional one-shot benchmark mode (also generates a full-context answer for comparison, roughly doubling that message's cost).
- **Context Trace**: plain-English explanation of what was kept, remembered, retrieved, compressed or omitted and why, plus each attempt and any recovery.
- **Dashboard**: total/average toggle, tokens avoided, gross savings, optimizer cost, fallback waste, net savings, latency.

## Getting started

Requires Node >= 22.13.

```bash
npm install
cp .env.example .env.local   # then edit; never commit it
npm run dev
```

Open http://localhost:3000. Locally there is no password unless you set `CONSOLIDATE_DEMO_PASSWORD`.

Key environment variables (see `.env.example` for the full list):

| Variable | Purpose |
|---|---|
| `MODEL_PROVIDER` | `anthropic-api` (required in production) |
| `ANTHROPIC_API_KEY` | Your key. Server-side only. |
| `ANTHROPIC_MODEL` / `ANTHROPIC_UTILITY_MODEL` | `claude-sonnet-5` / `claude-haiku-4-5` |
| `CONSOLIDATE_DB_PATH` | SQLite file (absolute path in production) |
| `CONSOLIDATE_DEMO_PASSWORD` | Shared demo password (8+ characters) |
| `CONSOLIDATE_DEV_TOOLS` | Developer controls; always disabled in production |
| `CONSOLIDATE_ECONOMICS_MARGIN` | Fast-path margin, default 1.5 |
| `CONSOLIDATE_MAX_REQUEST_TOKENS` | Request-size guard, default 100000 |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js development, build, production server |
| `npm run lint` / `typecheck` | ESLint / `tsc --noEmit` |
| `npm test` | Vitest suite. Each test file uses a throwaway DB path (`tests/setup-env.ts`), so tests never touch a real database. Live-API tests are skipped by default. |
| `npm run backup -- <file>` | Consistent SQLite snapshot via `VACUUM INTO` |
| `npm run seed:demos` | Seed demo conversations through the real engine (paid; see below) |

## Repository layout

```
app/                     Pages and API routes (auth, conversations, messages, runs, dashboard, config, health)
components/              ChatView, TraceView, ContextTrace, Dashboard, LoginScreen, AppShell, ui
lib/consolidate/         Compiler and policy: compile, classify, memory, compress, protection, referential,
                         partner, semantic (evaluator), retry, economics, explain, trace, tokens
lib/engine/turn.ts       One chat turn end to end, including retry and fallback
lib/db/                  SQLite schema, additive migrations (PRAGMA user_version), repository
lib/model/               Anthropic provider, pricing, prompts
lib/demo/                Demo scenarios, seeding and export
lib/auth.ts, ratelimit.ts, runtime-config.ts, server.ts   Access control and production config
instrumentation*.ts      Startup validation (refuses to start when misconfigured in production)
tests/                   Unit, integration and component tests
```

## Security and safety

- Login gate with one shared password. Signed, stateless, HttpOnly, SameSite=Strict cookie (Secure in production), 12 h expiry. Every data or model route returns 401 without a session.
- In-memory rate limits on chat, benchmark and login; request-size guard (HTTP 413) before any paid generation.
- Production refuses to start unless configured correctly, including a Railway volume check so a deploy cannot silently erase data.
- Security headers in `next.config.ts`. `GET /api/health` is public and reveals nothing.
- Never commit `.env*` (except `.env.example`), API keys, the demo password, any `*.db*` file, `.consolidate/`, `scratchpad/`, `backups/` or `demo-exports/`.

## Deployment

The target is a single-replica Railway service with a volume at `/data`. Step-by-step instructions, environment variables, backup, rollback and troubleshooting are in [`DEPLOYMENT.md`](./DEPLOYMENT.md). SQLite is a single-writer file and the per-conversation lock lives in process memory, so do not scale above one replica.

## Demo data

`lib/demo/scenarios.ts` defines two synthetic conversations, "Demo — Enterprise Employee" (15 turns) and "Demo — Mom & Pop Website" (16 turns). `npm run seed:demos` sends them through the real engine and exports persisted results (nothing is simulated):

```bash
CONSOLIDATE_SEED_DEMOS=1 CONSOLIDATE_DB_PATH=$PWD/demo-exports/demo-seed.db npm run seed:demos
# optional: CONSOLIDATE_SEED_ONLY=enterprise|bakery, CONSOLIDATE_EXPORT_DIR=demo-exports
```

Seeding is idempotent by title and resumes from the next unsent turn. It refuses to run without the opt-in flag, the Anthropic provider and a key, and it should always point at a scratch DB, not your real one.

### Measured results (one live run per scenario, provider-counted)

| | Requests | Full-context tokens | Sent tokens | Avoided | Net savings |
|---|---|---|---|---|---|
| Enterprise | 15 | 222,947 | 142,822 | 35.9% | +$0.0899 |
| Mom & Pop | 16 | 176,942 | 80,007 | 54.8% | +$0.1458 |
| Combined | 31 | 399,889 | 222,829 | 44.3% (weighted) | +$0.2357 |

Net = input-token savings minus optimizer cost (Haiku calls), with zero retries and zero fallback waste in these runs.

Caveats: a single run per scenario, so treat this as indicative, not a benchmark. 13 of 31 requests went full-context via the economics fast path. Gross savings count input tokens only. Some answers were imperfect (for example, a bakery answer invented a price and was flagged, and one checklist omitted a rule that memory had not captured). Any scale projections derived from these averages are illustrative only.
