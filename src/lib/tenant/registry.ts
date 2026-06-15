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
