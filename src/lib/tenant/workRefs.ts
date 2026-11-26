import { getDb } from "./firestore";
import { TenantValidationError } from "./errors";
import type { FirestoreLike } from "./types";

/**
 * Work's task numbers (#73), one counter per organisation in the control plane:
 * `work_refs/{organisationId}` = {organisationId, next, updatedAt}, and while an import writes its
 * sheet's numbers, `rev` and `importHold` {id, until}. No person data, read only by id.
 *
 * Why a counter: an organisation's tasks sit in several regional databases, and Firestore runs no
 * transaction across databases (ADR-0002), so "the highest plus one" can't be read and taken in
 * one step; a query for the highest ref would also need an index of its own. Taking refs here, in
 * one transaction, gives each task its own number. A task that then fails to write leaves a gap,
 * which is fine. An import keeps its sheet's numbers and raises the counter past the highest.
 *
 * An import's own numbers are checked free by reading the tasks, which no transaction can hold,
 * so an import claims the counter first (claimImportRefs): refused when the counter moved since
 * the import read it (`next` for a number taken, `rev` for another import's claim) or while
 * another import holds it, and held until it lets go (releaseImportRefs) or IMPORT_HOLD_MS pass.
 * Taking numbers (allocateWorkRefs) never waits for a hold: those are past every sheet's numbers.
 *
 * Never on the organisation's own record: a move there rewrites it whole
 * (src/lib/tenant/organisations.ts), which would drop a field it doesn't know.
 */

export const WORK_REFS = "work_refs";

const ORG_ID = /^org_[A-Za-z0-9_-]{1,155}$/;
/** The largest ref (src/lib/work/types.ts MAX_WORK_REF). */
const MAX_REF = 999_999;

function controlDb(db?: FirestoreLike): FirestoreLike {
  return db ?? (getDb() as unknown as FirestoreLike);
}

function checkOrg(organisationId: string): void {
  if (typeof organisationId !== "string" || !ORG_ID.test(organisationId)) throw new TenantValidationError("bad_work_refs:organisationId");
}

function nextOf(data: Record<string, unknown> | undefined): number {
  const n = data?.next;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : 1;
}

function revOf(data: Record<string, unknown> | undefined): number {
  const n = data?.rev;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
}

interface ImportHold {
  id: string;
  until: string;
}

function holdOf(data: Record<string, unknown> | undefined): ImportHold | null {
  const h = data?.importHold as Partial<ImportHold> | null | undefined;
  return h && typeof h.id === "string" && typeof h.until === "string" ? { id: h.id, until: h.until } : null;
}

/** The fields a write keeps as they were: the claim's rev and any import's hold. */
function keptOf(data: Record<string, unknown> | undefined): Record<string, unknown> {
  const hold = holdOf(data);
  return { ...(data?.rev !== undefined ? { rev: revOf(data) } : {}), ...(hold ? { importHold: hold } : {}) };
}

/** How long an import holds the counter at most: it lets go when it ends. */
export const IMPORT_HOLD_MS = 10 * 60_000;

/**
 * Take `n` refs for the organisation: the first is returned, and the n from it on are the caller's.
 * Refused (TenantValidationError) past the largest ref.
 */
export async function allocateWorkRefs(organisationId: string, n: number, db?: FirestoreLike, now: Date = new Date()): Promise<number> {
  checkOrg(organisationId);
  if (!Number.isInteger(n) || n < 1 || n > 5000) throw new TenantValidationError("bad_work_refs:n");
  const store = controlDb(db);
  const ref = store.collection(WORK_REFS).doc(organisationId);
  return store.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const data = snap.exists ? snap.data() : undefined;
    const first = nextOf(data);
    if (first + n - 1 > MAX_REF) throw new TenantValidationError("bad_work_refs:no_refs_left");
    txn.set(ref, { ...keptOf(data), organisationId, next: first + n, updatedAt: now.toISOString() });
    return first;
  });
}

/** Make sure new refs start after `atLeast` (an import's highest number). Returns the next ref. */
export async function raiseWorkRefs(organisationId: string, atLeast: number, db?: FirestoreLike, now: Date = new Date()): Promise<number> {
  checkOrg(organisationId);
  if (!Number.isInteger(atLeast) || atLeast < 0 || atLeast > MAX_REF) throw new TenantValidationError("bad_work_refs:atLeast");
  const store = controlDb(db);
  const ref = store.collection(WORK_REFS).doc(organisationId);
  return store.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const data = snap.exists ? snap.data() : undefined;
    const next = nextOf(data);
    if (next > atLeast) return next;
    txn.set(ref, { ...keptOf(data), organisationId, next: atLeast + 1, updatedAt: now.toISOString() });
    return atLeast + 1;
  });
}

/** What an import reads before it reads the tasks: the next ref, the claims so far, and whether another import holds the counter. */
export interface ImportRefsPeek {
  next: number;
  rev: number;
  held: boolean;
}

export async function peekImportRefs(organisationId: string, db?: FirestoreLike, now: Date = new Date()): Promise<ImportRefsPeek> {
  checkOrg(organisationId);
  const snap = await controlDb(db).collection(WORK_REFS).doc(organisationId).get();
  const data = snap.exists ? snap.data() : undefined;
  const hold = holdOf(data);
  return { next: nextOf(data), rev: revOf(data), held: hold !== null && hold.until > now.toISOString() };
}

/**
 * Claim the counter for an import that keeps its sheet's numbers, as `peek` read it before the
 * tasks were read: "moved" when a number was taken or another import claimed since, "busy" while
 * another import holds it. Claimed, new refs start after `atLeast` and the import holds the
 * counter until releaseImportRefs or IMPORT_HOLD_MS.
 */
export async function claimImportRefs(
  organisationId: string,
  claim: { peek: Pick<ImportRefsPeek, "next" | "rev">; atLeast: number; importId: string },
  db?: FirestoreLike,
  now: Date = new Date(),
): Promise<"claimed" | "moved" | "busy"> {
  checkOrg(organisationId);
  if (!Number.isInteger(claim.atLeast) || claim.atLeast < 0 || claim.atLeast > MAX_REF) throw new TenantValidationError("bad_work_refs:atLeast");
  const store = controlDb(db);
  const ref = store.collection(WORK_REFS).doc(organisationId);
  return store.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const data = snap.exists ? snap.data() : undefined;
    const hold = holdOf(data);
    if (hold && hold.id !== claim.importId && hold.until > now.toISOString()) return "busy";
    const next = nextOf(data);
    if (next !== claim.peek.next || revOf(data) !== claim.peek.rev) return "moved";
    txn.set(ref, {
      organisationId,
      next: Math.max(next, claim.atLeast + 1),
      rev: revOf(data) + 1,
      importHold: { id: claim.importId, until: new Date(now.getTime() + IMPORT_HOLD_MS).toISOString() },
      updatedAt: now.toISOString(),
    });
    return "claimed";
  });
}

/** An import lets go of the counter once its tasks are written (or failed). Another import's hold is left alone. */
export async function releaseImportRefs(organisationId: string, importId: string, db?: FirestoreLike, now: Date = new Date()): Promise<void> {
  checkOrg(organisationId);
  const store = controlDb(db);
  const ref = store.collection(WORK_REFS).doc(organisationId);
  await store.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const data = snap.exists ? snap.data() : undefined;
    if (holdOf(data)?.id !== importId) return;
    txn.set(ref, { organisationId, next: nextOf(data), rev: revOf(data), updatedAt: now.toISOString() });
  });
}

/** The next ref, without taking it (a dry run). */
export async function peekWorkRefs(organisationId: string, db?: FirestoreLike): Promise<number> {
  checkOrg(organisationId);
  const snap = await controlDb(db).collection(WORK_REFS).doc(organisationId).get();
  return nextOf(snap.exists ? snap.data() : undefined);
}

/** Forget the counter, with the organisation's Work (eraseOrganisationWork). True when there was one. */
export async function deleteWorkRefs(organisationId: string, db?: FirestoreLike): Promise<boolean> {
  checkOrg(organisationId);
  const ref = controlDb(db).collection(WORK_REFS).doc(organisationId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.delete();
  return true;
}
