import { after } from "next/server";
import { embedForSearch, SEARCH_EMBEDDING_TAG } from "@/lib/agents/embeddings";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { searchStoreFor } from "@/lib/tenant/searchIndex";
import type { TenantContext } from "@/lib/tenant/types";
import { isSearchIndexEnabled } from "./flags";
import { chunkText, contentHash, toPlainText } from "./text";
import type { SearchChunkDoc, SearchKind, SearchManifest, SearchSource, SearchStore } from "./types";
import { sourceKeyOf } from "./types";

/**
 * Keeps one record's chunks in the brand's search index: plain text, chunks, a hash, and an
 * embedding per chunk only when something changed. Never throws to its caller: indexing must
 * never break a save, so a failure is logged and the scheduled check tries again.
 */

export type IndexOutcome = "off" | "not_granted" | "unchanged" | "indexed" | "indexed_without_vectors" | "removed" | "failed";

type Ctx = Pick<TenantContext, "tenantId" | "region">;

export interface IndexDeps {
  store?: SearchStore;
  embed?: typeof embedForSearch;
  /** Whether the brand may use search, when the caller already knows (a sweep over many records). */
  granted?: boolean;
  now?: () => Date;
}

async function allowed(ctx: Ctx, deps: IndexDeps): Promise<IndexOutcome | null> {
  if (!isSearchIndexEnabled()) return "off";
  const granted = deps.granted ?? (await brandCanUse(ctx, "brand_search"));
  return granted ? null : "not_granted";
}

/** Index (or re-index) one record. Unchanged text costs one read and no embedding. */
export async function indexSource(ctx: Ctx, source: SearchSource, deps: IndexDeps = {}): Promise<IndexOutcome> {
  const stop = await allowed(ctx, deps);
  if (stop) return stop;
  const sourceKey = sourceKeyOf(source.kind, source.ref);
  try {
    const store = deps.store ?? searchStoreFor(ctx);
    const title = (source.title ?? "").trim().slice(0, 500);
    const chunks = chunkText(toPlainText(source.body ?? "", source.format));
    if (!chunks.length && title) chunks.push(title);
    const prev = await store.getManifest(sourceKey);
    if (!chunks.length) {
      if (prev) await store.removeSource(sourceKey);
      return "removed";
    }
    const url = source.url ?? "";
    const lang = (source.lang ?? "en").trim().toLowerCase() || "en";
    const hash = contentHash(SEARCH_EMBEDDING_TAG, title, url, lang, chunks);
    if (prev && prev.hash === hash && prev.embedded) return "unchanged";

    const vectors = await (deps.embed ?? embedForSearch)(
      chunks.map((content) => ({ content, title: title || undefined })),
      ctx.region,
      "RETRIEVAL_DOCUMENT",
    );
    const now = (deps.now ?? (() => new Date()))().toISOString();
    const docs: SearchChunkDoc[] = chunks.map((text, chunk) => ({
      tenantId: ctx.tenantId,
      kind: source.kind,
      ref: source.ref,
      sourceKey,
      chunk,
      title,
      text,
      url,
      lang,
      updatedAt: now,
      ...(vectors[chunk] ? { embedding: vectors[chunk] as number[], embeddingModel: SEARCH_EMBEDDING_TAG } : {}),
    }));
    const embedded = docs.every((d) => d.embedding);
    const manifest: SearchManifest = { sourceKey, kind: source.kind, ref: source.ref, hash, chunks: docs.length, embedded, indexedAt: now };
    await store.putSource(manifest, docs, prev?.chunks ?? 0);
    return embedded ? "indexed" : "indexed_without_vectors";
  } catch (err) {
    console.warn("[search] indexing failed:", sourceKey, err instanceof Error ? err.message.slice(0, 200) : "error");
    return "failed";
  }
}

/** Remove one record from the index (its record was deleted). */
export async function removeFromIndex(ctx: Ctx, kind: SearchKind, ref: string, deps: IndexDeps = {}): Promise<IndexOutcome> {
  // A delete clears the index even when the brand has since lost access: nothing is left behind.
  if (!isSearchIndexEnabled()) return "off";
  try {
    await (deps.store ?? searchStoreFor(ctx)).removeSource(sourceKeyOf(kind, ref));
    return "removed";
  } catch (err) {
    console.warn("[search] removing failed:", kind, err instanceof Error ? err.message.slice(0, 200) : "error");
    return "failed";
  }
}

/**
 * Run after the response is sent. Cloud Run may pause work left running once a response is
 * out, so inside a request this uses Next's after(); outside one (a script, a test) it just runs.
 */
function afterResponse(task: () => Promise<unknown>): void {
  const run = () => task().catch(() => undefined);
  try {
    after(run);
  } catch {
    void run();
  }
}

/**
 * Index a record in the background, after a save: never awaited by the save, never throws.
 * Off (or not granted) does nothing. The scheduled check catches anything this misses.
 */
export function indexInBackground(ctx: Ctx, source: SearchSource): void {
  if (!isSearchIndexEnabled()) return;
  afterResponse(() => indexSource(ctx, source));
}

/** Remove a record in the background, after a delete. */
export function removeInBackground(ctx: Ctx, kind: SearchKind, ref: string): void {
  if (!isSearchIndexEnabled()) return;
  afterResponse(() => removeFromIndex(ctx, kind, ref));
}
