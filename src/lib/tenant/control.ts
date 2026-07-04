import type { z } from "zod";
import { FieldValue } from "firebase-admin/firestore";
import { getDb, isAlreadyExists } from "./firestore";
import type { FirestoreLike } from "./types";
import { TenantIsolationError } from "./errors";
import { deriveFaviconUrl } from "./favicon";
import {
  TenantSchema,
  EmailSenderConfigSchema,
  type Tenant,
  type EmailSenderConfig,
  type GitConnection,
  type SocialConnection,
  type Region,
} from "@/lib/types/tenant";
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

/** Store/replace a tenant's encrypted git OAuth connection (control-plane). */
export async function setTenantGitConnection(
  id: string,
  provider: "github" | "gitlab",
  conn: GitConnection,
): Promise<void> {
  await getDb()
    .collection("tenants")
    .doc(id)
    .update({
      [`gitConnections.${provider}`]: conn,
      updatedAt: new Date().toISOString(),
    });
}

/** Remove a tenant's git OAuth connection for a provider. */
export async function deleteTenantGitConnection(
  id: string,
  provider: "github" | "gitlab",
): Promise<void> {
  await getDb()
    .collection("tenants")
    .doc(id)
    .update({
      [`gitConnections.${provider}`]: FieldValue.delete(),
      updatedAt: new Date().toISOString(),
    });
}

/** Store (or replace) a tenant's social OAuth connection for a platform. */
export async function setTenantSocialConnection(
  id: string,
  platform: "x" | "instagram" | "linkedin" | "linkedin_org",
  conn: SocialConnection,
): Promise<void> {
  await getDb()
    .collection("tenants")
    .doc(id)
    .update({
      [`socialConnections.${platform}`]: conn,
      updatedAt: new Date().toISOString(),
    });
}

/** Remove a tenant's social OAuth connection for a platform (+ its webhook map). */
export async function deleteTenantSocialConnection(
  id: string,
  platform: "x" | "instagram" | "linkedin" | "linkedin_org",
): Promise<void> {
  const ref = getDb().collection("tenants").doc(id);
  // Read the connection's userId first so we can also drop the attribution map entry.
  const snap = await ref.get();
  const conns = (snap.data()?.socialConnections ?? {}) as Record<string, { userId?: string }>;
  const userId = conns[platform]?.userId;
  // Remove the attribution map FIRST (not swallowed): if this fails the disconnect
  // aborts and is retryable, rather than orphaning a subscription that would keep
  // routing inbound engagement to a now-disconnected tenant.
  if (typeof userId === "string" && userId) {
    await deleteSocialSubscription(platform, userId);
  }
  await ref.update({
    [`socialConnections.${platform}`]: FieldValue.delete(),
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Reverse index `platform:userId → tenant`, in the control-plane DB. Inbound
 * engagement webhooks (X Account Activity) identify only the connected ACCOUNT
 * (for_user_id), so this O(1) lookup attributes an event to a tenant + region with
 * no scan. Written when an account connects, removed on disconnect.
 */
export interface SocialSubscription {
  tenantId: string;
  region: Region;
  platform: "x" | "instagram" | "linkedin";
  userId: string;
  handle?: string;
  connectedAt: string;
}
const SOCIAL_SUBSCRIPTIONS = "social_subscriptions";
const socialSubId = (platform: string, userId: string) => `${platform}:${userId}`;

/**
 * Claim the attribution map for an account, transactionally. First-active-connector-
 * wins: if the account is already mapped to a DIFFERENT tenant, we do NOT silently
 * reroute its inbound engagement (both parties proved OAuth ownership; the current
 * holder keeps attribution until it disconnects, which frees the map). Returns
 * "held_by_other" in that case so the caller can surface it.
 */
export async function setSocialSubscription(
  sub: SocialSubscription,
): Promise<"set" | "held_by_other"> {
  const db = getDb();
  const ref = db.collection(SOCIAL_SUBSCRIPTIONS).doc(socialSubId(sub.platform, sub.userId));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? (snap.data() as SocialSubscription) : null;
    if (existing && existing.tenantId !== sub.tenantId) {
      return "held_by_other";
    }
    tx.set(ref, { ...sub, updatedAt: new Date().toISOString() });
    return "set";
  });
}

export async function getSocialSubscription(
  platform: string,
  userId: string,
): Promise<SocialSubscription | null> {
  const snap = await getDb()
    .collection(SOCIAL_SUBSCRIPTIONS)
    .doc(socialSubId(platform, userId))
    .get();
  return snap.exists ? (snap.data() as SocialSubscription) : null;
}

export async function deleteSocialSubscription(platform: string, userId: string): Promise<void> {
  await getDb().collection(SOCIAL_SUBSCRIPTIONS).doc(socialSubId(platform, userId)).delete();
}

/**
 * Atomically read-modify-write a tenant's `emailSenderConfig` inside a Firestore
 * transaction. The `domains[]` array has several concurrent writers — the domain
 * auto-poll, manual Verify, add-domain, and the web-routing DNS challenge — all
 * mutating the same map field, so a plain read-modify-write loses updates (the
 * last writer overwrites the whole array). `mutate` receives the FRESHEST config
 * read inside the transaction and returns the next one; returning it unchanged is
 * a valid no-op-ish write. Returns the persisted config.
 */
export async function updateTenantSenderConfig(
  id: string,
  mutate: (current: EmailSenderConfig) => EmailSenderConfig,
): Promise<EmailSenderConfig> {
  const db = getDb();
  const ref = db.collection("tenants").doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = EmailSenderConfigSchema.parse(snap.data()?.emailSenderConfig ?? {});
    const next = mutate(current);
    tx.update(ref, { emailSenderConfig: next, updatedAt: new Date().toISOString() });
    return next;
  });
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
