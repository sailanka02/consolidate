import { getDb } from "@/lib/db";
import { deleteConversation, getConversation, listMemory, listMessages } from "@/lib/db/repo";
import { requireAuth } from "@/lib/auth";
import { errorResponse } from "@/lib/server";

export async function GET(req: Request, ctx: RouteContext<"/api/conversations/[id]">) {
  const denied = requireAuth(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const db = getDb();
    const conversation = getConversation(db, id);
    if (!conversation) return Response.json({ error: "Conversation not found." }, { status: 404 });
    return Response.json({ conversation, messages: listMessages(db, id), memory: listMemory(db, id) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/conversations/[id]">) {
  const denied = requireAuth(req);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    deleteConversation(getDb(), id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
