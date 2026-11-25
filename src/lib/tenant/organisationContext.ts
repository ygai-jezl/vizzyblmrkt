import { getOrganisation } from "./organisations";
import { getTenantById, getTenantMembership } from "./registry";
import type { FirestoreLike, TenantContext } from "./types";
import type { Organisation } from "@/lib/types/organisation";
import type { Tenant } from "@/lib/types/tenant";
import type { TenantRole } from "@/lib/types/tenantUser";

/**
 * Who may act for an organisation (Connectors 3, ADR-0015), read live on every action, never from
 * the session's claims and never from a request (ADR-0009's ADR-0003 P2 note):
 *
 * - The organisation is the one the session brand's own registry record names, and it must list
 *   the brand back. Its owners are its `ownerIds` (until piece M brings roles).
 * - `isBrandAdminLive`: an admin of a brand is someone with a `tenant_users` row with role admin
 *   for it, or, for the brand they first signed in with (their verified home brand, which has no
 *   row), whose verified session claims say admin. That second case carries ADR-0003 P2: claims
 *   last up to 5 days and no role can be lowered today, so nothing is exposed now; before piece M
 *   lets a role be lowered, it must revoke refresh tokens or read live claims, and this follows.
 * - `isBrandAdminByRow`: the row alone, for moving brands between organisations (pick 16), where
 *   claims decide nothing; `mayMoveBrand` puts it together with the owners of the brand's
 *   organisation, both read live.
 *
 * Reads the control database only. The routes build the person from getAdminContextWithHome
 * (src/lib/auth/session.ts) and check the switches first.
 */

export interface OrganisationContext {
  organisation: Organisation;
  /** The session brand's registry record, read live. */
  brand: Tenant;
  userId: string;
  /** In `ownerIds`, read live. */
  isOwner: boolean;
}

/**
 * The organisation of the brand the person is in, and whether they own it. Null without a signed in
 * person, for a missing or suspended brand, for a brand with no organisation, or when the
 * organisation doesn't list the brand back (drift, which --check reports: nothing is shown).
 */
export async function organisationContextFor(ctx: TenantContext, db?: FirestoreLike): Promise<OrganisationContext | null> {
  if (!ctx.userId) return null;
  const brand = db ? await getTenantById(ctx.tenantId, db) : await getTenantById(ctx.tenantId);
  if (!brand || brand.status === "suspended" || !brand.organisationId) return null;
  const organisation = db ? await getOrganisation(brand.organisationId, db) : await getOrganisation(brand.organisationId);
  if (!organisation || !organisation.brandIds.includes(brand.id)) return null;
  return { organisation, brand, userId: ctx.userId, isOwner: organisation.ownerIds.includes(ctx.userId) };
}

/** The signed in person as the verified session says: their user id, home brand and its claims' role. */
export interface VerifiedPerson {
  userId: string;
  homeTenantId: string;
  homeRole: TenantRole | undefined;
}

/** The person from getAdminContextWithHome's answer, or null without a user id. */
export function verifiedPersonOf(session: { ctx: TenantContext; homeTenantId: string; homeRole?: TenantRole }): VerifiedPerson | null {
  if (!session.ctx.userId || !session.homeTenantId) return null;
  return { userId: session.ctx.userId, homeTenantId: session.homeTenantId, homeRole: session.homeRole };
}

/** A `tenant_users` row with role admin for the brand, read live. */
export async function isBrandAdminByRow(userId: string, tenantId: string, db?: FirestoreLike): Promise<boolean> {
  if (!userId || !tenantId) return false;
  const row = db ? await getTenantMembership(userId, tenantId, db) : await getTenantMembership(userId, tenantId);
  return row?.role === "admin";
}

/**
 * Whether the person is an admin of the brand, read live (pick 5): a `tenant_users` row with role
 * admin, or the brand is their verified home brand and its claims say admin.
 */
export async function isBrandAdminLive(person: VerifiedPerson, tenantId: string, db?: FirestoreLike): Promise<boolean> {
  if (await isBrandAdminByRow(person.userId, tenantId, db)) return true;
  return tenantId === person.homeTenantId && person.homeRole === "admin";
}

/**
 * Why the person may not move a brand between organisations:
 * - `no_brand`: the brand is missing or suspended;
 * - `no_organisation`: it has no organisation, or its organisation doesn't list it back (drift);
 * - `not_owner`: the person isn't an owner of the organisation the brand is in now;
 * - `home_only`: they have no admin row for it, and reach it only as the brand they first signed in
 *   with (their verified home brand, whose claims decide nothing here);
 * - `not_admin`: they have no `tenant_users` row with role admin for it.
 */
export type BrandMoveRefusal = "no_brand" | "no_organisation" | "not_owner" | "home_only" | "not_admin";

/**
 * A refusal for want of an admin row also carries the brand: the person owns its organisation, so
 * its name may be shown to them.
 */
export type BrandMoveCheck = { ok: true; brand: Tenant; organisation: Organisation } | { ok: false; why: BrandMoveRefusal; brand?: Tenant };

/**
 * Whether the person may move a brand out of the organisation it is in now (Bring in elsewhere, or
 * Move out to one of its own: pick 16), read live on every action and never from a request or the
 * session's claims: the brand's own registry record (uncached), the organisation it names, which
 * must list it back, the person in that organisation's `ownerIds`, and a real `tenant_users` row
 * with role admin for the brand. The home brand's claims are not enough here, unlike giving a part
 * (isBrandAdminLive): claims last up to 5 days and no role can be lowered today, so a privileged
 * plan change takes the live row only (ADR-0003 P2, ADR-0015). The organisation the brand would go
 * into is the caller's to check. A read error throws, so nothing is decided on it.
 */
export async function mayMoveBrand(person: VerifiedPerson, tenantId: string, db?: FirestoreLike): Promise<BrandMoveCheck> {
  if (!person.userId || !tenantId) return { ok: false, why: "no_brand" };
  const brand = db ? await getTenantById(tenantId, db) : await getTenantById(tenantId);
  if (!brand || brand.status === "suspended") return { ok: false, why: "no_brand" };
  if (!brand.organisationId) return { ok: false, why: "no_organisation" };
  const organisation = db ? await getOrganisation(brand.organisationId, db) : await getOrganisation(brand.organisationId);
  if (!organisation || !organisation.brandIds.includes(brand.id)) return { ok: false, why: "no_organisation" };
  if (!organisation.ownerIds.includes(person.userId)) return { ok: false, why: "not_owner" };
  if (!(await isBrandAdminByRow(person.userId, brand.id, db))) return { ok: false, why: tenantId === person.homeTenantId ? "home_only" : "not_admin", brand };
  return { ok: true, brand, organisation };
}
