import { after } from "next/server";
import { embedForSearch, SEARCH_EMBEDDING_TAG } from "@/lib/agents/embeddings";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { searchStoreFor } from "@/lib/tenant/searchIndex";
import type { TenantContext } from "@/lib/tenant/types";
import { isFamilyRecord } from "./family";
import { isSearchFamilyIndexEnabled, isSearchIndexEnabled, isSearchKindIdeaBoardEnabled } from "./flags";
import { chunkText, contentHash, toPlainText } from "./text";
import type { SearchChunkDoc, SearchKind, SearchManifest, SearchSource, SearchStore, StoredSearchKind, StoredSearchManifest } from "./types";
import { sourceKeyOf, storedKindsFor } from "./types";

/**
 * Keeps one record's chunks in the brand's search index: plain text, chunks, a hash, and an
 * embedding per chunk only when something changed, with the record's status on every chunk when it
 * has one (ADR-0023). Never throws to its caller: indexing must never break a save, so a failure
 * is logged and the scheduled check tries again.
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

/** What indexing one record did, and its first chunk's vector (made now, or read back when unchanged). */
export interface IndexResult {
  outcome: IndexOutcome;
  vector: number[] | null;
}

/** One record to index, with what the scheduled check already knows of it. */
interface IndexItem {
  source: SearchSource;
  prev?: SearchManifest | null;
  version?: string;
}

/** A record's text as the index keeps it: its pieces (chunks), their hash and language. */
function piecesOf(source: SearchSource): { pieces: Array<{ title: string; text: string; url: string }>; hash: string; lang: string } {
  const title = (source.title ?? "").trim().slice(0, 500);
  const url = source.url ?? "";
  const pieces: Array<{ title: string; text: string; url: string }> = source.parts
    ? source.parts
        .slice(0, MAX_PARTS_PER_SOURCE)
        .map((p) => ({ title: (p.title ?? title).trim().slice(0, 500), text: toPlainText(p.text).slice(0, MAX_PART_CHARS), url: p.url ?? url }))
        .filter((p) => p.text)
    : chunkText(toPlainText(source.body ?? "", source.format)).map((text) => ({ title, text, url }));
  if (!pieces.length && title) pieces.push({ title, text: title, url });
  const lang = (source.lang ?? "en").trim().toLowerCase() || "en";
  // The status is not part of the hash: a status change rewrites the field and embeds nothing.
  const hash = contentHash(
    SEARCH_EMBEDDING_TAG,
    lang,
    pieces.map((p) => `${p.title}\u0002${p.url}\u0002${p.text}`),
  );
  return { pieces, hash, lang };
}

/** What indexing a record would do, for a dry run: embed its chunks, rewrite its status only, or nothing. */
export interface IndexEstimate {
  action: "embed" | "status" | "none" | "remove";
  chunks: number;
  /** Characters sent to the embedding model (titles and text), about 4 to a token. */
  chars: number;
}

/** What indexSource would do with this record, given its manifest, without writing or embedding. */
export function estimateIndex(source: SearchSource, prev: SearchManifest | null): IndexEstimate {
  const { pieces, hash } = piecesOf(source);
  if (!pieces.length) return { action: prev ? "remove" : "none", chunks: 0, chars: 0 };
  if (prev && prev.hash === hash && prev.embedded) return { action: (prev.status ?? null) !== (source.status ?? null) ? "status" : "none", chunks: 0, chars: 0 };
  return { action: "embed", chunks: pieces.length, chars: pieces.reduce((n, p) => n + p.text.length + p.title.length, 0) };
}

/**
 * Index (or re-index) records, embedding everything that changed in ONE embedForSearch call. A
 * record of the brand map family (isFamilyRecord) is indexed for every brand while
 * SEARCH_FAMILY_INDEX_ENABLED is on; anything else needs the brand_search feature. Unchanged text
 * costs one read and no embedding; a status that moved is rewritten on its own (setStatus).
 * Never throws: a record that fails is "failed", and the scheduled check tries again.
 */
async function indexMany(ctx: Ctx, items: IndexItem[], deps: IndexDeps, wantVectors: boolean): Promise<IndexResult[]> {
  if (!isSearchIndexEnabled()) return items.map(() => ({ outcome: "off", vector: null }));
  const out: IndexResult[] = items.map(() => ({ outcome: "failed", vector: null }));
  const family = isSearchFamilyIndexEnabled();
  let granted = deps.granted;
  const mayIndex = async (s: SearchSource) => {
    if (family && isFamilyRecord(s.kind, s.ref)) return true;
    granted ??= await brandCanUse(ctx, "brand_search");
    return granted;
  };
  const todo: Array<{ i: number; item: IndexItem; kind: StoredSearchKind; sourceKey: string; prev: SearchManifest | null; text: ReturnType<typeof piecesOf> }> = [];
  let store: SearchStore | null = null;
  for (const [i, item] of items.entries()) {
    const kind = storedKindOf(item.source.kind);
    const sourceKey = sourceKeyOf(kind, item.source.ref);
    try {
      if (!(await mayIndex(item.source))) {
        out[i] = { outcome: "not_granted", vector: null };
        continue;
      }
      store ??= deps.store ?? searchStoreFor(ctx);
      const text = piecesOf(item.source);
      const prev = item.prev !== undefined ? item.prev : await store.getManifest(sourceKey);
      if (!text.pieces.length) {
        if (prev) await store.removeSource(sourceKey);
        out[i] = { outcome: "removed", vector: null };
        continue;
      }
      if (prev && prev.hash === text.hash && prev.embedded) {
        const status = item.source.status ?? null;
        const moved = (prev.status ?? null) !== status;
        if (moved) await store.setStatus(sourceKey, status);
        // The manifest follows: the version the check read, and, when the status moved, when. A
        // check that read the record before this write then leaves it alone (sweep.ts).
        if (moved || (item.version && prev.version !== item.version)) {
          const { status: _was, ...rest } = prev;
          await store.putManifest({
            ...rest,
            kind,
            ...(item.version ? { version: item.version } : {}),
            ...(moved ? { indexedAt: (deps.now ?? (() => new Date()))().toISOString() } : {}),
            ...(status ? { status } : {}),
          });
        }
        out[i] = { outcome: "unchanged", vector: wantVectors ? await store.vectorOf(sourceKey).catch(() => null) : null };
        continue;
      }
      todo.push({ i, item, kind, sourceKey, prev, text });
    } catch (err) {
      console.warn("[search] indexing failed:", sourceKey, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  if (!todo.length || !store) return out;

  const inputs = todo.flatMap((t) => t.text.pieces.map((p) => ({ content: p.text, title: p.title || undefined })));
  let vectors: Array<number[] | null>;
  try {
    vectors = await (deps.embed ?? embedForSearch)(inputs, ctx.region, "RETRIEVAL_DOCUMENT");
  } catch (err) {
    console.warn("[search] embedding failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return out;
  }
  const now = (deps.now ?? (() => new Date()))().toISOString();
  let at = 0;
  for (const t of todo) {
    const mine = vectors.slice(at, at + t.text.pieces.length);
    at += t.text.pieces.length;
    const status = t.item.source.status;
    try {
      const docs: SearchChunkDoc[] = t.text.pieces.map((p, chunk) => ({
        tenantId: ctx.tenantId,
        kind: t.kind,
        ref: t.item.source.ref,
        sourceKey: t.sourceKey,
        chunk,
        title: p.title,
        text: p.text,
        url: p.url,
        lang: t.text.lang,
        updatedAt: now,
        ...(status ? { status } : {}),
        ...(mine[chunk] ? { embedding: mine[chunk] as number[], embeddingModel: SEARCH_EMBEDDING_TAG } : {}),
      }));
      const embedded = docs.every((d) => d.embedding);
      const manifest: StoredSearchManifest = {
        sourceKey: t.sourceKey,
        kind: t.kind,
        ref: t.item.source.ref,
        hash: t.text.hash,
        chunks: docs.length,
        embedded,
        indexedAt: now,
        ...(t.item.version ? { version: t.item.version } : {}),
        ...(status ? { status } : {}),
      };
      await store.putSource(manifest, docs, t.prev?.chunks ?? 0);
      out[t.i] = { outcome: embedded ? "indexed" : "indexed_without_vectors", vector: mine[0] ?? null };
    } catch (err) {
      console.warn("[search] indexing failed:", t.sourceKey, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  return out;
}

/** Index (or re-index) one record. Unchanged text costs one read and no embedding. */
export async function indexSource(ctx: Ctx, source: SearchSource, deps: IndexDeps = {}): Promise<IndexOutcome> {
  const [r] = await indexMany(ctx, [{ source, prev: deps.prev, version: deps.version }], deps, false);
  return r!.outcome;
}

/**
 * Index many records with one embedding call, and give back each one's first vector: the one just
 * made, or the stored one read back when its text is unchanged (null when it has none). The brand
 * map's duplicate check compares a new proposal with this vector (document with document).
 */
export async function indexSources(ctx: Ctx, sources: SearchSource[], deps: Omit<IndexDeps, "prev" | "version"> = {}): Promise<IndexResult[]> {
  return indexMany(ctx, sources.map((source) => ({ source })), deps, true);
}

export interface RemoveDeps extends Pick<IndexDeps, "store"> {
  /**
   * Remove it even while SEARCH_INDEX_ENABLED is off: erasing what a connection left behind
   * (Disconnect, Change property and the purge, ADR-0013) must not depend on a switch. It is still
   * only this brand's own path, through searchStoreFor.
   */
  force?: boolean;
}

/** Firestore's answer when a database doesn't exist: a copy without the search databases. */
function isMissingDatabase(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 5;
}

/**
 * Remove one record from the index (its record was deleted). Off does nothing, unless forced.
 * A copy that never made the search databases has nothing indexed, so that counts as removed.
 */
export async function removeFromIndex(ctx: Ctx, kind: SearchKind, ref: string, deps: RemoveDeps = {}): Promise<IndexOutcome> {
  // A delete clears the index even when the brand has since lost access: nothing is left behind.
  if (!deps.force && !isSearchIndexEnabled()) return "off";
  try {
    const store = deps.store ?? searchStoreFor(ctx);
    // Under every name the kind may be stored as, so nothing is left whichever name was in use.
    for (const name of storedKindsFor([kind])) await store.removeSource(sourceKeyOf(name, ref));
    return "removed";
  } catch (err) {
    if (isMissingDatabase(err)) return "removed";
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
