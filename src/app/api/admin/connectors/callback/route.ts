import { NextResponse } from "next/server";
import { integrationsHopAdmin } from "@/lib/integrations/admin";
import { isConnectorsEnabled } from "@/lib/connectors/flags";
import { humanActor } from "@/lib/connectors/grants";
import { connectorsOff } from "@/lib/connectors/http";
import { CALLBACK_PATH, finishSignIn, signInReturnPath } from "@/lib/connectors/signIn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where Google sends the browser back after Sign in with Google. Google's redirect is cross-site,
 * so there is no origin check here: the signed state, this attempt's cookie, the single use
 * server record, the admin match and PKCE do that job (src/lib/connectors/signIn.ts). Admins
 * only. Every answer is a redirect into the app by path (never built from the request's host),
 * with no code or token in it, and clears this attempt's cookie when the state names it.
 */
function redirect(path: string, cookieName: string | null): NextResponse {
  const res = new NextResponse(null, { status: 303, headers: { location: path, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  if (cookieName) res.cookies.delete({ name: cookieName, path: CALLBACK_PATH });
  return res;
}

export async function GET(req: Request) {
  if (!isConnectorsEnabled()) return connectorsOff();
  const gate = await integrationsHopAdmin();
  if (!gate.ok && gate.why === "signed_out") return redirect("/login", null);
  if (!gate.ok) return redirect(signInReturnPath(null, { status: "error", reason: "forbidden" }), null);
  const done = await finishSignIn(gate.ctx, humanActor(gate.ctx), {
    query: new URL(req.url).searchParams,
    cookieHeader: req.headers.get("cookie"),
    headers: req.headers,
  });
  if (!done.ok) return redirect(signInReturnPath(done.connectorId, { status: "error", reason: done.reason }), done.cookieName);
  return redirect(
    signInReturnPath(done.connectorId, { status: "connected", connection: done.connectionId, ...(done.reconnected ? { reconnected: "1" } : {}) }),
    done.cookieName,
  );
}
