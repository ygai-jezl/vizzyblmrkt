import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import type { TenantContext, FirestoreLike } from "./types";
import {
  TrendingTopicsDocSchema,
  trendingTopicsDocId,
  type TrendingTopicsDoc,
} from "@/lib/types/trendingTopics";

/**
 * Tenant-layer access for the grounded trending-topics store (`trending_topics`, top-level
 * REGIONAL). One "latest" doc per tenant (overwrite). The ONLY place permitted to touch this
 * collection (ESLint isolation exempts src/lib/tenant/**).
 */
export const TRENDING_TOPICS = "trending_topics" as const;

const regionalDb = (ctx: TenantContext, db?: FirestoreLike): FirestoreLike =>
  db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);

export async function writeTrendingTopics(
  ctx: TenantContext,
  doc: Omit<TrendingTopicsDoc, "id" | "tenantId">,
  db?: FirestoreLike,
): Promise<void> {
  const id = trendingTopicsDocId(ctx.tenantId);
  const parsed = TrendingTopicsDocSchema.parse({ ...doc, id, tenantId: ctx.tenantId });
  const { id: _id, ...data } = parsed;
  void _id;
  await regionalDb(ctx, db).collection(TRENDING_TOPICS).doc(id).set(data);
}

/** The raw latest doc IGNORING expiry — for the refresh cadence check only. */
export async function readTrendingTopicsRaw(
  ctx: TenantContext,
  db?: FirestoreLike,
): Promise<TrendingTopicsDoc | null> {
  const id = trendingTopicsDocId(ctx.tenantId);
  const snap = await regionalDb(ctx, db).collection(TRENDING_TOPICS).doc(id).get();
  if (!snap.exists) return null;
  const parsed = TrendingTopicsDocSchema.safeParse({ ...snap.data(), id: snap.id });
  return parsed.success && parsed.data.tenantId === ctx.tenantId ? parsed.data : null;
}

/** The tenant's latest trends, or null if none / expired. */
export async function readTrendingTopics(
  ctx: TenantContext,
  db?: FirestoreLike,
  nowIso?: string,
): Promise<TrendingTopicsDoc | null> {
  const id = trendingTopicsDocId(ctx.tenantId);
  const snap = await regionalDb(ctx, db).collection(TRENDING_TOPICS).doc(id).get();
  if (!snap.exists) return null;
  const parsed = TrendingTopicsDocSchema.safeParse({ ...snap.data(), id: snap.id });
  if (!parsed.success || parsed.data.tenantId !== ctx.tenantId) return null;
  const now = nowIso ?? new Date().toISOString();
  if (parsed.data.expiresAt < now) return null; // stale → don't steer content with it
  return parsed.data;
}
