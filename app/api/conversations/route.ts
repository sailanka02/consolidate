import { getDb } from "@/lib/db";
import { createConversation, listConversations } from "@/lib/db/repo";
import { requireAuth } from "@/lib/auth";
import { errorResponse } from "@/lib/server";

export async function GET(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;
  try {
    return Response.json({ conversations: listConversations(getDb()) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;
  try {
    return Response.json({ conversation: createConversation(getDb()) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
