import { getDb } from "@/lib/db";
import { getRun } from "@/lib/db/repo";
import { requireAuth } from "@/lib/auth";
import { errorResponse } from "@/lib/server";

export async function GET(req: Request, ctx: RouteContext<"/api/runs/[id]">) {
  const denied = requireAuth(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const run = getRun(getDb(), id);
    return run ? Response.json(run) : Response.json({ error: "Run not found." }, { status: 404 });
  } catch (e) {
    return errorResponse(e);
  }
}
