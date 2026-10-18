import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import type { FirestoreLike, KnowledgeCollectionLike, TenantContext } from "./types";

/**
 * The brand map's embeddings (BRAND_MAP_SCALE_ENABLED): one per subject and per buying
 * situation, in their own regional collection so the records themselves stay small (a
 * 768-number vector is ~6 KB; 5,000 of them inside subject records would be ~30 MB a
 * list). The ONLY place that writes their VectorValue (the ESLint isolation rule exempts
 * src/lib/tenant/**). Searches pre-filter by brand and kind: the composite vector index
 * `[tenantId, kind, embedding]` (firestore.indexes.json).
 */
export const BRAND_MAP_VECTORS = "brand_map_vectors" as const;

/** `note`: one of the brand's first-hand notes (What we've seen, BRAND_NOTES_ENABLED). */
export type BrandMapVectorKind = "subject" | "situation" | "note";

/** At most this many neighbours per search (Firestore allows 1,000; nothing here needs more). */
export const MAX_NEAREST = 50;

export function brandMapVectorDocId(tenantId: string, kind: BrandMapVectorKind, ref: string): string {
  return `vec_${createHash("sha256").update(`${tenantId}\n${kind}\n${ref}`).digest("hex").slice(0, 40)}`;
}

function regionalDb(ctx: TenantContext, db?: FirestoreLike): FirestoreLike {
  return db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);
}

/** Store (or replace) a record's embedding, with its status so a search can leave out what isn't on the map. */
export async function writeBrandMapVector(
  ctx: TenantContext,
  row: { kind: BrandMapVectorKind; ref: string; status: string },
  vector: number[],
  db?: FirestoreLike,
): Promise<void> {
  await regionalDb(ctx, db)
    .collection(BRAND_MAP_VECTORS)
    .doc(brandMapVectorDocId(ctx.tenantId, row.kind, row.ref))
    .set({
      tenantId: ctx.tenantId,
      kind: row.kind,
      ref: row.ref,
      status: row.status,
      embedding: FieldValue.vector(vector),
      updatedAt: new Date().toISOString(),
    });
}

/** Keep a stored embedding's status in step with its record (it is searched by status). */
export async function setBrandMapVectorStatus(
  ctx: TenantContext,
  row: { kind: BrandMapVectorKind; ref: string; status: string },
  db?: FirestoreLike,
): Promise<void> {
  const ref = regionalDb(ctx, db).collection(BRAND_MAP_VECTORS).doc(brandMapVectorDocId(ctx.tenantId, row.kind, row.ref));
  const snap = await ref.get();
  if (snap.exists && snap.data()?.tenantId === ctx.tenantId) await ref.update({ status: row.status });
}

export async function removeBrandMapVector(ctx: TenantContext, kind: BrandMapVectorKind, ref: string, db?: FirestoreLike): Promise<void> {
  const doc = regionalDb(ctx, db).collection(BRAND_MAP_VECTORS).doc(brandMapVectorDocId(ctx.tenantId, kind, ref));
  const snap = await doc.get();
  if (snap.exists && snap.data()?.tenantId === ctx.tenantId) await doc.delete();
}

/** Vector-capable, brand-scoped collection for findNearest. Test seam: `override`. */
export function brandMapVectorsRef(ctx: TenantContext, override?: KnowledgeCollectionLike): KnowledgeCollectionLike {
  if (override) return override;
  return getDb(databaseIdForRegion(ctx.region))
    .collection(BRAND_MAP_VECTORS)
    .where("tenantId", "==", ctx.tenantId) as unknown as KnowledgeCollectionLike;
}

export interface BrandMapNeighbour {
  ref: string;
  status: string;
  /** Cosine similarity (1 − distance), 0 to 1. */
  sim: number;
}

/**
 * The records of a kind nearest a query vector, most similar first. Asks for a few more than
 * wanted and leaves out any whose status isn't wanted (the index has no status), and any not
 * this brand's (defence in depth).
 */
export async function nearestBrandMapRecords(
  ctx: TenantContext,
  args: { kind: BrandMapVectorKind; vector: number[]; limit: number; statuses?: string[]; minSim?: number },
  override?: KnowledgeCollectionLike,
): Promise<BrandMapNeighbour[]> {
  const limit = Math.max(1, Math.min(args.limit, MAX_NEAREST));
  const statuses = new Set(args.statuses ?? ["decided"]);
  const snap = await brandMapVectorsRef(ctx, override)
    .where("kind", "==", args.kind)
    .findNearest({
      vectorField: "embedding",
      queryVector: args.vector,
      limit: Math.min(MAX_NEAREST, limit * 2),
      distanceMeasure: "COSINE",
      distanceResultField: "_distance",
    })
    .get();
  const out: BrandMapNeighbour[] = [];
  for (const d of snap.docs) {
    const data = d.data() ?? {};
    if (data.tenantId !== ctx.tenantId || data.kind !== args.kind) continue;
    if (typeof data.ref !== "string" || !statuses.has(String(data.status))) continue;
    const distance = typeof data._distance === "number" ? data._distance : 1;
    const sim = Math.max(0, Math.min(1, 1 - distance));
    if (args.minSim !== undefined && sim < args.minSim) continue;
    out.push({ ref: data.ref, status: String(data.status), sim });
  }
  return out.sort((a, b) => b.sim - a.sim).slice(0, limit);
}
