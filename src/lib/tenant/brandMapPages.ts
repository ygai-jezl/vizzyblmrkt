import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import { TENANT_FIELD, type WhereClause } from "./repository";
import type { FirestoreLike, QueryLike, TenantContext } from "./types";

/**
 * A brand's page rows (`brand_map_pages`) a page at a time in document-id order, optionally
 * reading only some fields — for the map at any size, where a brand can have far more rows
 * than one read should hold. Document-id order needs no composite index (Firestore's
 * single-field indexes end in it), and rows written before a field existed are still read
 * (ordering by a stored field would skip them). Always behind the tenant predicate.
 */
export const BRAND_MAP_PAGES = "brand_map_pages" as const;

export type PageRowDoc = { id: string } & Record<string, unknown>;

export async function pageBrandMapPages(
  ctx: TenantContext,
  opts: { where?: WhereClause[]; fields?: string[]; after?: string | null; limit: number },
  db?: FirestoreLike,
): Promise<{ rows: PageRowDoc[]; last: string | null; more: boolean }> {
  const regional = db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);
  let q: QueryLike = regional.collection(BRAND_MAP_PAGES).where(TENANT_FIELD, "==", ctx.tenantId);
  for (const [field, op, value] of opts.where ?? []) if (field !== TENANT_FIELD) q = q.where(field, op, value);
  q = q.orderBy("__name__", "asc");
  if (opts.fields && q.select) q = q.select(...new Set([TENANT_FIELD, ...opts.fields]));
  if (opts.after) q = q.startAfter(opts.after);
  const snap = await q.limit(opts.limit).get();
  const rows: PageRowDoc[] = [];
  for (const d of snap.docs) {
    const data = d.data() ?? {};
    if (data[TENANT_FIELD] !== ctx.tenantId) continue; // defence in depth
    rows.push({ ...data, id: d.id });
  }
  return { rows, last: snap.docs.length ? snap.docs[snap.docs.length - 1]!.id : null, more: snap.docs.length === opts.limit };
}

/** Every row that matches, a page at a time (a runaway backstop, not an expected limit). */
export async function listAllBrandMapPages(
  ctx: TenantContext,
  opts: { where?: WhereClause[]; fields?: string[]; pageSize?: number; maxRows?: number } = {},
  db?: FirestoreLike,
): Promise<PageRowDoc[]> {
  const size = opts.pageSize ?? 500;
  const max = opts.maxRows ?? 100_000;
  const out: PageRowDoc[] = [];
  let after: string | null = null;
  while (out.length < max) {
    const page = await pageBrandMapPages(ctx, { where: opts.where, fields: opts.fields, after, limit: size }, db);
    out.push(...page.rows);
    if (!page.more || !page.last) break;
    after = page.last;
  }
  return out.slice(0, max);
}
