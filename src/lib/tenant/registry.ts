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
