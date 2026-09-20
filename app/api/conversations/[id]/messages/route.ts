import { runTurn, type TurnEvent } from "@/lib/engine/turn";
import { requireAuth } from "@/lib/auth";
import { checkRate, clientIp, generationRules, rateLimited } from "@/lib/ratelimit";
import { devForceFailure, errorResponse, runtime } from "@/lib/server";

export const maxDuration = 600; // a turn makes several real model calls

const MAX_CHARS = 50_000;

export async function POST(req: Request, ctx: RouteContext<"/api/conversations/[id]/messages">) {
  const denied = requireAuth(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    if (!body || typeof body.content !== "string" || !body.content.trim()) return Response.json({ error: "Expected { content: string }.", code: "invalid" }, { status: 400 });
    if (body.content.length > MAX_CHARS) return Response.json({ error: `Message exceeds ${MAX_CHARS} characters.`, code: "invalid" }, { status: 400 });
    const force = devForceFailure(body);
    const benchmark = body.benchmark === true;
    // Spend guard: every model-generating request is rate limited before any paid call; benchmark mode (an extra full-context
    // answer) is limited much more tightly.
    const limited = checkRate(generationRules(clientIp(req), benchmark));
    if (!limited.ok) return rateLimited(limited, benchmark ? "benchmark requests" : "messages");
    const { db, provider } = runtime();
    const base = { conversationId: id, content: body.content, benchmark, dev: force ? { forceEvalFailure: force } : undefined };

    if (body.stream !== true) return Response.json(await runTurn(db, provider, base));

    // Streaming: newline-delimited JSON events. `delta` = text of the answer as it arrives, `reset` = discard the
    // streamed text (a fallback attempt is starting), then exactly one `result` or `error` event.
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (o: unknown) => {
          try {
            controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
          } catch {
            /* client disconnected */
          }
        };
        try {
          const result = await runTurn(db, provider, { ...base, onEvent: (e: TurnEvent) => send(e) });
          send({ type: "result", ...result });
        } catch (e) {
          const r = errorResponse(e);
          send({ type: "error", ...(await r.json()) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
