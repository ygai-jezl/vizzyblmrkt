import { appendEvents, forTenant, repairFieldTags, type WhereClause } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Contact, ContactCampaignLink, PersonProductLink } from "@/lib/types/contact";
import type { EmailSuppression } from "@/lib/types/emailSuppression";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import type { Signup } from "@/lib/types/signup";
import { normalizeEmail } from "@/lib/waitlist/identifiers";
import { suppressionDocId } from "@/lib/email/suppression";
import { deterministicContactId, domainFromEmail } from "@/lib/crm/identifiers";
import { buildSearchTokens } from "@/lib/crm/searchTokens";
import { contactFieldsFromSignup, linkFromSignup, recomputeContactStatus } from "@/lib/crm/contactService";
import { isContactPersonId } from "@/lib/ontology/person";
import { isTimelineEnabled } from "./peopleFlags";
import { isIdeasEnabled } from "@/lib/ideas/flags";
import { MANY_LAUNCHES_TAG } from "@/lib/ideas/list";
import { moveEvents, movesOf } from "./personMoves";
import {
  handAddedOf,
  isLiveSignupLink,
  linkFromProductUser,
  optOutsOf,
  sameDay,
  sameProductLink,
  summarize,
  tagChanges,
  withCarriedTags,
  type HandAdded,
  type ManyLaunches,
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
 *
 * Someone added by hand (`addedBy` on their record, piece B) is a source of their own, with no
 * switch: no path deletes them, renames them from a product or marks them deleted. The tags
 * other writers own (`field:` tags and `added:hand`) are kept as they are on every write, field
 * tags while the person is in Everyone (and rebuilt from their values when they come back).
 *
 * A record holding the team's field values is never deleted by a sync, whoever it came from: one
 * that only came from products stays when its last product user goes (revoked, moved to another
 * address, or joined to an address), out of Everyone like a sign-up contact whose launches went,
 * until the team erases it. Only the erase path (`erase: true`) removes it with its values.
 *
 * With LAUNCH_IDEAS_ENABLED a person in two or more live launches that aren't Just a list also has
 * `launches:many`. A full sync reads the brand's Just a list launches (an equality read) only for
 * someone in two or more launches; the fast path keeps the tag as it was, since it never changes
 * their launches, and ticking Just a list flags the launch's people for a full sync.
 *
 * With AUDIENCE_TIMELINE_ENABLED, both functions record the person's moves (launch, product,
 * stage and quiet, src/lib/audience/personMoves.ts) after their commit, so every caller is
 * covered. Best effort, keyed so a retry writes nothing twice; never on a dry run, a person who
 * was deleted, or a caller that passes `moves: "skip"` (the erase path and the backfill).
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

/**
 * The opt-out rows for a person key (an address only: a phone or a product user has none). The
 * brand-wide row is read by its id too: an erase elsewhere blanks the address on it, and it still
 * stops every send.
 */
export async function optOutRowsFor(ctx: TenantContext, key: string, db?: FirestoreLike): Promise<EmailSuppression[]> {
  if (key.startsWith(PRODUCT_USER_KEY_PREFIX) || !key.includes("@")) return [];
  const repo = forTenant(ctx, db);
  const [byId, rows] = await Promise.all([
    repo.emailSuppressions.getById(suppressionDocId(ctx.tenantId, key)),
    repo.emailSuppressions.find({ where: [["normalizedEmail", "==", key]], limit: 100 }),
  ]);
  return byId && !rows.some((r) => r.id === byId.id) ? [byId, ...rows] : rows;
}

/** The brand's launches marked Just a list (LAUNCH_IDEAS_ENABLED), by id: an equality read, no composite index. */
export async function justAListIds(ctx: TenantContext, db?: FirestoreLike): Promise<Set<string>> {
  const rows = await forTenant(ctx, db).campaigns.find({ where: [["idea.justAList", "==", true]], limit: 500 });
  return new Set(rows.map((c) => c.id));
}

/** How a full sync works out `launches:many`: off without ideas, and no read for someone in fewer than two launches. */
async function manyLaunchesFor(ctx: TenantContext, campaigns: readonly ContactCampaignLink[], db?: FirestoreLike): Promise<ManyLaunches | null> {
  if (!isIdeasEnabled()) return null;
  const live = new Set(campaigns.filter(isLiveSignupLink).map((c) => c.campaignId));
  return { leaveOut: live.size >= 2 ? await justAListIds(ctx, db) : new Set() };
}

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
  /**
   * Whether to record the person's moves for their timeline (AUDIENCE_TIMELINE_ENABLED). "skip"
   * on the erase path, where a row written after the history was erased would outlive it, and in
   * the backfill, so a rebuild never floods timelines. Default "record".
   */
  moves?: "record" | "skip";
  /**
   * The product user's erase (personAfterProductErase, and the dry run that decides whether to
   * erase the history): a record that only came from products goes with its last product user even
   * when it holds field values, which would otherwise keep it.
   */
  erase?: boolean;
}

export type SyncOutcome = "created" | "updated" | "unchanged" | "deleted" | "none";

/** What a sync did: the "person changed" signal segments will listen to. */
export interface SyncResult {
  personId: string;
  outcome: SyncOutcome;
  added: string[];
  removed: string[];
  /** When this sync changed the record (its changedAt, or when it was created); null when it wrote nothing. */
  changedAt: string | null;
}

/** Each product's user on a person, by connection, where the product has just one of them. */
function productUsersOf(...lists: Array<readonly PersonProductLink[] | null | undefined>): Map<string, string> {
  const users = new Map<string, Set<string>>();
  for (const list of lists) for (const p of list ?? []) users.set(p.connectionId, (users.get(p.connectionId) ?? new Set()).add(p.productUserId));
  return new Map([...users].flatMap(([c, ids]) => (ids.size === 1 ? [[c, [...ids][0]!] as [string, string]] : [])));
}

/**
 * Record one sync's moves on the person's timeline (AUDIENCE_TIMELINE_ENABLED), in one batch after
 * its commit. Best effort: a lost move leaves a gap in the timeline, never a wrong value. Counts
 * only in the log.
 */
async function recordMoves(
  ctx: TenantContext,
  result: SyncResult,
  products: Map<string, string>,
  deps: SyncDeps,
): Promise<void> {
  if (deps.moves === "skip" || deps.dryRun || !result.changedAt || result.outcome === "deleted" || !isTimelineEnabled()) return;
  if (!isContactPersonId(result.personId)) return;
  const moves = movesOf(result);
  if (!moves.length) return;
  try {
    await appendEvents(ctx, moveEvents(result.personId, result.changedAt, moves, products), { db: deps.db });
  } catch (err) {
    warn(`recording ${moves.length} moves`, ctx, err);
  }
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
  /** Added by hand: a source of its own. */
  hand: HandAdded | null;
}

/**
 * The derived fields for a record as it is now: its hand-added source read from the record itself.
 * `many` works out `launches:many` (null while ideas are off, which drops it).
 */
function derive(
  record: Pick<Contact, "addedBy" | "consent" | "email"> | null | undefined,
  campaigns: ContactCampaignLink[],
  products: PersonProductLink[],
  optOuts: Contact["optOuts"],
  many: ManyLaunches | null,
): Derived {
  const hand = handAddedOf(record);
  return { campaigns, products, optOuts, hand, summary: summarize(campaigns, products, optOuts, hand, { manyLaunches: many }) };
}

function sameCampaigns(a: readonly ContactCampaignLink[], b: readonly ContactCampaignLink[]): boolean {
  const norm = (links: readonly ContactCampaignLink[]) =>
    JSON.stringify(
      [...links]
        .sort((x, y) => x.campaignId.localeCompare(y.campaignId))
        .map((l) => [l.campaignId, l.signupId, l.status, l.amountReferred ?? 0, l.score ?? null, l.joinedVia ?? "form", l.locale ?? null]),
    );
  return norm(a) === norm(b);
}

function sameProducts(a: readonly PersonProductLink[], b: readonly PersonProductLink[]): boolean {
  return a.length === b.length && a.every((link, i) => sameProductLink(link, b[i]!));
}

/** The status the contact has always shown, with a product user, or being added by hand, counting as live. */
function statusOf(campaigns: readonly ContactCampaignLink[], products: readonly PersonProductLink[], hand: HandAdded | null): Contact["status"] {
  return products.length || hand ? "active" : recomputeContactStatus(campaigns);
}

/** The list's order for a person: unique, newest activity first when sorted descending. */
export function sortKeyOf(activeAt: string, personId: string): string {
  return `${activeAt}|${personId}`;
}

/**
 * The patch that brings `current` in line with `next`, or null when it already is. The tags other
 * writers own are carried over from `current` and compared with the rest, so a sync never wipes
 * or rewrites them, and never writes when only they differ.
 */
function patchFor(personId: string, current: Contact, next: Derived, nowIso: string): Partial<Contact> | null {
  const { campaigns, products, summary, optOuts, hand } = next;
  const memberOf = withCarriedTags(summary.memberOf, current.memberOf);
  const tagsChanged = (current.memberOf ?? []).join("\n") !== memberOf.join("\n");
  const productsChanged = !sameProducts(current.products ?? [], products);
  const reachChanged = current.reach !== summary.reach;
  const campaignsChanged = !sameCampaigns(current.campaigns ?? [], campaigns);
  const optOutsChanged = JSON.stringify(current.optOuts ?? null) !== JSON.stringify(optOuts ?? null);
  const activeChanged = !sameDay(current.activeAt, summary.activeAt ?? undefined);
  // Their language is written only while LANGUAGE_READERS_ENABLED is on (summarize sets it then).
  const counted = summary.language !== undefined;
  const languageChanged = counted && (current.language ?? null) !== summary.language;
  if (!tagsChanged && !productsChanged && !reachChanged && !campaignsChanged && !optOutsChanged && !activeChanged && !languageChanged && !current.needsSync) {
    return null;
  }
  return {
    campaigns,
    campaignIds: [...new Set(campaigns.map((c) => c.campaignId))],
    totalReferred: campaigns.reduce((s, c) => s + (c.amountReferred ?? 0), 0),
    status: statusOf(campaigns, products, hand),
    products,
    memberOf,
    reach: summary.reach,
    optOuts,
    ...(summary.activeAt ? { activeAt: summary.activeAt, sortKey: sortKeyOf(summary.activeAt, personId) } : {}),
    ...(counted ? { language: summary.language ?? null } : {}),
    ...(tagsChanged || productsChanged || reachChanged ? { changedAt: nowIso } : {}),
    needsSync: false,
    updatedAt: nowIso,
  };
}

/** Rebuild one person from their sources. */
export async function syncPerson(ctx: TenantContext, rawKey: string, deps: SyncDeps = {}): Promise<SyncResult> {
  const key = normalizeKey(rawKey);
  if (!key) return { personId: "", outcome: "none", added: [], removed: [], changedAt: null };
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
    optOutRowsFor(ctx, key, deps.db),
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
  const many = await manyLaunchesFor(ctx, campaigns, deps.db);
  const next = derive(existing, campaigns, products, optOuts, many);
  const { summary } = next;

  if (!summary.live) {
    if (!existing) return { personId, outcome: "none", added: [], removed: [], changedAt: null };
    // A record that only ever came from products goes with its last product user. One with
    // sign-up history stays, marked deleted, as contacts always have (erase is the way to remove it),
    // and so does one holding the team's field values, except on a product user's erase.
    // Someone added by hand is live, so never reaches here; addedBy spares them all the same.
    if (existing.consentStatus === "none" && !(existing.campaigns ?? []).length && !existing.addedBy && (deps.erase || !holdsFieldValues(existing))) {
      if (!deps.dryRun) await repo.contacts.delete(personId);
      return { personId, outcome: "deleted", added: [], removed: existing.memberOf ?? [], changedAt: deps.dryRun ? null : nowIso };
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
      ...patchFor(personId, { memberOf: [], needsSync: true } as unknown as Contact, next, nowIso),
      changedAt: nowIso,
    } as unknown as Omit<Contact, "id" | "tenantId">;
  };

  if (deps.dryRun) {
    const patch = existing ? patchFor(personId, existing, next, nowIso) : null;
    return {
      personId,
      outcome: !existing ? "created" : patch ? "updated" : "unchanged",
      ...tagChanges(existing?.memberOf ?? [], summary.memberOf),
      changedAt: null,
    };
  }

  let before: string[] = [];
  let beforeProducts: PersonProductLink[] = [];
  let patched = false;
  const { doc, created } = await repo.contacts.upsert(personId, create, (current) => {
    before = current.memberOf ?? [];
    beforeProducts = current.products ?? [];
    // A person who only uses products is named as their product names them, kept in step. A
    // contact from a sign-up keeps its own name and address: none is copied in from a product,
    // so erasing them in the product leaves nothing of theirs behind here. Nor does someone added
    // by hand: they keep the name, address and search words that were typed.
    const productOnly =
      current.consentStatus === "none" && !(current.campaigns ?? []).length && campaigns.length === 0 && !current.addedBy;
    const who = productOnly && users.length ? productOnlyFields(key, users, firstUser, nowIso) : null;
    const renamed =
      who && (who.firstName !== (current.firstName ?? null) || who.lastName !== (current.lastName ?? null) || who.email !== (current.email ?? null))
        ? { firstName: who.firstName, lastName: who.lastName, email: who.email, emailDomain: who.emailDomain, searchTokens: who.searchTokens }
        : null;
    // The record as it is inside this transaction says whether it was added by hand.
    const patch = patchFor(personId, current, derive(current, campaigns, products, optOuts, many), nowIso);
    patched = !!(patch || renamed);
    if (!patch && !renamed) return null;
    return { ...(patch ?? { updatedAt: nowIso }), ...(renamed ?? {}) } as never;
  });
  const changes = tagChanges(created ? [] : before, doc.memberOf ?? []);
  // Back in Everyone with values the team set: their field tags come back from those values.
  if (!created && !before.includes("all") && (doc.memberOf ?? []).includes("all") && holdsFieldValues(doc)) {
    await repairFieldTags(ctx, personId, { db: deps.db }).catch((err) => warn("restoring field tags", ctx, err));
  }
  const result: SyncResult = {
    personId,
    outcome: created ? "created" : patched ? "updated" : "unchanged",
    ...changes,
    changedAt: created || patched ? nowIso : null,
  };
  await recordMoves(ctx, result, productUsersOf(beforeProducts, doc.products), deps);
  return result;
}

/** Whether a record holds any of the team's field values (`fields.<fieldId>`). */
function holdsFieldValues(record: Pick<Contact, "fields">): boolean {
  return !!record.fields && Object.keys(record.fields).length > 0;
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
  let beforeProducts: PersonProductLink[] = [];
  let owed = false;
  const updated = await repo.contacts.claim(personId, (fresh) => {
    // A full rebuild is owed (a sync failed, a launch went): this can't stand in for it.
    if (fresh.needsSync) {
      owed = true;
      return null;
    }
    const link = linkFromProductUser(user, connection, fresh.optOuts, deps.nowMs ?? Date.now());
    const products = (fresh.products ?? []).map((p) => (p.productUserId === user.id ? link : p));
    before = fresh.memberOf ?? [];
    beforeProducts = fresh.products ?? [];
    // Their launches don't change here, so `launches:many` stays as the last full sync left it.
    const many = isIdeasEnabled() ? { keep: (fresh.memberOf ?? []).includes(MANY_LAUNCHES_TAG) } : null;
    return patchFor(personId, fresh, derive(fresh, fresh.campaigns ?? [], products, fresh.optOuts, many), nowIso) as never;
  });
  if (owed) return syncPerson(ctx, key, deps);
  if (!updated) return { personId, outcome: "unchanged", added: [], removed: [], changedAt: null };
  const result: SyncResult = { personId, outcome: "updated", ...tagChanges(before, updated.memberOf ?? []), changedAt: nowIso };
  await recordMoves(ctx, result, productUsersOf(beforeProducts, updated.products), deps);
  return result;
}

/** Flag everyone with a tag for a full rebuild by the sweep (a product revoked, say), a page at a time. */
export async function flagPeopleIn(ctx: TenantContext, tag: string, db?: FirestoreLike): Promise<number> {
  const repo = forTenant(ctx, db).contacts;
  const PAGE = 200;
  let after: string | null = null;
  let flagged = 0;
  for (;;) {
    const page: Contact[] = await repo.find({
      where: [["memberOf", "array-contains", tag]],
      orderBy: [["sortKey", "desc"]],
      limit: PAGE,
      ...(after ? { startAfter: [after] } : {}),
    });
    await Promise.all(page.map((c) => repo.update(c.id, { needsSync: true })));
    flagged += page.length;
    after = page.length === PAGE ? (page[page.length - 1]!.sortKey ?? null) : null;
    if (!after) return flagged;
  }
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
    // The person they moved from, when their address changed: the sweep can't find them any other way.
    if (deps.previousKey) await markNeedsSync(ctx, deps.previousKey, deps.db);
  }
}
