import { TenantValidationError } from "./errors";
import { getDb } from "./firestore";
import type { DocRefLike, FirestoreLike, TransactionLike } from "./types";
import { LaneDocSchema, LaneMarkSchema, type LaneDoc, type LaneMark } from "@/lib/types/loopLane";

/**
 * The loops lane's control plane bookkeeping (`loop_lane`, learning loops steps 4 and 5). It is
 * the copy's own, not any brand's, so it lives in the control plane `(default)` database for every
 * region and is read and written only by the lane (src/lib/loops/tick.ts):
 *
 * - the `lane` document (step 4): the lane's cursor through the brands, the brand count its page
 *   size follows, and the learner calls made today across the copy;
 * - one mark per organisation (step 5): `o:<organisationId>`, or `o:t:<tenantId>` for a brand with
 *   no organisation, so an organisation with several brands counts once in each cell across brands
 *   (`fleet_cells`, ./fleetCells.ts). A mark holds its newest week only. Nothing on screen reads it.
 *
 * Every mark id is built here from the brand's own record as the lane read it from the registry,
 * never from a request. A mark is erased with its organisation, and a brand's own mark with its
 * brand, once a path deletes either (the ontology names the gap).
 */
export const LOOP_LANE = "loop_lane" as const;

/** The one document the lane keeps for itself. */
export const LANE_DOC_ID = "lane" as const;

const controlDb = (db?: FirestoreLike): FirestoreLike => db ?? (getDb() as unknown as FirestoreLike);

/** The lane's document, or a fresh one (cursor at the start) when there is none or it can't be read. */
export async function readLoopLane(db?: FirestoreLike): Promise<LaneDoc> {
  const snap = await controlDb(db).collection(LOOP_LANE).doc(LANE_DOC_ID).get();
  const p = LaneDocSchema.safeParse((snap.exists ? snap.data()?.d : undefined) ?? {});
  return p.success ? p.data : LaneDocSchema.parse({});
}

/** Replace the lane's document: one write a run. */
export async function writeLoopLane(doc: LaneDoc, db?: FirestoreLike): Promise<void> {
  await controlDb(db).collection(LOOP_LANE).doc(LANE_DOC_ID).set({ d: LaneDocSchema.parse(doc) });
}

// --- One mark per organisation (step 5) ----------------------------------------------------

/** The ids a mark may hold: no colon or slash, so its parts stay apart and it stays one document. */
const MARK_ID_PART = /^[A-Za-z0-9_-]{1,160}$/;

function markPart(what: string, id: string): string {
  if (!MARK_ID_PART.test(id)) throw new TenantValidationError(`loop_lane needs ${what} of letters, digits, underscores and hyphens only`);
  return id;
}

/** The mark an organisation counts under: its organisation's, or the brand's own when it has none. */
export function laneMarkId(brand: { tenantId: string; organisationId?: string | null }): string {
  return brand.organisationId ? `o:${markPart("an organisation id", brand.organisationId)}` : `o:t:${markPart("a tenant id", brand.tenantId)}`;
}

const MARK_ID = /^o:(?:t:)?[A-Za-z0-9_-]{1,160}$/;

function markRef(markId: string, db?: FirestoreLike): DocRefLike {
  if (!MARK_ID.test(markId)) throw new TenantValidationError("loop_lane marks are o:<organisationId> or o:t:<tenantId>, built by laneMarkId");
  return controlDb(db).collection(LOOP_LANE).doc(markId);
}

/** Run a transaction in the control plane, where the marks live: the heartbeat moves one mark per transaction. */
export function runLaneTransaction<T>(fn: (txn: TransactionLike) => Promise<T>, db?: FirestoreLike): Promise<T> {
  return controlDb(db).runTransaction(fn);
}

/**
 * Inside runLaneTransaction: an organisation's mark as it is now, or null when it has none or what
 * is stored can't be read (the heartbeat then starts its week afresh, which can only undercount).
 */
export async function readLaneMarkTx(txn: TransactionLike, markId: string, db?: FirestoreLike): Promise<LaneMark | null> {
  const snap = await txn.get(markRef(markId, db));
  if (!snap.exists) return null;
  const p = LaneMarkSchema.safeParse(snap.data()?.d);
  return p.success ? p.data : null;
}

/** Inside runLaneTransaction, after its reads: replace an organisation's mark with its newest week. */
export function writeLaneMarkTx(txn: TransactionLike, markId: string, mark: LaneMark, db?: FirestoreLike): void {
  txn.set(markRef(markId, db), { d: LaneMarkSchema.parse(mark) });
}
