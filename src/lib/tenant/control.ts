import type { z } from "zod";
import { getDb, isAlreadyExists } from "./firestore";
import type { FirestoreLike } from "./types";
import { TenantIsolationError } from "./errors";
import { deriveFaviconUrl } from "./favicon";
import { TenantSchema, type Tenant } from "@/lib/types/tenant";
import type { TenantRole } from "@/lib/types/tenantUser";

/**
 * Control-plane writes — the `tenants` registry lives in the (default) database,
 * NOT in a regional data-plane database. Creating a tenant is the one moment
 * `region` is chosen; it is immutable thereafter (Firestore DB locations can't
 * move), so there is deliberately no updateTenantRegion.
 *
 * The brand favicon is pulled in here at creation: when the caller doesn't
 * supply one, it is derived from `rootDomain`. Callers therefore never need to
 * know about favicons — every tenant gets one. (Accepts the schema INPUT type so
 * `faviconUrl` may be omitted; the default + derivation fill it in.)
 */
export async function createTenant(
  tenant: z.input<typeof TenantSchema>,
): Promise<Tenant> {
  const parsed = TenantSchema.parse(tenant);
  const created: Tenant = {
    ...parsed,
    faviconUrl: parsed.faviconUrl || deriveFaviconUrl(parsed.rootDomain),
  };
  const { id, ...rest } = created;
  try {
    await getDb().collection("tenants").doc(id).create(rest);
  } catch (err) {
    if (isAlreadyExists(err)) {
      throw new TenantIsolationError(`tenant ${id} already exists`);
    }
    throw err;
  }
  return created;
}

/**
 * Patch mutable fields on an existing tenant document (control-plane). The
 * identity/immutable fields (`id`, `region`, `createdAt`) are stripped from any
 * patch — a tenant can never be re-homed to another region. Stamps `updatedAt`.
 * Used by admin settings, e.g. the per-tenant MailChimp / email-provider config.
 */
export async function updateTenantConfig(
  id: string,
  patch: Partial<Omit<Tenant, "id" | "region" | "createdAt">>,
): Promise<void> {
  const {
    id: _i,
    region: _r,
    createdAt: _c,
    ...rest
  } = patch as Record<string, unknown>;
  await getDb()
    .collection("tenants")
    .doc(id)
    .update({ ...rest, updatedAt: new Date().toISOString() });
}

/**
 * Backfill the brand favicon on an EXISTING tenant (for docs created before the
 * field existed). Idempotent: only writes when `faviconUrl` is empty, deriving
 * it from the stored `rootDomain`. Unlike `region`, the favicon is mutable, so a
 * targeted update here is safe. Returns what it did.
 */
export async function backfillTenantFavicon(
  id: string,
): Promise<"set" | "already_set" | "not_found"> {
  const ref = getDb().collection("tenants").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return "not_found";
  const data = snap.data() ?? {};
  if (typeof data.faviconUrl === "string" && data.faviconUrl.length > 0) {
    return "already_set";
  }
  const faviconUrl = deriveFaviconUrl(String(data.rootDomain ?? ""));
  if (!faviconUrl) return "already_set"; // no domain to derive from — nothing to do
  await ref.update({ faviconUrl, updatedAt: new Date().toISOString() });
  return "set";
}

/**
 * Add an allow-listed ORIGIN to a tenant (host→tenant routing for custom
 * domains). Read-modify-write on the control-plane doc; idempotent (a duplicate
 * is a no-op). Returns whether the array actually changed. Trust/uniqueness
 * checks live in the web-routing provisioner — this is the persistence step.
 */
export async function addAllowedOrigin(
  tenantId: string,
  origin: string,
  db: FirestoreLike = getDb() as unknown as FirestoreLike,
): Promise<{ added: boolean }> {
  const ref = db.collection("tenants").doc(tenantId);
  const snap = await ref.get();
  if (!snap.exists) throw new TenantIsolationError(`tenant ${tenantId} not found`);
  const current = (snap.data()?.allowedOrigins as string[] | undefined) ?? [];
  if (current.includes(origin)) return { added: false };
  await ref.update({
    allowedOrigins: [...current, origin],
    updatedAt: new Date().toISOString(),
  });
  return { added: true };
}

/** Remove an allow-listed origin from a tenant (revoke web routing). Idempotent. */
export async function removeAllowedOrigin(
  tenantId: string,
  origin: string,
  db: FirestoreLike = getDb() as unknown as FirestoreLike,
): Promise<{ removed: boolean }> {
  const ref = db.collection("tenants").doc(tenantId);
  const snap = await ref.get();
  if (!snap.exists) return { removed: false };
  const current = (snap.data()?.allowedOrigins as string[] | undefined) ?? [];
  if (!current.includes(origin)) return { removed: false };
  await ref.update({
    allowedOrigins: current.filter((o) => o !== origin),
    updatedAt: new Date().toISOString(),
  });
  return { removed: true };
}

/**
 * Append-only audit entry for a domain web-routing grant/revoke, in the flat
 * control-plane `domain_grants` collection. Every auto-grant (incl. the
 * email-match fast path) is recorded so a domain claim is always traceable.
 */
export interface DomainGrantAudit {
  tenantId: string;
  host: string;
  action: "grant" | "revoke";
  method?: string;
  actorUid?: string;
  recaptcha?: string;
  createdAt: string;
}

export async function logDomainGrant(
  entry: DomainGrantAudit,
  db: FirestoreLike = getDb() as unknown as FirestoreLike,
): Promise<void> {
  const id = `${entry.tenantId}_${entry.host}_${entry.createdAt}`.replace(/[^\w.-]/g, "_");
  try {
    await db.collection("domain_grants").doc(id).create({ ...entry });
  } catch (err) {
    if (isAlreadyExists(err)) return; // dup audit write — fine
    throw err;
  }
}

/**
 * Record a user↔tenant membership in the flat control-plane `tenant_users`
 * collection (the writer side of getTenantsForUser / getTenantMembership). The
 * doc id is deterministic (`${tenantId}_${userId}`) so a repeat call is a no-op
 * via the atomic `create()` rather than a duplicate row — i.e. idempotent.
 */
export async function addTenantMember(
  userId: string,
  tenantId: string,
  role: TenantRole = "admin",
  db: FirestoreLike = getDb() as unknown as FirestoreLike,
): Promise<void> {
  const id = `${tenantId}_${userId}`;
  try {
    await db
      .collection("tenant_users")
      .doc(id)
      .create({ userId, tenantId, role, joinedAt: new Date().toISOString() });
  } catch (err) {
    if (isAlreadyExists(err)) return; // already a member — idempotent
    throw err;
  }
}
