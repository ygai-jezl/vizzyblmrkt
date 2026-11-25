import { z } from "zod";
import {
  attachBrandToOrganisation,
  getOrganisation,
  getTenantById,
  getTenantsForUser,
  isBrandAdminByRow,
  listOrganisationConnections,
  mayMoveBrand,
  type BrandMoveRefusal,
} from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { allowanceLimit, planById } from "@/lib/plans/catalog";
import { accessChanges } from "@/lib/plans/preview";
import { MAX_ORGANISATION_BRANDS, type Organisation, type PlanId } from "@/lib/types/organisation";
import type { OrganisationConnection } from "@/lib/types/organisationConnection";
import type { Tenant } from "@/lib/types/tenant";
import { bringInDoneWords, BRANDS_COPY, fullWords, moveRefusalWords, narrowerWords } from "@/components/admin/connectors/words";
import { disconnectEmptiedOrganisation, endBrandParts, type OrganisationActionDeps } from "./organisation";
import { regionName } from "./organisationConnect";
import type { OrganisationOwner } from "./organisationOwner";
import type { ServiceResult } from "./service";
import { storesOf } from "./sources";

/**
 * Settings › Organisation › Brands (Connectors 3 group 4, ORGANISATION_JOIN_ENABLED, ADR-0014): the
 * organisation's brands in every region, Bring in a brand you run, and Move out.
 *
 * - Who: an owner of the organisation of the brand they are in who is an admin of it (the routes'
 *   owner check), and for the brand moved, an owner of the organisation it is in now with a real
 *   tenant_users row with role admin for it (mayMoveBrand): never the session's claims, so a brand
 *   someone reaches only as their home brand can't be moved here (pick 16).
 * - Bring in takes the organisation's plan and refuses anything narrower (the plans preview, read
 *   only: decision 20), and the plan's brands allowance; both, and the brand still being where its
 *   owners were checked, are held inside the move's transaction (attachBrandToOrganisation).
 * - Every move ends the brand's parts from the organisation it leaves, in every region, and
 *   disconnects the connections of an organisation it leaves with no brands, whatever sharing says
 *   (picks 10 and 21). A failure there is left to the lane's housekeeping and sweep, and every
 *   part already reads nothing (partLive) from the moment the brand moved.
 * - Names of brands and organisations reach only someone who owns both sides. Nobody's name or
 *   email crosses brands.
 */

export type OrganisationBrandsDeps = OrganisationActionDeps;

/** At most this many brands and admin rows are read for one screen, a few at a time. */
const READ_LIMIT = 100;

/** One of the organisation's brands on the Brands section. */
export interface OrganisationBrandView {
  id: string;
  name: string;
  regionName: string;
  /** The brand the owner is in now. */
  isThis: boolean;
  /** The connectors of the parts this organisation gives it, in every region; null when they couldn't be read now. */
  parts: string[] | null;
  /** Where the organisation's connections connected from this brand are kept: they stay, and keep serving the others. */
  keptFrom: string[];
  /** Why Move out would be refused for this owner: no admin row (claims decide nothing here). */
  moveRefusal: Extract<BrandMoveRefusal, "home_only" | "not_admin"> | null;
}

/** A brand the owner could bring in: in another organisation they own, with an admin row for it. */
export interface BringInCandidate {
  id: string;
  name: string;
  regionName: string;
  organisation: { id: string; name: string; planName: string; alone: boolean };
  /** What taking this organisation's plan would narrow: a feature lost, or only a lower cap. Null: nothing. */
  narrower: "features" | "caps" | null;
  /** The connectors of its parts from the organisation it leaves; null when they couldn't be read now. */
  parts: string[] | null;
  /** The connections the organisation it leaves holds, disconnected when this leaves it with no brands. */
  emptiedConnections: number;
}

export interface OrganisationBrandsScreen {
  organisation: { id: string; name: string; planName: string };
  brand: { id: string; name: string };
  brands: OrganisationBrandView[];
  candidates: BringInCandidate[];
  /** At the plan's brands allowance: Bring in needs a plan change first. */
  full: { limit: number } | null;
}

const controlOf = (deps: OrganisationBrandsDeps): FirestoreLike | undefined => deps.controlDb ?? deps.db;
const planName = (id: PlanId) => planById(id)?.name ?? id;
// An undefined database falls back to each reader's own default (the control database).
const tenantOf = (id: string, deps: OrganisationBrandsDeps) => getTenantById(id, controlOf(deps));
const organisationOf = (id: string, deps: OrganisationBrandsDeps) => getOrganisation(id, controlOf(deps));
const warn = (what: string, err: unknown) => console.warn(`[organisation] ${what}:`, err instanceof Error ? err.message.slice(0, 200) : "error");

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

/** An organisation's connected connections in every region, or null when a region can't be read now. */
async function connectedOf(organisationId: string, deps: OrganisationBrandsDeps): Promise<OrganisationConnection[] | null> {
  try {
    return (await listOrganisationConnections(organisationId, {}, storesOf(deps))).filter((c) => c.status === "connected");
  } catch (err) {
    warn(`the connections of ${organisationId} didn't load`, err);
    return null;
  }
}

/** The connectors of the parts a brand has from these connections (a part being taken back is gone already). */
const partsFor = (conns: readonly OrganisationConnection[] | null, tenantId: string): string[] | null =>
  conns ? conns.flatMap((c) => c.parts.filter((p) => p.tenantId === tenantId && p.state !== "ending").map(() => c.connectorId)) : null;

/**
 * What taking `plan` would narrow for a brand: the plans preview's answer, read only (a feature the
 * brand reaches lost, or a lower cap), and a feature its own plan lists that `plan` doesn't. The
 * preview counts only the features brands reach today, so the second catches the Enterprise
 * features (Enterprise to Ultra turns them off).
 */
export function narrowerOf(brand: Pick<Tenant, "grantedFeatures" | "featureLimits" | "orgPlan">, plan: PlanId): BringInCandidate["narrower"] {
  const changes = accessChanges(brand, plan);
  if (changes.features.some((f) => f.before && !f.after)) return "features";
  const was = brand.orgPlan ? planById(brand.orgPlan) : null;
  const will = planById(plan);
  if (was && will && was.features.some((f) => !will.features.includes(f))) return "features";
  return changes.narrower ? "caps" : null;
}

/** The brands allowance of an organisation's plan; null for no limit. */
function brandsLimit(org: Organisation): number {
  const plan = planById(org.plan);
  const limit = plan ? allowanceLimit(plan, "brands") : null;
  return Math.min(limit ?? MAX_ORGANISATION_BRANDS, MAX_ORGANISATION_BRANDS);
}

/**
 * The brands the owner could bring in: their admin rows (never the home brand's claims) for brands
 * in another organisation, listing them back, that the owner also owns, read live.
 */
async function bringInCandidates(owner: OrganisationOwner, deps: OrganisationBrandsDeps): Promise<BringInCandidate[]> {
  const rows = await getTenantsForUser(owner.person.userId, controlOf(deps));
  const ids = [...new Set(rows.filter((r) => r.role === "admin" && !owner.organisation.brandIds.includes(r.tenantId)).map((r) => r.tenantId))].slice(0, READ_LIMIT);
  const orgs = new Map<string, Promise<Organisation | null>>();
  const conns = new Map<string, Promise<OrganisationConnection[] | null>>();
  const once = <T>(m: Map<string, Promise<T>>, id: string, load: () => Promise<T>) => {
    let hit = m.get(id);
    if (!hit) m.set(id, (hit = load()));
    return hit;
  };
  const out = await mapLimit(ids, 5, async (id): Promise<BringInCandidate | null> => {
    try {
      const t = await tenantOf(id, deps);
      if (!t || t.status === "suspended" || !t.organisationId || t.organisationId === owner.organisation.id) return null;
      const from = await once(orgs, t.organisationId, () => organisationOf(t.organisationId!, deps));
      if (!from || !from.brandIds.includes(t.id) || !from.ownerIds.includes(owner.person.userId)) return null;
      const held = await once(conns, from.id, () => connectedOf(from.id, deps));
      const alone = from.brandIds.length === 1;
      return {
        id: t.id,
        name: t.tenantName,
        regionName: regionName(t.region),
        organisation: { id: from.id, name: from.name, planName: planName(from.plan), alone },
        narrower: narrowerOf(t, owner.organisation.plan),
        parts: partsFor(held, t.id),
        emptiedConnections: alone ? (held?.length ?? 0) : 0,
      };
    } catch (err) {
      warn(`a brand to bring in didn't load`, err);
      return null;
    }
  });
  return out.filter((c): c is BringInCandidate => c !== null).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Settings › Organisation › Brands for an owner: the organisation's brands that point back, in
 * every region, the parts each is given, whether Move out would be refused, and the brands they
 * could bring in. Read live.
 */
export async function organisationBrandsScreen(owner: OrganisationOwner, deps: OrganisationBrandsDeps = {}): Promise<OrganisationBrandsScreen> {
  const org = owner.organisation;
  const control = controlOf(deps);
  const [held, candidates] = await Promise.all([connectedOf(org.id, deps), bringInCandidates(owner, deps)]);
  const rows = await mapLimit(org.brandIds.slice(0, READ_LIMIT), 5, async (id): Promise<OrganisationBrandView | null> => {
    try {
      const t = id === owner.brand.id ? owner.brand : await tenantOf(id, deps);
      // A listed brand whose own record points elsewhere is drift (--check reports it): not shown.
      if (!t || t.organisationId !== org.id) return null;
      const row = await isBrandAdminByRow(owner.person.userId, id, control);
      return {
        id,
        name: t.tenantName,
        regionName: regionName(t.region),
        isThis: id === owner.brand.id,
        parts: partsFor(held, id),
        keptFrom: [...new Set((held ?? []).filter((c) => c.connectedFromTenantId === id).map((c) => regionName(c.region)))],
        moveRefusal: row ? null : id === owner.person.homeTenantId ? "home_only" : "not_admin",
      };
    } catch (err) {
      warn(`a brand of ${org.id} didn't load`, err);
      return null;
    }
  });
  const limit = brandsLimit(org);
  return {
    organisation: { id: org.id, name: org.name, planName: planName(org.plan) },
    brand: { id: owner.brand.id, name: owner.brand.tenantName },
    brands: rows.filter((r): r is OrganisationBrandView => r !== null),
    candidates,
    full: org.brandIds.length >= limit ? { limit } : null,
  };
}

// --- Bring in --------------------------------------------------------------------------------------

/** Bring in: the brand, by id. The organisation it joins is the session brand's, never the request's. */
export const BringInBodySchema = z.object({ tenantId: z.string().min(1).max(128) }).strict();

const refuse = <T>(status: 403 | 404 | 409 | 503, error: string, message?: string): ServiceResult<T> => ({ ok: false, status, error, ...(message ? { message } : {}) });

/** A refused move check as the route answers it: the brand is named only to an owner of its organisation. */
export function moveRefused<T>(check: { why: BrandMoveRefusal; brand?: Tenant }, move: "out" | "in"): ServiceResult<T> {
  if (check.why === "no_brand" || check.why === "no_organisation") return refuse(404, "not_found");
  if (check.why === "not_owner") return refuse(403, "not_owner_there", BRANDS_COPY.notOwnerThere);
  return refuse(403, check.why, moveRefusalWords(check.brand?.tenantName ?? "this brand", check.why, move));
}

/** After a brand left an organisation: end its parts from it, and disconnect its connections when it is left with no brands. */
async function afterLeaving(brand: Tenant, fromOrganisationId: string, by: string, deps: OrganisationBrandsDeps): Promise<{ ended: number; disconnected: number }> {
  const out = { ended: 0, disconnected: 0 };
  try {
    out.ended = await endBrandParts({ tenantId: brand.id, region: brand.region }, { fromOrganisationId, by }, deps);
  } catch (err) {
    warn(`ending ${brand.id}'s parts from ${fromOrganisationId} failed; the lane ends them`, err);
  }
  try {
    out.disconnected = await disconnectEmptiedOrganisation(fromOrganisationId, by, deps);
  } catch (err) {
    warn(`disconnecting the connections of ${fromOrganisationId} failed; the lane's sweep does it`, err);
  }
  return out;
}

export interface MoveDone {
  message: string;
  /** Parts ended now, from the organisation it left. */
  ended: number;
  /** Connections disconnected now, of an organisation the move left with no brands. */
  disconnected: number;
}

/**
 * Bring a brand the owner runs into their organisation: they own the organisation it is in now and
 * have a real admin row for it (mayMoveBrand), it isn't narrowed by this organisation's plan, and
 * there is room under the plan's brands allowance. Then its parts from the organisation it left end,
 * and that organisation's connections are disconnected if it has no brands left.
 */
export async function bringBrandIn(owner: OrganisationOwner, tenantId: string, deps: OrganisationBrandsDeps = {}): Promise<ServiceResult<MoveDone>> {
  const control = controlOf(deps);
  const check = await mayMoveBrand(owner.person, tenantId, control);
  if (!check.ok) return moveRefused(check, "in");
  const { brand, organisation: from } = check;
  const target = owner.organisation;
  if (from.id === target.id) return refuse(409, "already", BRANDS_COPY.already);
  const limit = brandsLimit(target);
  if (target.brandIds.filter((id) => id !== tenantId).length >= limit) return refuse(409, "full", fullWords(target.name, limit, planName(target.plan)));
  const narrower = narrowerOf(brand, target.plan);
  if (narrower) return refuse(409, "narrower", narrowerWords(brand.tenantName, planName(from.plan), planName(target.plan), narrower));

  const res = await attachBrandToOrganisation(
    tenantId,
    target.id,
    { actor: owner.person.userId, maxBrands: limit, expectFrom: from.id, narrower: (b, plan) => narrowerOf(b, plan) !== null },
    control,
  );
  if (res === "full") return refuse(409, "full", fullWords(target.name, limit, planName(target.plan)));
  if (res === "narrower") return refuse(409, "narrower", narrowerWords(brand.tenantName, planName(from.plan), planName(target.plan), narrowerOf(brand, target.plan) ?? "features"));
  if (res === "already") return refuse(409, "already", BRANDS_COPY.already);
  if (res !== "moved") return refuse(409, "changed", BRANDS_COPY.changed);
  const after = await afterLeaving(brand, from.id, owner.person.userId, deps);
  return { ok: true, status: 200, value: { message: bringInDoneWords(brand.tenantName, target.name), ...after } };
}
