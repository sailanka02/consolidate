import { requireAuth } from "@/lib/auth";
import { configuredModels } from "@/lib/model/config";
import { devToolsEnabled } from "@/lib/server";

// Model names only, and only for a signed-in visitor. The API key is never included in any response.
export async function GET(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;
  const provider = process.env.MODEL_PROVIDER || "claude-code";
  const { main, utility } = configuredModels();
  return Response.json({ provider, model: main ?? "provider default", utilityModel: utility, devTools: devToolsEnabled() });
}
