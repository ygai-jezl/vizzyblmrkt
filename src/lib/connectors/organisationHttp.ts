import { NextResponse } from "next/server";
import { verifiedPersonOf, type TenantContext } from "@/lib/tenant";
import type { TenantRole } from "@/lib/types/tenantUser";
import { organisationOwnerOf, type OrganisationOwner } from "./organisationOwner";

/**
 * Responses for the organisation routes (Connectors 3, ADR-0014), under /api/admin/organisation.
 * Each route checks its switch first (CONNECTORS_SHARING_ENABLED for connections), then the
 * integrations gate with the origin check and the admin role of the brand the person is in, then
 * the owner check here, read live: an owner of that brand's organisation and an admin of the brand
 * (isBrandAdminLive). src/lib/connectors/organisationRoutesGate.test.ts holds every route to it.
 */

/** With sharing off every organisation connection route answers 404, as if it weren't there. */
export function sharingOff(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
}

export const NOT_OWNER_MESSAGE = "Only an owner of your organisation can do this. Ask an owner.";

/**
 * The person as an owner of their brand's organisation, read live, or the response that refuses
 * them: 404 when the brand has no organisation (or plans read none), 403 when they aren't an owner
 * or aren't an admin of the brand they are in.
 */
export async function organisationOwner(gate: { ctx: TenantContext; home: { tenantId: string; role: TenantRole | undefined } }): Promise<{ ok: true; owner: OrganisationOwner } | { ok: false; response: NextResponse }> {
  const person = verifiedPersonOf({ ctx: gate.ctx, homeTenantId: gate.home.tenantId, homeRole: gate.home.role });
  if (!person) return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const r = await organisationOwnerOf(gate.ctx, person);
  if (r.ok) return r;
  if (r.why === "no_organisation") return { ok: false, response: NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } }) };
  if (r.why === "not_owner") return { ok: false, response: NextResponse.json({ error: "not_owner", message: NOT_OWNER_MESSAGE }, { status: 403, headers: { "cache-control": "no-store" } }) };
  return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } }) };
}
