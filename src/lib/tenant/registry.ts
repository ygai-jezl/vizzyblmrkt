import { getDb } from "./firestore";
import type { FirestoreLike } from "./types";
import { TenantSchema, type Tenant } from "@/lib/types/tenant";
import { TenantUserSchema, type TenantUser } from "@/lib/types/tenantUser";

/**
 * GLOBAL registry access. These are the only reads that legitimately cross
 * tenant boundaries, because they answer "which tenant is this?" before any
 * tenant context exists. They are narrow, read-only, and operate solely on the
 * `tenants` / `tenant_users` registry collections. Every OTHER data access goes
 * through the tenant-scoped repository (see repository.ts).
 */

function defaultDb(): FirestoreLike {
  return getDb() as unknown as FirestoreLike;
}

/** Resolve a tenant by its document id. */
export async function getTenantById(
  id: string,
  db: FirestoreLike = defaultDb(),
): Promise<Tenant | null> {
  const snap = await db.collection("tenants").doc(id).get();
  if (!snap.exists) return null;
  return TenantSchema.parse({ id: snap.id, ...snap.data() });
}

/**
 * Resolve a tenant from a request ORIGIN (scheme + host), matched against the
 * tenant's allow-listed origins. This is how the public landing-page router
 * maps incoming domain traffic to a tenant context.
 *
 * NOTE: the Host header is client-controllable — use this for ROUTING only.
 * Never treat a resolved tenant as an authorization grant for a privileged
 * action; admin actions still require a verified ID token.
 */
export async function getTenantByOrigin(
  origin: string,
  db: FirestoreLike = defaultDb(),
): Promise<Tenant | null> {
  const snap = await db
    .collection("tenants")
    .where("allowedOrigins", "array-contains", origin)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0]!;
  return TenantSchema.parse({ id: doc.id, ...doc.data() });
}

/**
 * List EVERY tenant in the registry. Used only by trusted system jobs (e.g. the
 * scheduled email-delivery worker) that must fan out across all tenants/regions
 * — there is no single tenant context for a cron. Reads the control-plane
 * `tenants` registry; callers still build a per-tenant context to touch data.
 */
export async function listAllTenants(
  db: FirestoreLike = defaultDb(),
): Promise<Tenant[]> {
  const snap = await db.collection("tenants").get();
  return snap.docs.map((d) => TenantSchema.parse({ id: d.id, ...d.data() }));
}

/**
 * One brand as the loops lane pages through them (learning loops step 4, src/lib/loops/tick.ts):
 * only the fields it needs, read as a projection, so a page of brands stays small. The looks kept
 * on the brand record from before versions come too, for the seed and for clearing a forgotten
 * look's old copy, so a visit never reads the whole record.
 */
export interface TenantPageRow {
  id: string;
  region: Tenant["region"];
  status: Tenant["status"] | null;
  organisationId: string | null;
  orgPlan: string | null;
  grantedFeatures: string[];
  /** The brand look from before versions, and when it was written. */
  learnedImageStyle: string | null;
  learnedImageStyleUpdatedAt: string | null;
  /** Each style's look from before versions, by the style id it was kept under. */
  styleLooks: Record<string, { directive: string | null; updatedAt: string | null }>;
}

/** The fields a page of brands reads. */
export const TENANT_PAGE_FIELDS = [
  "region",
  "status",
  "organisationId",
  "orgPlan",
  "grantedFeatures",
  "brandKit.learnedImageStyle",
  "brandKit.learnedImageStyleUpdatedAt",
  "imageStyle.learned",
] as const;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A projected tenant document as a page row; a row with no readable region is left out. */
export function tenantPageRow(id: string, data: Record<string, unknown>): TenantPageRow | null {
  const region = TenantSchema.shape.region.safeParse(data.region);
  if (!region.success) return null;
  const status = TenantSchema.shape.status.safeParse(data.status);
  const styleLooks: TenantPageRow["styleLooks"] = {};
  for (const [style, entry] of Object.entries(obj(obj(data.imageStyle).learned))) {
    const e = obj(entry);
    styleLooks[style] = { directive: str(e.directive), updatedAt: str(e.updatedAt) };
  }
  return {
    id,
    region: region.data,
    status: status.success ? status.data : null,
    organisationId: str(data.organisationId),
    orgPlan: str(data.orgPlan),
    grantedFeatures: Array.isArray(data.grantedFeatures) ? data.grantedFeatures.filter((g): g is string => typeof g === "string") : [],
    learnedImageStyle: str(obj(data.brandKit).learnedImageStyle),
    learnedImageStyleUpdatedAt: str(obj(data.brandKit).learnedImageStyleUpdatedAt),
    styleLooks,
  };
}

/**
 * A page of brands in document id order, after `after` (null for the first page), projected to
 * TENANT_PAGE_FIELDS: the loops lane's way through every brand, one page a run, instead of the
 * whole registry each run. Cross brand on purpose, like the other reads here: it answers which
 * brands exist, and each visit then works through forTenant with that brand's own context.
 */
export async function listTenantPage(after: string | null, limit: number, db: FirestoreLike = defaultDb()): Promise<TenantPageRow[]> {
  let q = db.collection("tenants").orderBy("__name__", "asc");
  if (after) q = q.startAfter(after);
  q = q.limit(Math.max(1, Math.min(500, Math.floor(limit))));
  if (q.select) q = q.select(...TENANT_PAGE_FIELDS);
  const snap = await q.get();
  return snap.docs.flatMap((d) => {
    const row = tenantPageRow(d.id, d.data());
    return row ? [row] : [];
  });
}

/** One brand as a page row (the person actions' Forget reads its old looks this way), or null. */
export async function getTenantPageRow(id: string, db: FirestoreLike = defaultDb()): Promise<TenantPageRow | null> {
  const snap = await db.collection("tenants").doc(id).get();
  return snap.exists ? tenantPageRow(snap.id, snap.data() ?? {}) : null;
}

/** How many brands the registry holds: one count() read, for the lane's page size. */
export async function countTenants(db: FirestoreLike = defaultDb()): Promise<number> {
  const snap = await db.collection("tenants").count().get();
  return snap.data().count;
}

/** How many brands are suspended: one count() read on one field (a single field index), for the brands the lane lists. */
export async function countSuspendedTenants(db: FirestoreLike = defaultDb()): Promise<number> {
  const snap = await db.collection("tenants").where("status", "==", "suspended").count().get();
  return snap.data().count;
}

/**
 * Resolve the tenant(s) whose email sending uses a given MailChimp audience
 * (list) id. Used by the MailChimp audience webhook to map an unsubscribe/clean
 * event (which carries only the email + `list_id`) back to the owning tenant,
 * WITHOUT baking tenant ids into the webhook URL — so onboarding a new tenant
 * with its own audience needs no webhook change. A tenant "owns" an audience via
 * its per-tenant `emailSenderConfig`? no — via `mailchimpConfig.audienceId`
 * (BYO/dedicated audiences). Tenants on the shared platform audience leave that
 * unset (they use the env-level config), so they aren't matched here — the
 * webhook resolves them from MAILCHIMP_SHARED_AUDIENCE_TENANTS instead.
 *
 * Single-field equality on a nested map field → served by Firestore's default
 * indexing, so it scales to any tenant count with one indexed read.
 */
export async function getTenantsByMailchimpAudience(
  audienceId: string,
  db: FirestoreLike = defaultDb(),
): Promise<Tenant[]> {
  if (!audienceId) return [];
  const snap = await db
    .collection("tenants")
    .where("mailchimpConfig.audienceId", "==", audienceId)
    .get();
  return snap.docs.map((d) => TenantSchema.parse({ id: d.id, ...d.data() }));
}

/** List every tenant association for a logged-in user (single fast read). */
export async function getTenantsForUser(
  userId: string,
  db: FirestoreLike = defaultDb(),
): Promise<TenantUser[]> {
  const snap = await db
    .collection("tenant_users")
    .where("userId", "==", userId)
    .get();
  return snap.docs.map((d) => TenantUserSchema.parse({ id: d.id, ...d.data() }));
}

/**
 * Resolve a SINGLE user↔tenant membership, or null if the user is not a member.
 * Narrower (and cheaper) than getTenantsForUser — used on the per-request auth
 * path to re-authorize a tenant the active_tenant cookie names as a candidate.
 */
export async function getTenantMembership(
  userId: string,
  tenantId: string,
  db: FirestoreLike = defaultDb(),
): Promise<TenantUser | null> {
  const snap = await db
    .collection("tenant_users")
    .where("userId", "==", userId)
    .where("tenantId", "==", tenantId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const d = snap.docs[0]!;
  return TenantUserSchema.parse({ id: d.id, ...d.data() });
}
