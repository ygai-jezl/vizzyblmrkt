import { getDb } from "./firestore";
import type { FirestoreLike } from "./types";
import { LaneDocSchema, type LaneDoc } from "@/lib/types/loopLane";

/**
 * The loops lane's control plane bookkeeping (`loop_lane`, learning loops step 4): the `lane`
 * document, which holds the lane's cursor through the brands, the brand count its page size
 * follows, and the learner calls made today across the copy. It is the copy's own, not any
 * brand's, so it lives in the control plane `(default)` database for every region and is read
 * and written only by the lane (src/lib/loops/tick.ts). Step 5 adds one mark per organisation.
 */
export const LOOP_LANE = "loop_lane" as const;

/** The one document the lane keeps. */
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
