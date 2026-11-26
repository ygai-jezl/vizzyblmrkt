import { listNotes } from "@/lib/brandNotes/store";
import { BRAND_MAP_VECTOR_KINDS, countBrandMapVectors, deleteBrandMapVectors, listBrandMapVectorRefs, type BrandMapVectorKind } from "@/lib/tenant/brandMapVectors";
import { searchStoreFor } from "@/lib/tenant/searchIndex";
import type { TenantContext } from "@/lib/tenant/types";
import type { BrandNote } from "@/lib/types/brandNote";
import type { Region } from "@/lib/types/tenant";
import { articleIdOfRef, noteIdOfQuestionRef, noteSearchSources } from "./family";
import type { SearchKind, SearchManifest, SearchStatus, SearchStore } from "./types";

/**
 * scripts/retire-old-vectors.ts (ADR-0025): after the retire switch and the soak, count what
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

/**
 * Where each old kind lives in brand search: its kind there, which refs are it, and the statuses
 * its readers find (an entry with no status is from before the family and no reader finds it).
 */
const IN_INDEX: Record<BrandMapVectorKind, { kind: SearchKind; is: (ref: string) => boolean; statuses: readonly SearchStatus[] }> = {
  subject: { kind: "subject", is: () => true, statuses: ["decided", "proposed"] },
  situation: { kind: "situation", is: () => true, statuses: ["decided", "proposed"] },
  note: { kind: "note", is: () => true, statuses: ["kept"] },
  question: { kind: "question", is: (ref) => noteIdOfQuestionRef(ref) !== null, statuses: ["asked", "answered"] },
  competitor_article: { kind: "competitor", is: (ref) => articleIdOfRef(ref) !== null, statuses: ["kept"] },
};

/** One brand's count of one kind in each store. */
export interface RetireRow {
  tenantId: string;
  region: Region;
  kind: BrandMapVectorKind;
  old: number;
  /** Records of the kind in brand search that its readers find (with the family's status). */
  index: number;
  /**
   * Old vectors of records brand search never holds, so nothing is lost when they go: a note that
   * may name a customer (decision 40), one not kept or no longer asked, or one that is gone.
   */
  keptOut: number;
}

export interface RetireDeps {
  countOld?: typeof countBrandMapVectors;
  listOld?: typeof listBrandMapVectorRefs;
  deleteOld?: typeof deleteBrandMapVectors;
  notes?: (ctx: TenantContext) => Promise<BrandNote[]>;
  store?: (ctx: Pick<TenantContext, "tenantId" | "region">) => SearchStore;
}

/**
 * How many of each old kind brand search holds for its readers, from a brand's manifests: only
 * those with the family's status, since a reader never finds an entry without one.
 */
export function indexCounts(manifests: SearchManifest[]): Record<BrandMapVectorKind, number> {
  const out = Object.fromEntries(BRAND_MAP_VECTOR_KINDS.map((k) => [k, 0])) as Record<BrandMapVectorKind, number>;
  for (const m of manifests) {
    for (const k of BRAND_MAP_VECTOR_KINDS) {
      const at = IN_INDEX[k];
      if (m.kind === at.kind && at.is(m.ref) && m.status && at.statuses.includes(m.status)) out[k] += 1;
    }
  }
  return out;
}

/** The old note and question vectors kept out of brand search: their note is gone, may name a customer, or isn't kept or asked. */
export function keptOutOfIndex(kind: "note" | "question", oldRefs: string[], notes: BrandNote[]): number {
  const byId = new Map(notes.map((n) => [n.id, n]));
  // The old store keys an open question by its note's id; brand search by note_{id}.
  return oldRefs.filter((ref) => {
    const n = byId.get(ref);
    return !n || !noteSearchSources(n).some((src) => src.kind === kind);
  }).length;
}

/** Count both stores for each brand, a row per kind that either store holds. */
export async function retireCounts(tenants: Array<{ id: string; region: Region }>, deps: RetireDeps = {}): Promise<RetireRow[]> {
  const rows: RetireRow[] = [];
  for (const t of tenants) {
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    const index = indexCounts(await (deps.store ?? searchStoreFor)(ctx).listManifests());
    let notes: BrandNote[] | null = null;
    for (const kind of BRAND_MAP_VECTOR_KINDS) {
      const old = await (deps.countOld ?? countBrandMapVectors)(ctx, kind);
      let keptOut = 0;
      if (old && (kind === "note" || kind === "question")) {
        notes ??= await (deps.notes ?? ((c) => listNotes(c)))(ctx);
        keptOut = keptOutOfIndex(kind, await (deps.listOld ?? listBrandMapVectorRefs)(ctx, kind), notes);
      }
      if (old || index[kind]) rows.push({ tenantId: t.id, region: t.region, kind, old, index: index[kind], keptOut });
    }
  }
  return rows;
}

/**
 * Brands that hold old vectors of a kind that brand search is meant to hold, and nothing of it
 * there for the readers: deleting would lose that meaning. Vectors of records brand search never
 * holds (keptOut) don't count.
 */
export function retireBlockers(rows: RetireRow[]): RetireRow[] {
  return rows.filter((r) => r.old - r.keptOut > 0 && r.index === 0);
}

const counted = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The counts as lines: each brand and kind, then each region's totals. */
export function retireLines(rows: RetireRow[]): string[] {
  const blocked = new Set(retireBlockers(rows));
  const lines = rows.map(
    (r) =>
      `${r.region} ${r.tenantId} ${r.kind}: ${r.old.toLocaleString("en-US")} old` +
      `${r.keptOut ? ` (${r.keptOut.toLocaleString("en-US")} of records brand search never holds)` : ""}, ${r.index.toLocaleString("en-US")} in brand search` +
      `${blocked.has(r) ? "  REFUSED: nothing in brand search" : ""}`,
  );
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
