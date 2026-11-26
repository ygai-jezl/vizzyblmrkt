import { embedForSearch } from "@/lib/agents/embeddings";
import { searchStoreFor } from "@/lib/tenant/searchIndex";
import type { TenantContext } from "@/lib/tenant/types";
import { isSearchFamilyIndexEnabled } from "./flags";
import { indexSources, removeFromIndex, type IndexResult } from "./indexer";
import type { NearestHit, SearchKind, SearchSource, SearchStatus, SearchStore } from "./types";

/**
 * The brand map family's write-through and reads (ADR-0025). Writers call these beside their
 * writes to brand_map_vectors; readers call nearestFamily once their read switch is on. Never throws.
 */

type Ctx = Pick<TenantContext, "tenantId" | "region">;

/** Test seams: the brand's index (a MemorySearchIndex store in tests) and the embedding call. */
export interface FamilyDeps {
  search?: SearchStore;
  embedSearch?: typeof embedForSearch;
}

/**
 * Family records written through at once and awaited (SEARCH_FAMILY_INDEX_ENABLED), so a duplicate
 * check right after sees a new proposal. One embedding call for them all; each record's first
 * vector comes back (made now, or read back when its text didn't change). Off: nothing is written
 * and every vector is null.
 */
export async function indexFamily(ctx: Ctx, sources: SearchSource[], deps: FamilyDeps = {}): Promise<IndexResult[]> {
  if (!sources.length || !isSearchFamilyIndexEnabled()) return sources.map(() => ({ outcome: "off", vector: null }));
  return indexSources(ctx, sources, { store: deps.search, embed: deps.embedSearch }).catch(() => sources.map(() => ({ outcome: "failed" as const, vector: null })));
}

/**
 * Family records removed, or no longer to be found: their entries go at once, forced, whatever
 * SEARCH_INDEX_ENABLED says (as erasing a connection's searches does, src/lib/connectors/erase.ts).
 */
export async function removeFamily(ctx: Ctx, kind: SearchKind, refs: string[], deps: FamilyDeps = {}): Promise<void> {
  for (const ref of new Set(refs.filter(Boolean))) {
    await removeFromIndex(ctx, kind, ref, { force: true, ...(deps.search ? { store: deps.search } : {}) }).catch(() => undefined);
  }
}

/**
 * Texts embedded the way a reader compares them: `query` for a question asked of documents (nearest
 * subjects, situations, notes, articles), or `document` with a title, as the indexer embeds what it
 * stores, for a document compared with documents (duplicate checks). Null slots when embedding fails.
 */
export async function embedForFamily(
  ctx: Ctx,
  texts: string[],
  as: { query: true } | { title: (text: string) => string },
  deps: FamilyDeps = {},
): Promise<Array<number[] | null>> {
  if (!texts.length) return [];
  const embed = deps.embedSearch ?? embedForSearch;
  const out = "query" in as
    ? embed(texts.map((content) => ({ content: content.slice(0, 2000) })), ctx.region, "RETRIEVAL_QUERY")
    : embed(texts.map((content) => ({ content: content.slice(0, 2000), title: as.title(content) })), ctx.region, "RETRIEVAL_DOCUMENT");
  return out.catch(() => texts.map(() => null));
}

/**
 * The family records of these kinds and statuses nearest a vector made by embedForFamily, each once,
 * nearest first, at least `minScore` when given. Throws when the index can't be read, so a reader
 * can tell "nothing near" from "couldn't look".
 */
export async function nearestFamily(
  ctx: Ctx,
  kinds: SearchKind[],
  vector: number[],
  opts: { statuses: SearchStatus[]; limit: number; minScore?: number; keep?: (hit: NearestHit) => boolean },
  deps: FamilyDeps = {},
): Promise<NearestHit[]> {
  const store = deps.search ?? searchStoreFor(ctx);
  const hits = await store.nearest(kinds, vector, { statuses: opts.statuses, limit: opts.limit });
  return hits.filter((h) => (opts.minScore === undefined || h.score >= opts.minScore) && (!opts.keep || opts.keep(h)));
}
