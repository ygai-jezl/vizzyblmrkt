import { REGION_CONFIGS, searchDatabaseIdForRegion } from "@/lib/tenant/region";
import { searchStoreFor } from "@/lib/tenant/searchIndex";
import type { TenantContext } from "@/lib/tenant/types";
import { SEARCH_EMBEDDING_MODEL } from "@/lib/agents/embeddings";
import { canRerank } from "./rerank";
import { shownToPeople, type SearchKind, type SearchStore } from "./types";

/**
 * What the Search card in Settings shows: what is in the index, where it lives, and how fresh it
 * is. It counts only what people can find: proposals and answered questions kept for the readers
 * that match by meaning (ADR-0023) are left out.
 */
export interface IndexSummary {
  records: number;
  chunks: number;
  /** Records whose text is kept but not embedded yet (found by words only for now). */
  waitingForMeaning: number;
  byKind: Partial<Record<SearchKind, number>>;
  lastIndexedAt: string | null;
  database: string;
  location: string;
  model: string;
  reranked: boolean;
}

export async function indexSummary(ctx: Pick<TenantContext, "tenantId" | "region">, deps: { store?: SearchStore } = {}): Promise<IndexSummary> {
  const manifests = (await (deps.store ?? searchStoreFor(ctx)).listManifests()).filter((m) => shownToPeople(m.status));
  const byKind: Partial<Record<SearchKind, number>> = {};
  let chunks = 0;
  let waitingForMeaning = 0;
  let last = "";
  for (const m of manifests) {
    byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
    chunks += m.chunks;
    if (!m.embedded) waitingForMeaning += 1;
    if (m.indexedAt > last) last = m.indexedAt;
  }
  return {
    records: manifests.length,
    chunks,
    waitingForMeaning,
    byKind,
    lastIndexedAt: last || null,
    database: searchDatabaseIdForRegion(ctx.region),
    location: REGION_CONFIGS[ctx.region]?.displayName ?? ctx.region,
    model: SEARCH_EMBEDDING_MODEL,
    reranked: canRerank(ctx.region),
  };
}
