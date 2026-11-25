import { NextResponse } from "next/server";
import { integrationsAdmin } from "@/lib/integrations/admin";
import { isOrganisationJoinEnabled } from "@/lib/plans/flags";
import { jsonBody, respond } from "@/lib/connectors/http";
import { bringBrandIn, BringInBodySchema, organisationBrandsScreen } from "@/lib/connectors/organisationBrands";
import { joinOff, organisationOwner } from "@/lib/connectors/organisationHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Settings › Organisation › Brands (ORGANISATION_JOIN_ENABLED): the organisation's brands in every
 * region, and the brands this owner could bring in. Owners who are admins of the brand they are
 * in, read live; the organisation is the session brand's own.
 */
export async function GET(req: Request) {
  if (!isOrganisationJoinEnabled()) return joinOff();
  const gate = await integrationsAdmin(req, { adminOnly: true, withHome: true });
  if (!gate.ok) return gate.response;
  const o = await organisationOwner(gate);
  if (!o.ok) return o.response;
  return NextResponse.json(await organisationBrandsScreen(o.owner), { status: 200, headers: { "cache-control": "no-store" } });
}

/**
 * Bring in a brand you run. Body: { tenantId }. The brand joins the organisation of the brand the
 * owner is in, never one the request names; the owner must own the organisation it is in now and
 * have a real admin row for it, and nothing may narrow.
 */
export async function POST(req: Request) {
  if (!isOrganisationJoinEnabled()) return joinOff();
  const gate = await integrationsAdmin(req, { adminOnly: true, withHome: true });
  if (!gate.ok) return gate.response;
  const o = await organisationOwner(gate);
  if (!o.ok) return o.response;
  const parsed = BringInBodySchema.safeParse(await jsonBody(req));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: { "cache-control": "no-store" } });
  return respond(await bringBrandIn(o.owner, parsed.data.tenantId));
}
