import { NextResponse } from "next/server";
import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsSharingEnabled } from "@/lib/connectors/flags";
import { jsonBody, respond } from "@/lib/connectors/http";
import { connectOrganisationToken, OrganisationConnectBodySchema, sharedConnectionsScreen, shareConnectOrganisation } from "@/lib/connectors/organisationConnect";
import { organisationOwner, sharingOff } from "@/lib/connectors/organisationHttp";
import { startOrganisationSignIn } from "@/lib/connectors/signIn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Settings › Organisation › Shared connections (CONNECTORS_SHARING_ENABLED): the organisation's
 * connections from every region, and who gets which part. Owners who are admins of the brand they
 * are in, read live; the organisation is the session brand's own.
 */
export async function GET(req: Request) {
  if (!isConnectorsSharingEnabled()) return sharingOff();
  const gate = await integrationsAdmin(req, { adminOnly: true, withHome: true });
  if (!gate.ok) return gate.response;
  const o = await organisationOwner(gate);
  if (!o.ok) return o.response;
  return NextResponse.json(await sharedConnectionsScreen(o.owner), { status: 200, headers: { "cache-control": "no-store" } });
}

/**
 * Connect for the organisation. Body: { connectorId, method, fields?, label? }: a pasted token's
 * secret fields (token_fields), a Google address made for the organisation (share_access), or
 * Sign in with Google (oauth_pkce), which answers Google's address and sets this attempt's cookie.
 * Kept in the region of the brand the owner is in; the request never names a region.
 */
export async function POST(req: Request) {
  if (!isConnectorsSharingEnabled()) return sharingOff();
  const gate = await integrationsAdmin(req, { adminOnly: true, withHome: true });
  if (!gate.ok) return gate.response;
  const o = await organisationOwner(gate);
  if (!o.ok) return o.response;
  const parsed = OrganisationConnectBodySchema.safeParse(await jsonBody(req));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: { "cache-control": "no-store" } });
  const body = parsed.data;
  if (body.method === "token_fields") return respond(await connectOrganisationToken(o.owner, body));
  if (body.method === "share_access") return respond(await shareConnectOrganisation(o.owner, body));
  const started = await startOrganisationSignIn(o.owner, body.connectorId, null, req.headers);
  if (!started.ok) return respond(started);
  const { url, cookie } = started.value;
  const res = NextResponse.json({ url }, { status: 200, headers: { "cache-control": "no-store" } });
  res.cookies.set(cookie.name, cookie.value, { httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite, path: cookie.path, maxAge: cookie.maxAge });
  return res;
}
