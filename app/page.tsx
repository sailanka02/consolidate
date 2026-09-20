import { cookies } from "next/headers";
import AppShell from "@/components/AppShell";
import LoginScreen from "@/components/LoginScreen";
import { authRequired, SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

// Decided on the server for every request: a visitor without a valid session is never sent the app, only the login screen.
export const dynamic = "force-dynamic";

export default async function Home() {
  const required = authRequired();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (required && !verifySessionToken(token)) return <LoginScreen />;
  return <AppShell authEnabled={required} />;
}
