import { NextResponse } from "next/server";
import { integrationsHopAdmin } from "@/lib/integrations/admin";
import { isConnectorsEnabled } from "@/lib/connectors/flags";
import { humanActor } from "@/lib/connectors/grants";
import { connectorsOff } from "@/lib/connectors/http";
import type { SignInReason } from "@/lib/connectors/messages";
import { CALLBACK_PATH, finishSignIn, organisationReturnPath, signInReturnPath } from "@/lib/connectors/signIn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where Google sends the browser back after Sign in with Google. Google's redirect is cross-site,
 * so there is no origin check here: the signed state, this attempt's cookie, the single use
 * server record, the admin match and PKCE do that job (src/lib/connectors/signIn.ts). Admins
 * only. Every answer is a redirect into the app by path (never built from the request's host),
 * with no code or token in it, and clears this attempt's cookie when the state names it. A sign in
 * made for an organisation (Connectors 3) comes back here too, and goes on to Settings ›
 * Organisation, whether it finished or not, so the owner stays where they acted. Only when that
 * page can't show it (the person is no longer an owner, or sharing is off) does it go back to the
 * connector's Listing, as a brand's does.
 */
/** Failures Settings › Organisation can't show: its page is for owners while sharing is on. */
const LISTING_ONLY: ReadonlySet<SignInReason> = new Set(["not_owner", "sharing_off", "forbidden", "bad_state"]);

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
  if (!done.ok) {
    const back = done.organisation && !LISTING_ONLY.has(done.reason) ? organisationReturnPath({ status: "error", reason: done.reason }) : signInReturnPath(done.connectorId, { status: "error", reason: done.reason });
    return redirect(back, done.cookieName);
  }
  if (done.organisation) {
    const params = done.reconnected ? { status: "signed_in_again", connection: done.connectionId, ...(done.unreadable ? { unreadable: String(done.unreadable) } : {}) } : { status: "connected", connection: done.connectionId };
    return redirect(organisationReturnPath(params), done.cookieName);
  }
  return redirect(
    signInReturnPath(done.connectorId, { status: "connected", connection: done.connectionId, ...(done.reconnected ? { reconnected: "1" } : {}) }),
    done.cookieName,
  );
}
