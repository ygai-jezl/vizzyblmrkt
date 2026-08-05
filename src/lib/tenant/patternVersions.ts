import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import type { TenantContext, FirestoreLike } from "./types";
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
