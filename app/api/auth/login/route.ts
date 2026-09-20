import { authRequired, createSessionToken, passwordMatches, sessionCookie } from "@/lib/auth";
import { checkRate, clientIp, loginRules, rateLimited } from "@/lib/ratelimit";

// Verifies the shared demo password on the server and sets the session cookie. The password is never echoed back.
export async function POST(req: Request) {
  if (!authRequired()) return Response.json({ ok: true });
  const limited = checkRate(loginRules(clientIp(req)));
  if (!limited.ok) return rateLimited(limited, "sign-in attempts");
  const body = await req.json().catch(() => null);
  const token = passwordMatches(body?.password) ? createSessionToken() : null;
  if (!token) return Response.json({ error: "Incorrect password.", code: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const res = Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  res.headers.append("Set-Cookie", sessionCookie(token));
  return res;
}
