import { getDb } from "@/lib/db";
import { dashboardStats, listRunSummaries } from "@/lib/db/repo";
import { requireAuth } from "@/lib/auth";
import { errorResponse } from "@/lib/server";

export async function GET(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;
  try {
    const db = getDb();
    return Response.json({ stats: dashboardStats(db), recentRuns: listRunSummaries(db, 25) });
  } catch (e) {
    return errorResponse(e);
  }
}
