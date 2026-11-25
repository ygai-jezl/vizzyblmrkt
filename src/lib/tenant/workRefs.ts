import { getDb } from "./firestore";
import { TenantValidationError } from "./errors";
import type { FirestoreLike } from "./types";

/**
 * Work's task numbers (#73), one counter per organisation in the control plane:
 * `work_refs/{organisationId}` = {organisationId, next, updatedAt}. No person data, read only by id.
 *
 * Why a counter: an organisation's tasks sit in several regional databases, and Firestore runs no
 * transaction across databases (ADR-0002), so "the highest plus one" can't be read and taken in
 * one step; a query for the highest ref would also need an index of its own. Taking refs here, in
 * one transaction, gives each task its own number. A task that then fails to write leaves a gap,
 * which is fine. An import keeps its sheet's numbers and raises the counter past the highest.
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
    const first = nextOf(snap.exists ? snap.data() : undefined);
    if (first + n - 1 > MAX_REF) throw new TenantValidationError("bad_work_refs:no_refs_left");
    txn.set(ref, { organisationId, next: first + n, updatedAt: now.toISOString() });
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
    const next = nextOf(snap.exists ? snap.data() : undefined);
    if (next > atLeast) return next;
    txn.set(ref, { organisationId, next: atLeast + 1, updatedAt: now.toISOString() });
    return atLeast + 1;
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
