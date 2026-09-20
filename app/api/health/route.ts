import { getDb } from "@/lib/db";

// Railway's deployment healthcheck. Public on purpose, and deliberately minimal: it touches SQLite (opening the file and
// running migrations if needed), never calls Anthropic, and reveals no conversations, configuration or secrets.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const row = getDb().prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
    if (row?.ok !== 1) throw new Error("unexpected result");
    return Response.json({ status: "ok", database: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "error", database: "error" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
