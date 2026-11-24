import { NextResponse } from "next/server";
import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsEnabled } from "@/lib/connectors/flags";
import { humanActor } from "@/lib/connectors/grants";
import { connectorsOff, jsonBody, respond } from "@/lib/connectors/http";
import { startSignIn } from "@/lib/connectors/signIn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start a sign in with Google for a connector (Search Console). Admins only, same origin. Answers
 * Google's address for the browser to go to, and sets this attempt's own httpOnly cookie (the
 * nonce and the PKCE verifier), SameSite=Lax and path scoped to the callback, for 10 minutes.
 * Body: { connectionId? } to sign in again for an existing connection.
 */
export async function POST(req: Request, { params }: { params: Promise<{ connectorId: string }> }) {
  if (!isConnectorsEnabled()) return connectorsOff();
  const gate = await integrationsAdmin(req, { adminOnly: true });
  if (!gate.ok) return gate.response;
  const { connectorId } = await params;
  const started = await startSignIn(gate.ctx, humanActor(gate.ctx), connectorId, await jsonBody(req), req.headers);
  if (!started.ok) return respond(started);
  const { url, cookie } = started.value;
  const res = NextResponse.json({ url }, { status: 200, headers: { "cache-control": "no-store" } });
  res.cookies.set(cookie.name, cookie.value, { httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite, path: cookie.path, maxAge: cookie.maxAge });
  return res;
}
