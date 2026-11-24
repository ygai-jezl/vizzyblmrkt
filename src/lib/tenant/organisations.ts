import { randomBytes, randomUUID } from "node:crypto";
import { getDb } from "./firestore";
import { TenantValidationError } from "./errors";
import type { DocRefLike, DocSnapLike, FirestoreLike, TransactionLike } from "./types";
import {
  MAX_ORGANISATION_BRANDS,
  MAX_ORGANISATION_NAME,
  MAX_ORGANISATION_OWNERS,
  OrganisationChangeSchema,
  OrganisationSchema,
  PlanIdSchema,
  type Organisation,
  type OrganisationChange,
  type PlanId,
} from "@/lib/types/organisation";

/**
 * Organisations in the control database ((default)), above brands (PLANS_ENABLED; the plans are
 * in src/lib/plans/catalog.ts). An organisation lists its brands (`brandIds`) and each brand
 * points back (`tenants.organisationId`) and keeps a copy of the plan (`tenants.orgPlan`). This
 * module is the only writer of all three, and writes them together in one transaction, so the
 * copy never drifts on its own. Brands are combined only on purpose, by an operator script, and
 * never inferred from a brand's ownerId or from the brand someone is in.
 *
 * Every change also writes its organisation_changes rows in the same transaction. That log is
 * append only and holds staff data only: the actor is a Firebase UID, `script:<label>`,
 * `backfill:<label>`, "seed" or "selfhost". Nothing here ever deletes an organisation, even one
 * a move leaves empty.
 */

export const ORGANISATIONS = "organisations" as const;
export const ORGANISATION_CHANGES = "organisation_changes" as const;
const TENANTS = "tenants";

function defaultDb(): FirestoreLike {
  return getDb() as unknown as FirestoreLike;
}

/** The organisation a brand starts in. Deterministic, so the backfill can run again safely. */
export function organisationIdFor(tenantId: string): string {
  return `org_${tenantId}`;
}

function parseOrganisation(id: string, data: Record<string, unknown> | undefined): Organisation | null {
  const parsed = OrganisationSchema.safeParse({ ...(data ?? {}), id });
  if (parsed.success) return parsed.data;
  console.warn(`[organisations] ${id} does not parse; read as none`, parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  return null;
}

function organisationOf(snap: DocSnapLike): Organisation | null {
  return snap.exists ? parseOrganisation(snap.id, snap.data()) : null;
}

/** A stored list of ids, tolerantly: anything that isn't a non-empty string is dropped. */
function idsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

function organisationIdOf(snap: DocSnapLike): string | null {
  const v = snap.data()?.organisationId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The fields stored on the document (the id is the document's own). */
function stored(org: Organisation): Record<string, unknown> {
  const { id: _id, ...rest } = OrganisationSchema.parse(org);
  return rest;
}

function checkPlan(plan: unknown): PlanId {
  const parsed = PlanIdSchema.safeParse(plan);
  if (!parsed.success) throw new TenantValidationError(`unknown plan ${String(plan)}`);
  return parsed.data;
}

function cleanOwners(ids: readonly string[] | undefined): string[] {
  const out = [...new Set((ids ?? []).map((s) => s.trim()).filter(Boolean))];
  if (out.length > MAX_ORGANISATION_OWNERS) throw new TenantValidationError(`at most ${MAX_ORGANISATION_OWNERS} owners`);
  if (out.some((s) => s.length > 128)) throw new TenantValidationError("an owner id is too long");
  return out;
}

function nameFor(raw: unknown, fallback: string): string {
  const name = typeof raw === "string" ? raw.trim().slice(0, MAX_ORGANISATION_NAME) : "";
  return name || fallback.slice(0, MAX_ORGANISATION_NAME);
}

/**
 * Add one organisation_changes row to the transaction. The id carries the organisation, brand,
 * time and kind for reading the log by eye, plus a random part, so two brands joining in the same
 * millisecond never collide and abort the transaction.
 */
function logChange(tx: TransactionLike, db: FirestoreLike, change: OrganisationChange): void {
  const id = `${change.organisationId}_${change.tenantId ?? "org"}_${change.at}_${change.kind}_${randomUUID().slice(0, 8)}`.replace(/[^\w.-]/g, "_");
  const row = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined));
  tx.create(db.collection(ORGANISATION_CHANGES).doc(id), row);
}

/** One organisation, or null when it is missing or does not parse (never a throw). */
export async function getOrganisation(id: string, db: FirestoreLike = defaultDb()): Promise<Organisation | null> {
  if (!id) return null;
  return organisationOf(await db.collection(ORGANISATIONS).doc(id).get());
}

/**
 * Whether an organisation exists and the brands it lists, read as stored (whether or not the rest of
 * it parses): housekeeping's evidence that an organisation is gone or has no brands left, so its
 * connections are disconnected (Connectors 3). A read error throws, so nothing is decided on it.
 */
export async function organisationMembership(id: string, db: FirestoreLike = defaultDb()): Promise<{ exists: boolean; brandIds: string[] }> {
  if (!id) return { exists: false, brandIds: [] };
  const snap = await db.collection(ORGANISATIONS).doc(id).get();
  return snap.exists ? { exists: true, brandIds: idsOf(snap.data()?.brandIds) } : { exists: false, brandIds: [] };
}

/** Every organisation that parses (for the backfill's --check and --replan). */
export async function listOrganisations(db: FirestoreLike = defaultDb()): Promise<Organisation[]> {
  const snap = await db.collection(ORGANISATIONS).get();
  return snap.docs.map((d) => parseOrganisation(d.id, d.data())).filter((o): o is Organisation => o !== null);
}

export interface EnsureOrganisationOptions {
  plan: PlanId;
  /** "backfill", "selfhost", "seed", or the Firebase UID of the person making the brand. */
  createdBy: string;
  /** Who sees the whole organisation. Never inferred: the backfill leaves it empty. */
  ownerIds?: string[];
  /** Defaults to the brand's name. */
  name?: string;
  /** Recorded on the change rows. Defaults to createdBy (the backfill passes `backfill:<label>`). */
  actor?: string;
}

export type EnsureOrganisationResult = {
  status: "created" | "exists" | "missing_brand" | "conflict";
  organisationId?: string;
};

/**
 * Give a brand an organisation of its own, `org_<tenantId>`, on `plan`. Safe to run again:
 * - a brand that already has an organisation is left where it is (exists), so a retry never
 *   moves a brand;
 * - an org_<tenantId> that already lists the brand is only relinked (exists);
 * - an empty org_<tenantId>, left behind by a move, is reused on `plan`;
 * - an org_<tenantId> that lists other brands is left alone (conflict, for --check to report).
 */
export async function ensureBrandOrganisation(
  tenantId: string,
  opts: EnsureOrganisationOptions,
  db: FirestoreLike = defaultDb(),
): Promise<EnsureOrganisationResult> {
  const plan = checkPlan(opts.plan);
  const ownerIds = cleanOwners(opts.ownerIds);
  const actor = opts.actor ?? opts.createdBy;
  const brandRef = db.collection(TENANTS).doc(tenantId);
  const orgId = organisationIdFor(tenantId);
  const orgRef = db.collection(ORGANISATIONS).doc(orgId);
  return db.runTransaction(async (tx) => {
    const brandSnap = await tx.get(brandRef);
    if (!brandSnap.exists) return { status: "missing_brand" };
    const linked = organisationIdOf(brandSnap);
    if (linked) return { status: "exists", organisationId: linked };
    const orgSnap = await tx.get(orgRef);
    const now = new Date().toISOString();
    const brandName = brandSnap.data()?.tenantName;

    if (orgSnap.exists) {
      const raw = orgSnap.data() ?? {};
      const brandIds = idsOf(raw.brandIds);
      const current = organisationOf(orgSnap);
      if (brandIds.includes(tenantId)) {
        // The organisation lists the brand but the brand lost its link: relink on the
        // organisation's own plan.
        if (!current) return { status: "conflict", organisationId: orgId };
        tx.update(brandRef, { organisationId: orgId, orgPlan: current.plan, updatedAt: now });
        logChange(tx, db, { organisationId: orgId, kind: "brand.joined", tenantId, actor, at: now });
        return { status: "exists", organisationId: orgId };
      }
      if (brandIds.length > 0) return { status: "conflict", organisationId: orgId };
      // Empty, left behind by a move: reuse it.
      const reused: Organisation = {
        id: orgId,
        name: nameFor(opts.name ?? brandName, current?.name ?? tenantId),
        plan,
        planSince: current?.plan === plan ? current.planSince : now,
        brandIds: [tenantId],
        ownerIds: opts.ownerIds ? ownerIds : (current?.ownerIds ?? []),
        // Whoever takes it up chose its plan, so --replan (the backfill's only) follows them.
        createdBy: opts.createdBy,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      tx.set(orgRef, stored(reused));
      tx.update(brandRef, { organisationId: orgId, orgPlan: plan, updatedAt: now });
      if (current?.plan !== plan) logChange(tx, db, { organisationId: orgId, kind: "plan.changed", ...(current ? { from: current.plan } : {}), to: plan, actor, at: now });
      logChange(tx, db, { organisationId: orgId, kind: "brand.joined", tenantId, actor, at: now });
      return { status: "created", organisationId: orgId };
    }

    const org: Organisation = {
      id: orgId,
      name: nameFor(opts.name ?? brandName, tenantId),
      plan,
      planSince: now,
      brandIds: [tenantId],
      ownerIds,
      createdBy: opts.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    tx.create(orgRef, stored(org));
    tx.update(brandRef, { organisationId: orgId, orgPlan: plan, updatedAt: now });
    logChange(tx, db, { organisationId: orgId, kind: "organisation.created", to: plan, actor, at: now });
    logChange(tx, db, { organisationId: orgId, kind: "brand.joined", tenantId, actor, at: now });
    return { status: "created", organisationId: orgId };
  });
}

/**
 * Move a brand into another organisation (combining brands, when an owner asks). The brand takes
 * the target's plan. The organisation it leaves is kept, even when empty. With `maxBrands` (the
 * target plan's brands allowance) the move is refused as full when the target already has that
 * many; the check is inside the transaction, so two moves can't both pass it.
 */
export async function attachBrandToOrganisation(
  tenantId: string,
  organisationId: string,
  opts: { actor: string; maxBrands?: number | null },
  db: FirestoreLike = defaultDb(),
): Promise<"moved" | "already" | "missing" | "full"> {
  const brandRef = db.collection(TENANTS).doc(tenantId);
  const targetRef = db.collection(ORGANISATIONS).doc(organisationId);
  return db.runTransaction(async (tx) => {
    const brandSnap = await tx.get(brandRef);
    const targetSnap = await tx.get(targetRef);
    const target = organisationOf(targetSnap);
    if (!brandSnap.exists || !target) return "missing";
    const fromId = organisationIdOf(brandSnap);
    const fromRef = fromId && fromId !== organisationId ? db.collection(ORGANISATIONS).doc(fromId) : null;
    const fromSnap = fromRef ? await tx.get(fromRef) : null;

    if (fromId === organisationId && target.brandIds.includes(tenantId)) return "already";
    const others = target.brandIds.filter((id) => id !== tenantId);
    const limit = Math.min(opts.maxBrands ?? MAX_ORGANISATION_BRANDS, MAX_ORGANISATION_BRANDS);
    if (others.length >= limit) return "full";

    const now = new Date().toISOString();
    if (fromRef && fromSnap?.exists) {
      const left = idsOf(fromSnap.data()?.brandIds);
      if (left.includes(tenantId)) {
        tx.update(fromRef, { brandIds: left.filter((id) => id !== tenantId), updatedAt: now });
      }
      logChange(tx, db, { organisationId: fromId!, kind: "brand.left", tenantId, to: organisationId, actor: opts.actor, at: now });
    }
    tx.update(targetRef, { brandIds: [...others, tenantId], updatedAt: now });
    tx.update(brandRef, { organisationId, orgPlan: target.plan, updatedAt: now });
    logChange(tx, db, { organisationId, kind: "brand.joined", tenantId, ...(fromId && fromId !== organisationId ? { from: fromId } : {}), actor: opts.actor, at: now });
    return "moved";
  });
}

function randomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(6)].map((b) => alphabet[b % alphabet.length]).join("");
}

/**
 * Split a brand back out into an organisation of its own, on `plan` (undoing a combine). The new
 * organisation is org_<tenantId> when that is absent or empty, else org_<tenantId>_<6 characters>.
 * The organisation it leaves is kept. A brand already alone in its organisation stays put
 * (moved: false). Null when there is no such brand.
 */
export async function moveBrandToNewOrganisation(
  tenantId: string,
  opts: { plan: PlanId; actor: string; ownerIds?: string[] },
  db: FirestoreLike = defaultDb(),
): Promise<{ organisationId: string; moved: boolean } | null> {
  const plan = checkPlan(opts.plan);
  const ownerIds = cleanOwners(opts.ownerIds);
  const brandRef = db.collection(TENANTS).doc(tenantId);
  return db.runTransaction(async (tx) => {
    const brandSnap = await tx.get(brandRef);
    if (!brandSnap.exists) return null;
    const fromId = organisationIdOf(brandSnap);
    const fromRef = fromId ? db.collection(ORGANISATIONS).doc(fromId) : null;
    const fromSnap = fromRef ? await tx.get(fromRef) : null;
    const fromBrands = fromSnap?.exists ? idsOf(fromSnap.data()?.brandIds) : [];
    if (fromId && fromBrands.length === 1 && fromBrands[0] === tenantId) return { organisationId: fromId, moved: false };

    // Find the target, reading every candidate before any write.
    let targetRef: DocRefLike = db.collection(ORGANISATIONS).doc(organisationIdFor(tenantId));
    let targetSnap = await tx.get(targetRef);
    for (let tries = 0; targetSnap.exists && idsOf(targetSnap.data()?.brandIds).length > 0; tries += 1) {
      if (tries >= 5) throw new Error(`no free organisation id for ${tenantId}`);
      targetRef = db.collection(ORGANISATIONS).doc(`${organisationIdFor(tenantId)}_${randomSuffix()}`);
      targetSnap = await tx.get(targetRef);
    }

    const now = new Date().toISOString();
    const current = targetSnap.exists ? organisationOf(targetSnap) : null;
    const org: Organisation = {
      id: targetRef.id,
      name: nameFor(brandSnap.data()?.tenantName, tenantId),
      plan,
      planSince: current?.plan === plan ? current.planSince : now,
      brandIds: [tenantId],
      ownerIds: opts.ownerIds ? ownerIds : (current?.ownerIds ?? []),
      // A reused one too: the operator chose its plan, so --replan (the backfill's only) leaves it.
      createdBy: opts.actor,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    if (fromRef && fromSnap?.exists && fromBrands.includes(tenantId)) {
      tx.update(fromRef, { brandIds: fromBrands.filter((id) => id !== tenantId), updatedAt: now });
    }
    if (fromId) logChange(tx, db, { organisationId: fromId, kind: "brand.left", tenantId, to: targetRef.id, actor: opts.actor, at: now });
    if (targetSnap.exists) {
      tx.set(targetRef, stored(org));
      if (current?.plan !== plan) logChange(tx, db, { organisationId: targetRef.id, kind: "plan.changed", ...(current ? { from: current.plan } : {}), to: plan, actor: opts.actor, at: now });
    } else {
      tx.create(targetRef, stored(org));
      logChange(tx, db, { organisationId: targetRef.id, kind: "organisation.created", to: plan, actor: opts.actor, at: now });
    }
    tx.update(brandRef, { organisationId: targetRef.id, orgPlan: plan, updatedAt: now });
    logChange(tx, db, { organisationId: targetRef.id, kind: "brand.joined", tenantId, ...(fromId ? { from: fromId } : {}), actor: opts.actor, at: now });
    return { organisationId: targetRef.id, moved: true };
  });
}

export interface SetPlanResult {
  organisation: Organisation;
  /** Listed brands with no brand record: skipped, for the operator to look at. */
  missingBrands: string[];
  /** Listed brands that point at another organisation (or none): skipped, for --check. */
  unlinkedBrands: string[];
}

/**
 * Put an organisation on a plan, and copy it onto every brand it lists, in one transaction (all
 * reads first). Brands that are missing, or that point elsewhere, are skipped and reported
 * rather than failing the change. Setting the same plan again repairs the copies and logs
 * nothing. Null when there is no such organisation.
 */
export async function setOrganisationPlan(
  organisationId: string,
  plan: PlanId,
  actor: string,
  db: FirestoreLike = defaultDb(),
): Promise<SetPlanResult | null> {
  const next = checkPlan(plan);
  const orgRef = db.collection(ORGANISATIONS).doc(organisationId);
  return db.runTransaction(async (tx) => {
    const org = organisationOf(await tx.get(orgRef));
    if (!org) return null;
    // One read at a time: every read comes before the first write.
    const brands: Array<{ id: string; ref: DocRefLike; snap: DocSnapLike }> = [];
    for (const id of org.brandIds) {
      const ref = db.collection(TENANTS).doc(id);
      brands.push({ id, ref, snap: await tx.get(ref) });
    }
    const now = new Date().toISOString();
    const changed = org.plan !== next;
    const updated: Organisation = { ...org, plan: next, planSince: changed ? now : org.planSince, updatedAt: now };
    tx.update(orgRef, { plan: next, planSince: updated.planSince, updatedAt: now });
    const missingBrands: string[] = [];
    const unlinkedBrands: string[] = [];
    for (const b of brands) {
      if (!b.snap.exists) missingBrands.push(b.id);
      else if (organisationIdOf(b.snap) !== organisationId) unlinkedBrands.push(b.id);
      else tx.update(b.ref, { orgPlan: next, updatedAt: now });
    }
    if (changed) logChange(tx, db, { organisationId, kind: "plan.changed", from: org.plan, to: next, actor, at: now });
    return { organisation: updated, missingBrands, unlinkedBrands };
  });
}

/** Rename an organisation. Null when there is no such organisation. */
export async function setOrganisationName(
  organisationId: string,
  name: string,
  actor: string,
  db: FirestoreLike = defaultDb(),
): Promise<Organisation | null> {
  const next = name.trim();
  if (!next || next.length > MAX_ORGANISATION_NAME) throw new TenantValidationError(`a name is 1 to ${MAX_ORGANISATION_NAME} characters`);
  const orgRef = db.collection(ORGANISATIONS).doc(organisationId);
  return db.runTransaction(async (tx) => {
    const org = organisationOf(await tx.get(orgRef));
    if (!org) return null;
    if (org.name === next) return org;
    const now = new Date().toISOString();
    tx.update(orgRef, { name: next, updatedAt: now });
    logChange(tx, db, { organisationId, kind: "organisation.renamed", from: org.name, to: next, actor, at: now });
    return { ...org, name: next, updatedAt: now };
  });
}

/**
 * Add or remove the owners who see the whole organisation on Plan and usage. At most 20; a change
 * that would pass that is refused ("too_many") with no writes. Null when there is no such
 * organisation.
 */
export async function setOrganisationOwners(
  organisationId: string,
  change: { add?: string[]; remove?: string[] },
  actor: string,
  db: FirestoreLike = defaultDb(),
): Promise<Organisation | "too_many" | null> {
  const add = cleanOwners(change.add);
  const remove = new Set(cleanOwners(change.remove));
  const orgRef = db.collection(ORGANISATIONS).doc(organisationId);
  return db.runTransaction(async (tx) => {
    const org = organisationOf(await tx.get(orgRef));
    if (!org) return null;
    const next = [...new Set([...org.ownerIds.filter((id) => !remove.has(id)), ...add.filter((id) => !remove.has(id))])];
    if (next.length > MAX_ORGANISATION_OWNERS) return "too_many";
    if (next.length === org.ownerIds.length && next.every((id) => org.ownerIds.includes(id))) return org;
    const now = new Date().toISOString();
    tx.update(orgRef, { ownerIds: next, updatedAt: now });
    logChange(tx, db, { organisationId, kind: "owners.changed", from: org.ownerIds, to: next, actor, at: now });
    return { ...org, ownerIds: next, updatedAt: now };
  });
}

/**
 * The people with a membership in any of the organisation's brands, each counted once
 * (tenant_users, by tenantId in chunks of 30: a single field `in` query on the default index).
 */
export async function organisationUserIds(
  org: Pick<Organisation, "brandIds">,
  db: FirestoreLike = defaultDb(),
): Promise<Set<string>> {
  const users = new Set<string>();
  const ids = [...new Set(org.brandIds)];
  for (let i = 0; i < ids.length; i += 30) {
    const snap = await db.collection("tenant_users").where("tenantId", "in", ids.slice(i, i + 30)).get();
    for (const d of snap.docs) {
      const userId = d.data().userId;
      if (typeof userId === "string" && userId) users.add(userId);
    }
  }
  return users;
}

/** The kinds an organisation's own connection records on its organisation's change log. */
export type OrganisationConnectionChangeKind = Extract<OrganisationChange["kind"], `connection.${string}`>;

/**
 * Record a change to an organisation's own connection (Connectors 3, ADR-0014) on its change log:
 * connected, signed in again, paused, resumed or disconnected, naming the organisation, the
 * connection and the brand it was connected from, by id only. organisation_changes is in
 * (default) and can't join a transaction in another region's database, so this is written after
 * the change itself, best effort, like the activity log: a failure is logged and changes nothing
 * else. Returns whether the row was written.
 */
export async function recordOrganisationConnectionChange(
  change: { organisationId: string; kind: OrganisationConnectionChangeKind; connectionId: string; tenantId: string; actor: string; at: string },
  db: FirestoreLike = defaultDb(),
): Promise<boolean> {
  try {
    const row = OrganisationChangeSchema.parse(change);
    const id = `${row.organisationId}_${row.tenantId ?? "org"}_${row.at}_${row.kind}_${randomUUID().slice(0, 8)}`.replace(/[^\w.-]/g, "_");
    await db.collection(ORGANISATION_CHANGES).doc(id).create(Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)));
    return true;
  } catch (err) {
    console.warn(`[organisations] recording ${change.kind} for ${change.connectionId} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    return false;
  }
}

/**
 * The operator label a script records (`--by <label>`): lower case letters, digits, `_` and `-`,
 * up to 40 characters. No `@` and no dots, so no email address or domain is ever stored.
 */
export const OPERATOR_LABEL = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * The actor an operator script records on organisation_changes rows: `script:<label>` (set-plan,
 * move-brand) or `backfill:<label>` (backfill-organisations). Throws on a label that isn't plain.
 */
export function scriptActor(tool: "script" | "backfill", label: string | undefined): string {
  if (!label || !OPERATOR_LABEL.test(label)) {
    throw new TenantValidationError("--by takes a short label: lower case letters, digits, _ and -, up to 40 characters, with no @ or dots");
  }
  return `${tool}:${label}`;
}

/** A brand as the drift report reads it. */
export type DriftBrand = { id: string; organisationId?: string; orgPlan?: PlanId };

/**
 * What `scripts/backfill-organisations.ts --check` reports. Everything but `ownerless` is drift
 * (the check exits 1); `ownerless` is a warning.
 */
export interface OrganisationDrift {
  /** Brands with no organisation. They are open (no plan) until the backfill gives them one. */
  open: string[];
  /** A brand points at an organisation that is missing or does not parse. */
  missingOrganisation: Array<{ tenantId: string; organisationId: string }>;
  /** A brand points at an organisation that does not list it. */
  notListed: Array<{ tenantId: string; organisationId: string }>;
  /** A brand's orgPlan copy differs from its organisation's plan (null: no copy, or damaged). */
  planDrift: Array<{ tenantId: string; organisationId: string; orgPlan: PlanId | null; plan: PlanId }>;
  /** An organisation lists a brand that does not exist. */
  missingBrands: Array<{ organisationId: string; tenantId: string }>;
  /** An organisation lists a brand that points at another organisation, or at none. */
  listedElsewhere: Array<{ organisationId: string; tenantId: string; linkedTo: string | null }>;
  /** A brand with no organisation whose org_<tenantId> lists other brands, so the backfill can't use it. */
  conflicts: Array<{ tenantId: string; organisationId: string }>;
  /** Warning: organisations with more than one brand and no owners, so nobody sees their totals. */
  ownerless: string[];
}

/** Whether a drift report has anything to repair (the ownerless warning does not count). */
export function hasDrift(d: OrganisationDrift): boolean {
  return [d.open, d.missingOrganisation, d.notListed, d.planDrift, d.missingBrands, d.listedElsewhere, d.conflicts].some((list) => list.length > 0);
}

/**
 * Compare every brand with every organisation: the links both ways, the plan copies and the
 * org_<id> each unlinked brand would take. Pure; the backfill's --check reads both lists once.
 */
export function organisationDrift(brands: readonly DriftBrand[], organisations: readonly Organisation[]): OrganisationDrift {
  const orgs = new Map(organisations.map((o) => [o.id, o]));
  const brandById = new Map(brands.map((b) => [b.id, b]));
  const drift: OrganisationDrift = { open: [], missingOrganisation: [], notListed: [], planDrift: [], missingBrands: [], listedElsewhere: [], conflicts: [], ownerless: [] };

  for (const b of brands) {
    if (!b.organisationId) {
      drift.open.push(b.id);
      const own = orgs.get(organisationIdFor(b.id));
      if (own && own.brandIds.length > 0 && !own.brandIds.includes(b.id)) drift.conflicts.push({ tenantId: b.id, organisationId: own.id });
      continue;
    }
    const org = orgs.get(b.organisationId);
    if (!org) {
      drift.missingOrganisation.push({ tenantId: b.id, organisationId: b.organisationId });
      continue;
    }
    if (!org.brandIds.includes(b.id)) drift.notListed.push({ tenantId: b.id, organisationId: org.id });
    if (b.orgPlan !== org.plan) drift.planDrift.push({ tenantId: b.id, organisationId: org.id, orgPlan: b.orgPlan ?? null, plan: org.plan });
  }

  for (const org of organisations) {
    for (const id of org.brandIds) {
      const b = brandById.get(id);
      if (!b) drift.missingBrands.push({ organisationId: org.id, tenantId: id });
      else if (b.organisationId !== org.id) drift.listedElsewhere.push({ organisationId: org.id, tenantId: id, linkedTo: b.organisationId ?? null });
    }
    if (org.brandIds.length > 1 && org.ownerIds.length === 0) drift.ownerless.push(org.id);
  }
  return drift;
}
