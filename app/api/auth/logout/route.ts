import { clearedSessionCookie } from "@/lib/auth";

export async function POST() {
  const res = Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  res.headers.append("Set-Cookie", clearedSessionCookie());
  return res;
}
