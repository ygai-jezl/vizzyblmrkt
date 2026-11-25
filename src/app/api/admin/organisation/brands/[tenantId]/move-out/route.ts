import { NextResponse } from "next/server";
import { integrationsAdmin } from "@/lib/integrations/admin";
import { isOrganisationJoinEnabled } from "@/lib/plans/flags";
import { respond } from "@/lib/connectors/http";
import { moveBrandOut, MoveOutParamSchema } from "@/lib/connectors/organisationBrands";
import { joinOff, organisationOwner } from "@/lib/connectors/organisationHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ tenantId: string }> };

/**
 * Move out (ORGANISATION_JOIN_ENABLED): the brand in the address leaves the organisation of the
 * brand the owner is in, for an organisation of its own on the same plan with the owner as its only
 * owner. The owner needs a real admin row for the brand; its parts from this organisation end.
 */
export async function POST(req: Request, { params }: Ctx) {
  if (!isOrganisationJoinEnabled()) return joinOff();
  const gate = await integrationsAdmin(req, { adminOnly: true, withHome: true });
  if (!gate.ok) return gate.response;
  const o = await organisationOwner(gate);
  if (!o.ok) return o.response;
  const tenantId = MoveOutParamSchema.safeParse((await params).tenantId);
  if (!tenantId.success) return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: { "cache-control": "no-store" } });
  return respond(await moveBrandOut(o.owner, tenantId.data));
}
