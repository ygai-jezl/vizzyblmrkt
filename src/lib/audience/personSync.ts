import { forTenant, type WhereClause } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Contact, ContactCampaignLink, PersonProductLink } from "@/lib/types/contact";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import type { Signup } from "@/lib/types/signup";
import { normalizeEmail } from "@/lib/waitlist/identifiers";
import { suppressionDocId } from "@/lib/email/suppression";
import { deterministicContactId, domainFromEmail } from "@/lib/crm/identifiers";
import { buildSearchTokens } from "@/lib/crm/searchTokens";
import { contactFieldsFromSignup, linkFromSignup, recomputeContactStatus } from "@/lib/crm/contactService";
import {
  linkFromProductUser,
  optOutsOf,
  sameDay,
  sameProductLink,
  summarize,
  tagChanges,
  type PersonSummary,
} from "./personLinks";

/**
 * The one writer of the person record (AUDIENCE_PERSON_LINKS_ENABLED). A person is the
 * brand's contact for one key: a normalised email address, a phone for someone who
 * only gave a phone, or `pu:<productUserId>` for a product user with no address yet.
 *
 * `syncPerson` reads every source for the key (their sign-ups on every launch, their
 * user records in every connected product, the address's opt-outs) and rebuilds the
 * derived fields in one transaction, writing nothing when nothing changed.
 * `syncProductLink` is the fast path for product writes: it swaps one product's link
 * using the user record already in hand. Both are safe to repeat; the sweep and the
 * backfill script call them too.
 */

/** The key prefix for a product user with no email address: they're their own person until one arrives. */
export const PRODUCT_USER_KEY_PREFIX = "pu:";

/** The person key for a product user. */
export function personKeyOf(user: Pick<ProductUser, "id" | "emailNormalized">): string {
  return user.emailNormalized ? user.emailNormalized : `${PRODUCT_USER_KEY_PREFIX}${user.id}`;
}

/** The person key for a sign-up: its address, or its phone when it has no address. */
export function signupPersonKey(signup: Pick<Signup, "email" | "phone">): string | null {
  return (signup.email ? normalizeEmail(signup.email) : null) ?? (signup.phone?.trim() || null);
}

/** The person record's id for a key (the contact id). */
export function personIdOf(tenantId: string, key: string): string {
  return deterministicContactId(tenantId, key);
}

/** The products whose users are people: custom connections still connected. Sandboxes keep their test users to themselves. */
export function isPeopleConnection(c: Pick<ProductConnection, "kind" | "status">): boolean {
  return c.kind === "custom" && c.status !== "revoked";
}

export type PeopleConnections = Map<string, ProductConnection>;

/** The brand's people connections by id, read once and shared across a batch of syncs. */
export async function loadPeopleConnections(ctx: TenantContext, db?: FirestoreLike): Promise<PeopleConnections> {
  const all = await forTenant(ctx, db).productConnections.find({ limit: 100 });
  return new Map(all.filter(isPeopleConnection).map((c) => [c.id, c]));
}

export interface SyncDeps {
  db?: FirestoreLike;
  nowMs?: number;
  connections?: PeopleConnections;
  /** Work out what would change and report it, writing nothing (the backfill's dry run). */
  dryRun?: boolean;
}

export type SyncOutcome = "created" | "updated" | "unchanged" | "deleted" | "none";

/** What a sync did: the "person changed" signal segments will listen to. */
export interface SyncResult {
  personId: string;
  outcome: SyncOutcome;
  added: string[];
  removed: string[];
}

/** A sign-up from the brand's own site joins the person once it's confirmed, as it joins the contact today. */
function countsAsPerson(signup: Signup): boolean {
  return !(signup.joinedVia === "site" && signup.status === "unverified");
}

function normalizeKey(raw: string): string | null {
  const key = raw.trim();
  if (!key) return null;
  if (key.startsWith(PRODUCT_USER_KEY_PREFIX)) return key;
  return key.includes("@") ? normalizeEmail(key) : key;
}

/** The record's derived fields, as they'd be written. */
interface Derived {
  campaigns: ContactCampaignLink[];
  products: PersonProductLink[];
  summary: PersonSummary;
  optOuts: Contact["optOuts"];
}

function sameCampaigns(a: readonly ContactCampaignLink[], b: readonly ContactCampaignLink[]): boolean {
  const norm = (links: readonly ContactCampaignLink[]) =>
    JSON.stringify(
      [...links]
        .sort((x, y) => x.campaignId.localeCompare(y.campaignId))
        .map((l) => [l.campaignId, l.signupId, l.status, l.amountReferred ?? 0, l.score ?? null, l.joinedVia ?? "form"]),
    );
  return norm(a) === norm(b);
}

function sameProducts(a: readonly PersonProductLink[], b: readonly PersonProductLink[]): boolean {
  return a.length === b.length && a.every((link, i) => sameProductLink(link, b[i]!));
}

/** The status the contact has always shown, with a product user counting as live. */
function statusOf(campaigns: readonly ContactCampaignLink[], products: readonly PersonProductLink[]): Contact["status"] {
  return products.length ? "active" : recomputeContactStatus(campaigns);
}

/** The patch that brings `current` in line with `next`, or null when it already is. */
function patchFor(current: Contact, next: Derived, nowIso: string): Partial<Contact> | null {
  const { campaigns, products, summary, optOuts } = next;
  const tagsChanged = (current.memberOf ?? []).join("\n") !== summary.memberOf.join("\n");
  const productsChanged = !sameProducts(current.products ?? [], products);
  const reachChanged = current.reach !== summary.reach;
  const campaignsChanged = !sameCampaigns(current.campaigns ?? [], campaigns);
  const optOutsChanged = JSON.stringify(current.optOuts ?? null) !== JSON.stringify(optOuts ?? null);
  const activeChanged = !sameDay(current.activeAt, summary.activeAt ?? undefined);
  if (!tagsChanged && !productsChanged && !reachChanged && !campaignsChanged && !optOutsChanged && !activeChanged && !current.needsSync) {
    return null;
  }
  return {
    campaigns,
    campaignIds: [...new Set(campaigns.map((c) => c.campaignId))],
    totalReferred: campaigns.reduce((s, c) => s + (c.amountReferred ?? 0), 0),
    status: statusOf(campaigns, products),
    products,
    memberOf: summary.memberOf,
    reach: summary.reach,
    optOuts,
    ...(summary.activeAt ? { activeAt: summary.activeAt } : {}),
    ...(tagsChanged || productsChanged || reachChanged ? { changedAt: nowIso } : {}),
    needsSync: false,
    updatedAt: nowIso,
  };
}

/** Rebuild one person from their sources. */
export async function syncPerson(ctx: TenantContext, rawKey: string, deps: SyncDeps = {}): Promise<SyncResult> {
  const key = normalizeKey(rawKey);
  if (!key) return { personId: "", outcome: "none", added: [], removed: [] };
  const personId = personIdOf(ctx.tenantId, key);
  const repo = forTenant(ctx, deps.db);
  const nowMs = deps.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const isProductKey = key.startsWith(PRODUCT_USER_KEY_PREFIX);
  const isEmail = !isProductKey && key.includes("@");

  const signupWhere: WhereClause = isEmail ? ["email", "==", key] : ["phone", "==", key];
  const [existing, connections, foundSignups, foundUsers, suppressions] = await Promise.all([
    repo.contacts.getById(personId),
    deps.connections ?? loadPeopleConnections(ctx, deps.db),
    isProductKey ? Promise.resolve([] as Signup[]) : repo.signups.find({ where: [signupWhere], limit: 500 }),
    isProductKey
      ? repo.productUsers.getById(key.slice(PRODUCT_USER_KEY_PREFIX.length)).then((u) => (u && !u.emailNormalized ? [u] : []))
      : isEmail
        ? repo.productUsers.find({ where: [["emailNormalized", "==", key]], limit: 100 })
        : Promise.resolve([] as ProductUser[]),
    // The brand-wide row by its id too: an erase elsewhere blanks the address on it, and it still stops every send.
    isEmail
      ? Promise.all([
          repo.emailSuppressions.getById(suppressionDocId(ctx.tenantId, key)),
          repo.emailSuppressions.find({ where: [["normalizedEmail", "==", key]], limit: 100 }),
        ]).then(([byId, rows]) => (byId && !rows.some((r) => r.id === byId.id) ? [byId, ...rows] : rows))
      : Promise.resolve([]),
  ]);

  // Sign-ups by key, plus any the contact links that the lookup missed (an address stored before
  // it was normalised). A phone person only has the sign-ups that gave no address.
  const signups = new Map<string, Signup>();
  for (const s of foundSignups) if (isEmail || !s.email) signups.set(s.id, s);
  const missing = (existing?.campaigns ?? []).map((c) => c.signupId).filter((id) => id && !signups.has(id));
  for (const s of await Promise.all(missing.map((id) => repo.signups.getById(id)))) if (s) signups.set(s.id, s);

  // One link per launch, as the contact has always kept them (the latest sign-up wins).
  const byCampaign = new Map<string, Signup>();
  for (const s of [...signups.values()].filter(countsAsPerson).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    byCampaign.set(s.campaignId, s);
  }
  const campaigns = [...byCampaign.values()].map(linkFromSignup);

  const optOuts = optOutsOf(suppressions);
  const users = foundUsers
    .filter((u) => u.status === "active" && connections.has(u.connectionId))
    .sort((a, b) => a.connectionId.localeCompare(b.connectionId) || a.id.localeCompare(b.id));
  const products = users.map((u) => linkFromProductUser(u, connections.get(u.connectionId)!, optOuts, nowMs));
  const summary = summarize(campaigns, products, optOuts);
  const next: Derived = { campaigns, products, summary, optOuts };

  if (!summary.live) {
    if (!existing) return { personId, outcome: "none", added: [], removed: [] };
    // A record that only ever came from products goes with its last product user. One with
    // sign-up history stays, marked deleted, as contacts always have (erase is the way to remove it).
    if (existing.consentStatus === "none" && !(existing.campaigns ?? []).length) {
      if (!deps.dryRun) await repo.contacts.delete(personId);
      return { personId, outcome: "deleted", added: [], removed: existing.memberOf ?? [] };
    }
  }

  const firstUser = users.find((u) => u.firstName || u.lastName) ?? users[0];
  const create = () => {
    const earliest = [...byCampaign.values()][0];
    const base = earliest
      ? contactFieldsFromSignup(ctx, earliest, nowIso)
      : productOnlyFields(key, users, firstUser, nowIso);
    return {
      ...base,
      ...patchFor({ memberOf: [], needsSync: true } as unknown as Contact, next, nowIso),
      changedAt: nowIso,
    } as unknown as Omit<Contact, "id" | "tenantId">;
  };

  if (deps.dryRun) {
    const patch = existing ? patchFor(existing, next, nowIso) : null;
    return {
      personId,
      outcome: !existing ? "created" : patch ? "updated" : "unchanged",
      ...tagChanges(existing?.memberOf ?? [], summary.memberOf),
    };
  }

  let before: string[] = [];
  let patched = false;
  const { doc, created } = await repo.contacts.upsert(personId, create, (current) => {
    before = current.memberOf ?? [];
    const patch = patchFor(current, next, nowIso);
    patched = !!patch;
    if (!patch) return null;
    // Fill a name or address the record lacks from their product, never overwrite one.
    if (firstUser && !current.firstName && !current.lastName && (firstUser.firstName || firstUser.lastName)) {
      patch.firstName = firstUser.firstName ?? null;
      patch.lastName = firstUser.lastName ?? null;
    }
    const email = current.email ?? users.find((u) => u.email)?.email ?? null;
    if (email && !current.email) patch.email = email;
    if (patch.firstName !== undefined || patch.email !== undefined) {
      patch.searchTokens = buildSearchTokens([
        patch.firstName ?? current.firstName,
        patch.lastName ?? current.lastName,
        email,
        current.emailDomain ?? (email ? domainFromEmail(email) : null),
      ]);
    }
    return patch as never;
  });
  const changes = tagChanges(created ? [] : before, doc.memberOf ?? []);
  return { personId, outcome: created ? "created" : patched ? "updated" : "unchanged", ...changes };
}

/** The fields of a person who so far only uses a product: no consent from a sign-up, no company. */
function productOnlyFields(key: string, users: readonly ProductUser[], named: ProductUser | undefined, nowIso: string) {
  const email = users.find((u) => u.email)?.email ?? null;
  const emailDomain = email ? domainFromEmail(normalizeEmail(email)) : null;
  const firstSeen = users.map((u) => u.firstSeenAt).filter(Boolean).sort()[0] ?? nowIso;
  return {
    contactKey: key,
    email,
    phone: null,
    firstName: named?.firstName ?? null,
    lastName: named?.lastName ?? null,
    status: "active" as const,
    verified: false,
    consentStatus: "none" as const,
    emailDomain,
    isCorporateDomain: false,
    companyId: null,
    campaigns: [],
    campaignIds: [],
    totalReferred: 0,
    enrichment: { status: "none" as const },
    searchTokens: buildSearchTokens([named?.firstName, named?.lastName, email, emailDomain]),
    retentionUntil: null,
    firstSeenAt: firstSeen,
    updatedAt: nowIso,
    createdAt: nowIso,
  };
}

/**
 * The fast path after a product write: swap this product's link on the person, from the
 * user record in hand, and write only when it changes what the list shows. Falls back
 * to a full sync for a new link, a deleted user or a person that owes one. Pass the
 * key they had before the write when their address may have changed.
 */
export async function syncProductLink(
  ctx: TenantContext,
  connection: ProductConnection,
  user: ProductUser,
  deps: SyncDeps & { previousKey?: string | null } = {},
): Promise<SyncResult | null> {
  if (!isPeopleConnection(connection)) return null;
  const key = personKeyOf(user);
  if (deps.previousKey && deps.previousKey !== key) await syncPerson(ctx, deps.previousKey, deps);
  const personId = personIdOf(ctx.tenantId, key);
  const repo = forTenant(ctx, deps.db);
  const current = await repo.contacts.getById(personId);
  if (!current || current.needsSync || user.status !== "active" || !(current.products ?? []).some((p) => p.productUserId === user.id)) {
    return syncPerson(ctx, key, deps);
  }
  const nowIso = new Date(deps.nowMs ?? Date.now()).toISOString();
  let before: string[] = [];
  const updated = await repo.contacts.claim(personId, (fresh) => {
    const link = linkFromProductUser(user, connection, fresh.optOuts, deps.nowMs ?? Date.now());
    const products = (fresh.products ?? []).map((p) => (p.productUserId === user.id ? link : p));
    before = fresh.memberOf ?? [];
    return patchFor(fresh, { campaigns: fresh.campaigns ?? [], products, summary: summarize(fresh.campaigns ?? [], products, fresh.optOuts), optOuts: fresh.optOuts }, nowIso) as never;
  });
  if (!updated) return { personId, outcome: "unchanged", added: [], removed: [] };
  return { personId, outcome: "updated", ...tagChanges(before, updated.memberOf ?? []) };
}

/** Mark a person as owed a sync, when there's a record to mark. Never throws. */
export async function markNeedsSync(ctx: TenantContext, key: string, db?: FirestoreLike): Promise<void> {
  const k = normalizeKey(key);
  if (!k) return;
  await forTenant(ctx, db)
    .contacts.claim(personIdOf(ctx.tenantId, k), () => ({ needsSync: true }) as never)
    .catch(() => {});
}

function warn(what: string, ctx: TenantContext, err: unknown) {
  // No address in the log: the tenant and the error are enough to find it again.
  console.warn(`[audience] ${what} failed tenant=${ctx.tenantId}:`, err instanceof Error ? err.message : "error");
}

/** syncPerson for a write path: logs and flags the person for the sweep instead of failing the write. */
export async function syncPersonSafe(ctx: TenantContext, key: string | null | undefined, deps: SyncDeps = {}): Promise<void> {
  if (!key) return;
  try {
    await syncPerson(ctx, key, deps);
  } catch (err) {
    warn("person sync", ctx, err);
    await markNeedsSync(ctx, key, deps.db);
  }
}

/** syncProductLink for a write path: never fails the write. */
export async function syncProductLinkSafe(
  ctx: TenantContext,
  connection: ProductConnection,
  user: ProductUser,
  deps: SyncDeps & { previousKey?: string | null } = {},
): Promise<void> {
  try {
    await syncProductLink(ctx, connection, user, deps);
  } catch (err) {
    warn("person product link", ctx, err);
    await markNeedsSync(ctx, personKeyOf(user), deps.db);
  }
}
