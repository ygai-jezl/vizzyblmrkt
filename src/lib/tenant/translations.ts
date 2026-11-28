import { getDb } from "./firestore";
import type { FirestoreLike } from "./types";

/**
 * The brand record's two translation fields (ASSET_TRANSLATIONS_ENABLED), each changed in a
 * transaction so two writers never undo each other. The translations themselves are read and
 * written through forTenant(ctx).translations.
 */

/** Note that one of the brand's journeys has translations to make or check. */
export async function markTranslationsQueued(
  tenantId: string,
  at: string,
  db: FirestoreLike = getDb() as unknown as FirestoreLike,
): Promise<void> {
  await db.collection("tenants").doc(tenantId).update({ translationsQueuedAt: at, updatedAt: new Date().toISOString() });
}

/**
 * Clear the brand's mark, only when it is still the one the lane read (`seen`): a publish that
 * marked it again meanwhile keeps its mark, so its work isn't lost. Returns whether it cleared.
 */
export async function clearTranslationsQueued(
  tenantId: string,
  seen: string,
  db: FirestoreLike = getDb() as unknown as FirestoreLike,
): Promise<boolean> {
  const ref = db.collection("tenants").doc(tenantId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.translationsQueuedAt !== seen) return false;
    tx.update(ref, { translationsQueuedAt: null });
    return true;
  });
}

/**
 * Take one translation call from the brand's daily allowance (`day` is the UTC date). Returns
 * false, and counts nothing, when `cap` calls were already made that day.
 */
export async function takeTranslationCall(
  tenantId: string,
  day: string,
  cap: number,
  db: FirestoreLike = getDb() as unknown as FirestoreLike,
): Promise<boolean> {
  const ref = db.collection("tenants").doc(tenantId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const raw = snap.data()?.translationCalls as { day?: unknown; count?: unknown } | undefined;
    const used = raw?.day === day && typeof raw.count === "number" ? raw.count : 0;
    if (used >= cap) return false;
    tx.update(ref, { translationCalls: { day, count: used + 1 } });
    return true;
  });
}
