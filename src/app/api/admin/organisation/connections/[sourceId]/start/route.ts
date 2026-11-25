import { NextResponse } from "next/server";
import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsSharingEnabled } from "@/lib/connectors/flags";
import { respond } from "@/lib/connectors/http";
import { ownedConnection } from "@/lib/connectors/organisationOwner";
import { organisationOwner, sharingOff } from "@/lib/connectors/organisationHttp";
import { startOrganisationSignIn } from "@/lib/connectors/signIn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign in again with Google for one of the organisation's connections, by any owner: answers
 * Google's address and sets this attempt's cookie. The new sign in replaces the tokens in place and
 * makes this owner its signer; the callback checks each brand's part with it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ sourceId: string }> }) {
  if (!isConnectorsSharingEnabled()) return sharingOff();
  const gate = await integrationsAdmin(req, { adminOnly: true, withHome: true });
  if (!gate.ok) return gate.response;
  const o = await organisationOwner(gate);
  if (!o.ok) return o.response;
  const { sourceId } = await params;
  const source = await ownedConnection(o.owner, sourceId);
  if (!source || source.status !== "connected") return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  const started = await startOrganisationSignIn(o.owner, source.connectorId, source.id, req.headers);
  if (!started.ok) return respond(started);
  const { url, cookie } = started.value;
  const res = NextResponse.json({ url }, { status: 200, headers: { "cache-control": "no-store" } });
  res.cookies.set(cookie.name, cookie.value, { httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite, path: cookie.path, maxAge: cookie.maxAge });
  return res;
}
