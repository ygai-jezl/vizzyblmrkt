import { after } from "next/server";
import { embedForSearch, SEARCH_EMBEDDING_TAG } from "@/lib/agents/embeddings";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { searchStoreFor } from "@/lib/tenant/searchIndex";
import type { TenantContext } from "@/lib/tenant/types";
import { isSearchIndexEnabled, isSearchKindIdeaBoardEnabled } from "./flags";
import { chunkText, contentHash, toPlainText } from "./text";
import type { SearchChunkDoc, SearchKind, SearchManifest, SearchSource, SearchStore, StoredSearchKind, StoredSearchManifest } from "./types";
import { sourceKeyOf, storedKindsFor } from "./types";

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
  /** The record's manifest, when the caller already read it (null: not indexed yet). */
  prev?: SearchManifest | null;
  /** The SearchStub version being indexed, kept on the manifest for the next check. */
  version?: string;
}

/** Longest text kept from one part (a knowledge chunk is already sized for embedding). */
const MAX_PART_CHARS = 4000;
/** Most parts one record keeps (a very large knowledge source). */
export const MAX_PARTS_PER_SOURCE = 3000;

/**
 * The name a kind is written under. Idea Board items keep the older name `idea` until
 * SEARCH_KIND_IDEA_BOARD_ENABLED. Reads take both names (SEARCH_KIND_ALIASES), and the scheduled
 * check moves what is stored to the name in use, since a record's key holds the name.
 */
export function storedKindOf(kind: SearchKind): StoredSearchKind {
  return kind === "idea_board" && !isSearchKindIdeaBoardEnabled() ? "idea" : kind;
}

/** A record's key in the index, under the name its kind is written as now. */
export function storedSourceKey(kind: SearchKind, ref: string): string {
  return sourceKeyOf(storedKindOf(kind), ref);
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
  const kind = storedKindOf(source.kind);
  const sourceKey = sourceKeyOf(kind, source.ref);
  try {
    const store = deps.store ?? searchStoreFor(ctx);
    const title = (source.title ?? "").trim().slice(0, 500);
    const url = source.url ?? "";
    const pieces: Array<{ title: string; text: string; url: string }> = source.parts
      ? source.parts
          .slice(0, MAX_PARTS_PER_SOURCE)
          .map((p) => ({ title: (p.title ?? title).trim().slice(0, 500), text: toPlainText(p.text).slice(0, MAX_PART_CHARS), url: p.url ?? url }))
          .filter((p) => p.text)
      : chunkText(toPlainText(source.body ?? "", source.format)).map((text) => ({ title, text, url }));
    if (!pieces.length && title) pieces.push({ title, text: title, url });
    const prev = deps.prev !== undefined ? deps.prev : await store.getManifest(sourceKey);
    if (!pieces.length) {
      if (prev) await store.removeSource(sourceKey);
      return "removed";
    }
    const lang = (source.lang ?? "en").trim().toLowerCase() || "en";
    const hash = contentHash(
      SEARCH_EMBEDDING_TAG,
      lang,
      pieces.map((p) => `${p.title}\u0002${p.url}\u0002${p.text}`),
    );
    if (prev && prev.hash === hash && prev.embedded) {
      if (deps.version && prev.version !== deps.version) await store.putManifest({ ...prev, kind, version: deps.version });
      return "unchanged";
    }

    const vectors = await (deps.embed ?? embedForSearch)(
      pieces.map((p) => ({ content: p.text, title: p.title || undefined })),
      ctx.region,
      "RETRIEVAL_DOCUMENT",
    );
    const now = (deps.now ?? (() => new Date()))().toISOString();
    const docs: SearchChunkDoc[] = pieces.map((p, chunk) => ({
      tenantId: ctx.tenantId,
      kind,
      ref: source.ref,
      sourceKey,
      chunk,
      title: p.title,
      text: p.text,
      url: p.url,
      lang,
      updatedAt: now,
      ...(vectors[chunk] ? { embedding: vectors[chunk] as number[], embeddingModel: SEARCH_EMBEDDING_TAG } : {}),
    }));
    const embedded = docs.every((d) => d.embedding);
    const manifest: StoredSearchManifest = {
      sourceKey,
      kind,
      ref: source.ref,
      hash,
      chunks: docs.length,
      embedded,
      indexedAt: now,
      ...(deps.version ? { version: deps.version } : {}),
    };
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
    const store = deps.store ?? searchStoreFor(ctx);
    // Under every name the kind may be stored as, so nothing is left whichever name was in use.
    for (const name of storedKindsFor([kind])) await store.removeSource(sourceKeyOf(name, ref));
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
