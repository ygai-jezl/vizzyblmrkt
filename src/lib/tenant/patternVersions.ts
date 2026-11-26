import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import type { TenantContext, FirestoreLike, TransactionLike } from "./types";
import {
  LearnedPatternVersionSchema,
  patternVersionDocId,
  type LearnedPatternVersion,
} from "@/lib/types/learnedPatternVersion";

/**
 * Tenant-layer access for the learned-pattern version history (`learned_pattern_versions`,
 * top-level REGIONAL). Append-only audit trail behind the Content Steering panel + revert source.
 * The ONLY place permitted to touch this collection (ESLint isolation exempts src/lib/tenant/**).
 */
export const LEARNED_PATTERN_VERSIONS = "learned_pattern_versions" as const;

const regionalDb = (ctx: TenantContext, db?: FirestoreLike): FirestoreLike =>
  db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);

/**
 * Append an immutable version snapshot. Uses `.create()` (NOT set) so it is truly append-only:
 * two overlapping drains that both computed the same next version can't silently overwrite each
 * other's audit row — the loser throws ALREADY_EXISTS and its caller aborts before touching the
 * tenant fragment, keeping the fragment consistent with the one surviving version doc.
 */
export async function appendPatternVersion(
  ctx: TenantContext,
  version: Omit<LearnedPatternVersion, "id" | "tenantId">,
  db?: FirestoreLike,
): Promise<void> {
  const id = patternVersionDocId(ctx.tenantId, version.channel, version.version);
  const parsed = LearnedPatternVersionSchema.parse({ ...version, id, tenantId: ctx.tenantId });
  const { id: _id, ...data } = parsed;
  void _id;
  await regionalDb(ctx, db).collection(LEARNED_PATTERN_VERSIONS).doc(id).create(data);
}

/**
 * Append a version row inside a transaction (learning loops step 4), so the row and the brand's
 * pointer to it (`lb:` in loop_days) commit together or not at all. It uses `txn.create()`, so a
 * second writer that worked out the same version number fails the whole transaction instead of
 * overwriting the first. Call it after the transaction's reads. Only the loops' one writer
 * (src/lib/loops/write.ts), the person actions and the seed call it (oneWriter.test.ts).
 */
export function appendPatternVersionTx(
  txn: TransactionLike,
  ctx: TenantContext,
  version: Omit<LearnedPatternVersion, "id" | "tenantId">,
  db?: FirestoreLike,
): void {
  const id = patternVersionDocId(ctx.tenantId, version.channel, version.version);
  const parsed = LearnedPatternVersionSchema.parse({ ...version, id, tenantId: ctx.tenantId });
  const { id: _id, ...data } = parsed;
  void _id;
  txn.create(regionalDb(ctx, db).collection(LEARNED_PATTERN_VERSIONS).doc(id), data);
}

/** The channel's version timeline, newest first (for the Content Steering panel). */
export async function listPatternVersions(
  ctx: TenantContext,
  channel: string,
  limit: number,
  db?: FirestoreLike,
): Promise<LearnedPatternVersion[]> {
  const snap = await regionalDb(ctx, db)
    .collection(LEARNED_PATTERN_VERSIONS)
    .where("tenantId", "==", ctx.tenantId)
    .where("channel", "==", channel)
    .orderBy("version", "desc")
    .limit(limit)
    .get();
  return snap.docs.flatMap((d) => {
    const p = LearnedPatternVersionSchema.safeParse({ ...d.data(), id: d.id });
    return p.success ? [p.data] : [];
  });
}

/** Read one specific version (the revert source). */
export async function getPatternVersion(
  ctx: TenantContext,
  channel: string,
  version: number,
  db?: FirestoreLike,
): Promise<LearnedPatternVersion | null> {
  const id = patternVersionDocId(ctx.tenantId, channel, version);
  const snap = await regionalDb(ctx, db).collection(LEARNED_PATTERN_VERSIONS).doc(id).get();
  if (!snap.exists) return null;
  const p = LearnedPatternVersionSchema.safeParse({ ...snap.data(), id: snap.id });
  return p.success ? p.data : null;
}

function versionRef(ctx: TenantContext, channel: string, version: number, db?: FirestoreLike) {
  return regionalDb(ctx, db).collection(LEARNED_PATTERN_VERSIONS).doc(patternVersionDocId(ctx.tenantId, channel, version));
}

/**
 * Inside a regional transaction: one version row as it is now, or null (learning loops step 4).
 * The person actions read the version they restore this way, so a Forget at the same moment can't
 * slip its words back in. A row of another brand reads as missing.
 */
export async function readPatternVersionTx(
  txn: TransactionLike,
  ctx: TenantContext,
  channel: string,
  version: number,
  db?: FirestoreLike,
): Promise<LearnedPatternVersion | null> {
  const snap = await txn.get(versionRef(ctx, channel, version, db));
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  if (data.tenantId !== ctx.tenantId) return null;
  const p = LearnedPatternVersionSchema.safeParse({ ...data, id: snap.id });
  return p.success ? p.data : null;
}

/**
 * Inside a regional transaction, after its reads: take the words out of an older version row's
 * items, keeping each item's id, type and trust (learning loops step 4, Forget). The one change
 * this append only collection allows: a person asked for the words to go, so they really go.
 */
export function removeWordsTx(
  txn: TransactionLike,
  ctx: TenantContext,
  row: Pick<LearnedPatternVersion, "channel" | "version" | "items">,
  db?: FirestoreLike,
): void {
  const items = (row.items ?? []).map((i) => ({ id: i.id, type: i.type, text: null, ref: null, trust: i.trust, from: i.from }));
  txn.update(versionRef(ctx, row.channel, row.version, db), { items });
}
