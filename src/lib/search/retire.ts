import { BRAND_MAP_VECTOR_KINDS, countBrandMapVectors, deleteBrandMapVectors, type BrandMapVectorKind } from "@/lib/tenant/brandMapVectors";
import { searchStoreFor } from "@/lib/tenant/searchIndex";
import type { TenantContext } from "@/lib/tenant/types";
import type { Region } from "@/lib/types/tenant";
import { articleIdOfRef, noteIdOfQuestionRef } from "./family";
import type { SearchKind, SearchManifest, SearchStore } from "./types";

/**
 * scripts/retire-old-vectors.ts (ADR-0023): after the retire switch and the soak, count what
 * brand_map_vectors still holds per region, brand and kind beside what brand search holds of the
 * same kind, refuse when a brand would lose meaning it has nowhere else, and delete. The delete goes
 * through src/lib/tenant/brandMapVectors.ts, the only code that touches that store.
 */

/** Every switch that must be "true" in the environment's settings file before --apply. */
export const RETIRE_NEEDS = [
  "SEARCH_INDEX_ENABLED",
  "SEARCH_FAMILY_INDEX_ENABLED",
  "SEARCH_SUBJECT_READS_ENABLED",
  "SEARCH_NOTE_READS_ENABLED",
  "SEARCH_COMPETITOR_READS_ENABLED",
  "SEARCH_OLD_VECTORS_RETIRED_ENABLED",
] as const;

/** The switches the settings file doesn't turn on (an entry's value, as App Hosting reads it). */
export function switchesNotOn(settings: ReadonlyMap<string, { value?: string }>): string[] {
  return RETIRE_NEEDS.filter((name) => settings.get(name)?.value !== "true");
}

/** Where each old kind lives in brand search: its kind there, and which refs are it. */
const IN_INDEX: Record<BrandMapVectorKind, { kind: SearchKind; is: (ref: string) => boolean }> = {
  subject: { kind: "subject", is: () => true },
  situation: { kind: "situation", is: () => true },
  note: { kind: "note", is: () => true },
  question: { kind: "question", is: (ref) => noteIdOfQuestionRef(ref) !== null },
  competitor_article: { kind: "competitor", is: (ref) => articleIdOfRef(ref) !== null },
};

/** One brand's count of one kind in each store. */
export interface RetireRow {
  tenantId: string;
  region: Region;
  kind: BrandMapVectorKind;
  old: number;
  index: number;
}

export interface RetireDeps {
  countOld?: typeof countBrandMapVectors;
  deleteOld?: typeof deleteBrandMapVectors;
  store?: (ctx: Pick<TenantContext, "tenantId" | "region">) => SearchStore;
}

/** How many of each old kind brand search holds, from a brand's manifests. */
export function indexCounts(manifests: SearchManifest[]): Record<BrandMapVectorKind, number> {
  const out = Object.fromEntries(BRAND_MAP_VECTOR_KINDS.map((k) => [k, 0])) as Record<BrandMapVectorKind, number>;
  for (const m of manifests) {
    for (const k of BRAND_MAP_VECTOR_KINDS) if (m.kind === IN_INDEX[k].kind && IN_INDEX[k].is(m.ref)) out[k] += 1;
  }
  return out;
}

/** Count both stores for each brand, a row per kind that either store holds. */
export async function retireCounts(tenants: Array<{ id: string; region: Region }>, deps: RetireDeps = {}): Promise<RetireRow[]> {
  const rows: RetireRow[] = [];
  for (const t of tenants) {
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    const index = indexCounts(await (deps.store ?? searchStoreFor)(ctx).listManifests());
    for (const kind of BRAND_MAP_VECTOR_KINDS) {
      const old = await (deps.countOld ?? countBrandMapVectors)(ctx, kind);
      if (old || index[kind]) rows.push({ tenantId: t.id, region: t.region, kind, old, index: index[kind] });
    }
  }
  return rows;
}

/** Brands that hold old vectors of a kind and nothing of it in brand search: deleting would lose that meaning. */
export function retireBlockers(rows: RetireRow[]): RetireRow[] {
  return rows.filter((r) => r.old > 0 && r.index === 0);
}

const counted = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The counts as lines: each brand and kind, then each region's totals. */
export function retireLines(rows: RetireRow[]): string[] {
  const lines = rows.map((r) => `${r.region} ${r.tenantId} ${r.kind}: ${r.old.toLocaleString("en-US")} old, ${r.index.toLocaleString("en-US")} in brand search${r.old > 0 && r.index === 0 ? "  REFUSED: nothing in brand search" : ""}`);
  const regions = new Map<Region, { old: number; index: number }>();
  for (const r of rows) {
    const t = regions.get(r.region) ?? { old: 0, index: 0 };
    t.old += r.old;
    t.index += r.index;
    regions.set(r.region, t);
  }
  for (const [region, t] of regions) lines.push(`${region} in all: ${counted(t.old, "old vector", "old vectors")}, ${counted(t.index, "record", "records")} in brand search`);
  return lines;
}

/** Delete every old vector the rows count, brand by brand. Returns how many went. */
export async function deleteOldVectors(rows: RetireRow[], deps: RetireDeps = {}): Promise<number> {
  let deleted = 0;
  for (const r of rows) {
    if (!r.old) continue;
    deleted += await (deps.deleteOld ?? deleteBrandMapVectors)({ tenantId: r.tenantId, region: r.region, source: "system" }, r.kind);
  }
  return deleted;
}
