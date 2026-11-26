import { createHash } from "node:crypto";
import type { Firestore } from "@google-cloud/firestore";
import type * as Pipelines from "@google-cloud/firestore/pipelines";
import type { PipelineResult, PipelineSource } from "@google-cloud/firestore/pipelines";
import type { Region } from "@/lib/types/tenant";
import { localWordsScore } from "@/lib/search/text";
import type { NearestHit, RankedChunk, SearchKind, SearchManifest, SearchStatus, SearchStore } from "@/lib/search/types";
import { isSearchStatus, PEOPLE_STATUSES, readSearchKind, shownToPeople, storedKindsFor } from "@/lib/search/types";
import { searchDatabaseIdForRegion } from "./region";
import type { TenantContext } from "./types";

/**
 * The brand search index: the ONLY code that reads or writes the search databases (the ESLint
 * isolation rule exempts src/lib/tenant/**).
 *
 * Where: a separate Firestore Enterprise database per region (search, search-eu, search-asia),
 * reached with @google-cloud/firestore 9 (it has pipelines; the app's own databases stay on
 * firebase-admin's client). Server only: the runtime service account, through IAM.
 *
 * Isolation: every brand has its own path, brands/{tenantId}/search_docs. Firestore's search()
 * must be the first stage after the collection stage, so a filter can't narrow a text search to
 * one brand afterwards; the path does it. Every doc also carries tenantId, and reads drop any
 * doc whose tenantId isn't this brand's (defence in depth).
 *
 * The emulator has no search() stage, and `npm run local` runs it in Standard edition (Enterprise
 * mode breaks the app's own paging), which refuses pipelines. So on the emulator text search
 * runs in code over the brand's own docs (localWordsScore), and search by meaning uses the
 * classic findNearest query. Both go through the same brand path.
 *
 * Statuses (ADR-0025): the brand map family's chunks carry a status. People's search (words and
 * meaning) keeps chunks with no status or a status people may see (PEOPLE_STATUSES), and the
 * readers' nearest keeps the statuses they ask for. Both filter BEFORE the search: a where stage
 * ahead of findNearest, which Firestore runs on the documents the stage before it gives. Pipelines
 * don't use vector indexes yet (Google's pipeline docs, known limitations), so the nearest is a
 * flat scan of the brand's matching chunks either way, which filtering first only makes smaller.
 * On the emulator the status filter runs in code over a raised limit.
 *
 * Loading: @google-cloud/firestore 9 brings a second Google API and gRPC stack, so it loads when
 * the index is first used (searchDb), and its pipelines with the first search. Only types are
 * imported at the top, and an instance that never touches the index never loads either.
 */

export const SEARCH_DOCS = "search_docs" as const;
export const SEARCH_SOURCES = "search_sources" as const;
/** Fields a search returns (never the embedding: it is most of each doc's size). */
const RESULT_FIELDS = ["tenantId", "sourceKey", "kind", "ref", "chunk", "title", "text", "url", "status"] as const;
/** Fields the readers' nearest returns, plus its score. */
const NEAREST_FIELDS = ["tenantId", "sourceKey", "kind", "ref", "status"] as const;
/** Where findNearest writes each result's dot product. */
const SCORE_FIELD = "_score";
/** The most docs the emulator's stand-in text search reads for one brand. */
const LOCAL_SCAN_LIMIT = 2000;
/** On the emulator, how many nearest chunks are read before statuses are filtered in code (Firestore's most). */
const LOCAL_NEAREST_LIMIT = 1000;
/** The most records the readers' nearest returns at once. */
export const MAX_NEAREST_RECORDS = 50;
/**
 * Chunks asked for per record wanted, so a record spread over several chunks still leaves room
 * for others once each record is kept once.
 */
const CHUNKS_PER_RECORD = 3;
/** Firestore allows 500 writes in a batch; chunks are large, so smaller batches. */
const WRITE_BATCH = 100;

const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** brands/{tenantId}: refuses an id that could step outside its own folder. */
export function brandRoot(tenantId: string): string {
  if (!TENANT_ID_RE.test(tenantId)) throw new Error("search_index_bad_tenant");
  return `brands/${tenantId}`;
}

export function searchChunkId(sourceKey: string, chunk: number): string {
  return `c_${createHash("sha256").update(sourceKey).digest("hex").slice(0, 32)}_${chunk}`;
}

export function searchManifestId(sourceKey: string): string {
  return `s_${createHash("sha256").update(sourceKey).digest("hex").slice(0, 32)}`;
}

function onEmulator(): boolean {
  return Boolean(process.env.FIRESTORE_EMULATOR_HOST);
}

const clients = new Map<string, Firestore>();

async function searchDb(region: Region): Promise<Firestore> {
  const databaseId = searchDatabaseIdForRegion(region);
  const cached = clients.get(databaseId);
  if (cached) return cached;
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? (onEmulator() ? "demo-yougrow" : undefined);
  const { Firestore } = await import("@google-cloud/firestore");
  // Another call may have made this database's client while this one waited for the import.
  const made = clients.get(databaseId);
  if (made) return made;
  const db = new Firestore({ projectId, databaseId, ignoreUndefinedProperties: true });
  clients.set(databaseId, db);
  return db;
}

/**
 * pipeline() on the 9.x client. firebase-admin brings Firestore 7's type declarations, which
 * declare the same global names without pipeline(), and the type checker sees those first. At
 * runtime this client is 9.x (its own package), so only the type needs the nudge.
 */
function pipelineOf(db: Firestore): PipelineSource {
  return (db as unknown as { pipeline(): PipelineSource }).pipeline();
}

/**
 * A pipeline result's id. After the select() stage a result is a projection with no document
 * reference, so the id comes from what the chunk is: its record and its chunk number, which is
 * unique within a brand. (Without it every result had the id "" and a search kept only one.)
 */
export function resultId(ref: { id?: string } | undefined, id: string | undefined, data: Record<string, unknown> | undefined): string {
  if (ref?.id) return ref.id;
  if (id) return id;
  return data && typeof data.sourceKey === "string" ? `${data.sourceKey}#${typeof data.chunk === "number" ? data.chunk : 0}` : "";
}

function rankedFromResult(r: PipelineResult, tenantId: string): RankedChunk | null {
  const data = r.data();
  const id = resultId(r.ref, r.id, data);
  return id ? rankedFrom(id, data, tenantId) : null;
}

/**
 * A stored chunk as a result, or null when it isn't this brand's or its kind is unknown. A kind
 * stored under an alias (SEARCH_KIND_ALIASES) reads as today's kind; the stored sourceKey stays.
 */
export function rankedFrom(id: string, data: Record<string, unknown> | undefined, tenantId: string): RankedChunk | null {
  const kind = data ? readSearchKind(data.kind) : null;
  if (!data || data.tenantId !== tenantId || !kind) return null;
  return {
    id,
    sourceKey: String(data.sourceKey ?? ""),
    kind,
    ref: String(data.ref ?? ""),
    chunk: typeof data.chunk === "number" ? data.chunk : 0,
    title: String(data.title ?? ""),
    text: String(data.text ?? ""),
    url: String(data.url ?? ""),
    ...(isSearchStatus(data.status) ? { status: data.status } : {}),
  };
}

/** A stored chunk as a reader's nearest hit, or null when it isn't this brand's or isn't one of these statuses. */
export function nearestFrom(data: Record<string, unknown> | undefined, tenantId: string, statuses: readonly SearchStatus[], scoreField = SCORE_FIELD): NearestHit | null {
  const kind = data ? readSearchKind(data.kind) : null;
  if (!data || data.tenantId !== tenantId || !kind || typeof data.ref !== "string" || typeof data.sourceKey !== "string") return null;
  if (!isSearchStatus(data.status) || !statuses.includes(data.status)) return null;
  const raw = typeof data[scoreField] === "number" ? (data[scoreField] as number) : 0;
  return { sourceKey: data.sourceKey, kind, ref: data.ref, status: data.status, score: Math.max(0, Math.min(1, raw)) };
}

/** Each record once, by its best chunk, nearest first, at most `limit`. */
export function bestPerRecord(hits: Array<NearestHit | null>, limit: number): NearestHit[] {
  const best = new Map<string, NearestHit>();
  for (const h of hits) if (h && (best.get(h.sourceKey)?.score ?? -1) < h.score) best.set(h.sourceKey, h);
  return [...best.values()].sort((a, b) => b.score - a.score || a.sourceKey.localeCompare(b.sourceKey)).slice(0, limit);
}

/** A stored vector (a VectorValue, or a plain array on the fakes) as numbers, or null. */
function vectorFrom(value: unknown): number[] | null {
  if (Array.isArray(value)) return value.every((x) => typeof x === "number") ? (value as number[]) : null;
  const toArray = (value as { toArray?: () => unknown } | null)?.toArray;
  if (typeof toArray === "function") {
    const out = toArray.call(value);
    return Array.isArray(out) ? (out as number[]) : null;
  }
  return null;
}

/**
 * A stored manifest, or null. A kind stored under an alias reads as today's kind and keeps its
 * stored sourceKey, so the scheduled check sees a record that is gone and removes its chunks.
 */
export function manifestFrom(data: Record<string, unknown> | undefined): SearchManifest | null {
  const kind = data ? readSearchKind(data.kind) : null;
  if (!data || !kind || typeof data.sourceKey !== "string") return null;
  return {
    sourceKey: data.sourceKey,
    kind,
    ref: String(data.ref ?? ""),
    hash: String(data.hash ?? ""),
    chunks: typeof data.chunks === "number" ? data.chunks : 0,
    embedded: data.embedded === true,
    indexedAt: String(data.indexedAt ?? ""),
    ...(typeof data.version === "string" ? { version: data.version } : {}),
    ...(isSearchStatus(data.status) ? { status: data.status } : {}),
  };
}

/** The readers' nearest, with what Query Explain says of it when asked (scripts/search-nearest-check.ts). */
export interface NearestRun {
  hits: NearestHit[];
  /** Query Explain's text on Enterprise when asked; null on the emulator or when not asked. */
  explain: string | null;
}

/** The index for one brand, in its region's search database. */
export function searchStoreFor(ctx: Pick<TenantContext, "tenantId" | "region">): SearchStore {
  const tenantId = ctx.tenantId;
  const root = brandRoot(tenantId);
  const db = () => searchDb(ctx.region);
  const docs = async () => (await db()).collection(`${root}/${SEARCH_DOCS}`);
  const sources = async () => (await db()).collection(`${root}/${SEARCH_SOURCES}`);

  // Stored kinds include aliases (SEARCH_KIND_ALIASES), so a filter asks for both names.
  const kindFilter = (field: typeof Pipelines.field, kinds?: SearchKind[]) =>
    kinds && kinds.length ? field("kind").equalAny(storedKindsFor(kinds)) : null;
  // People's search: a chunk with no status, or one people may see.
  const peopleFilter = async (kinds?: SearchKind[]) => {
    const { and, field, or } = await import("@google-cloud/firestore/pipelines");
    const people = or(field("status").isAbsent(), field("status").equalAny([...PEOPLE_STATUSES]));
    const byKind = kindFilter(field, kinds);
    return byKind ? and(byKind, people) : people;
  };


  return {
    async getManifest(sourceKey) {
      const snap = await (await sources()).doc(searchManifestId(sourceKey)).get();
      const m = manifestFrom(snap.data());
      return m && m.sourceKey === sourceKey ? m : null;
    },

    async listManifests() {
      const out: SearchManifest[] = [];
      const col = await sources();
      let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
      // Page by document id: Enterprise doesn't add a tiebreaker to the sort, so sort by the id itself.
      for (;;) {
        let q = col.orderBy("__name__").limit(500);
        if (last) q = q.startAfter(last);
        const snap = await q.get();
        for (const d of snap.docs) {
          const m = manifestFrom(d.data());
          if (m) out.push(m);
        }
        if (snap.size < 500) break;
        last = snap.docs[snap.docs.length - 1];
      }
      return out;
    },

    async putSource(manifest, chunks, previousChunks) {
      for (const c of chunks) if (c.tenantId !== tenantId || c.sourceKey !== manifest.sourceKey) throw new Error("search_index_wrong_source");
      const fs = await db();
      const { FieldValue } = await import("@google-cloud/firestore");
      const col = await docs();
      for (let i = 0; i < chunks.length; i += WRITE_BATCH) {
        const batch = fs.batch();
        for (const c of chunks.slice(i, i + WRITE_BATCH)) {
          const { embedding, ...rest } = c;
          batch.set(col.doc(searchChunkId(c.sourceKey, c.chunk)), {
            ...rest,
            ...(embedding ? { embedding: FieldValue.vector(embedding) } : {}),
          });
        }
        await batch.commit();
      }
      if (previousChunks > chunks.length) {
        const batch = fs.batch();
        for (let n = chunks.length; n < previousChunks; n++) batch.delete(col.doc(searchChunkId(manifest.sourceKey, n)));
        await batch.commit();
      }
      await (await sources()).doc(searchManifestId(manifest.sourceKey)).set({ ...manifest, tenantId });
    },

    async putManifest(manifest) {
      await (await sources()).doc(searchManifestId(manifest.sourceKey)).set({ ...manifest, tenantId });
    },

    async setStatus(sourceKey, status) {
      const fs = await db();
      const { FieldValue } = await import("@google-cloud/firestore");
      const ref = (await sources()).doc(searchManifestId(sourceKey));
      const m = manifestFrom((await ref.get()).data());
      if (!m || m.sourceKey !== sourceKey) return;
      const value = status ?? FieldValue.delete();
      const col = await docs();
      for (let i = 0; i < m.chunks; i += WRITE_BATCH) {
        const batch = fs.batch();
        for (let n = i; n < Math.min(m.chunks, i + WRITE_BATCH); n++) batch.set(col.doc(searchChunkId(sourceKey, n)), { status: value }, { merge: true });
        await batch.commit();
      }
      await ref.set({ status: value }, { merge: true });
    },

    async vectorOf(sourceKey) {
      const snap = await (await docs()).doc(searchChunkId(sourceKey, 0)).get();
      const data = snap.data();
      return data && data.tenantId === tenantId && data.sourceKey === sourceKey ? vectorFrom(data.embedding) : null;
    },

    async removeSource(sourceKey) {
      const fs = await db();
      const col = await docs();
      const ref = (await sources()).doc(searchManifestId(sourceKey));
      const m = manifestFrom((await ref.get()).data());
      const count = m?.sourceKey === sourceKey ? m.chunks : 0;
      for (let i = 0; i < count; i += WRITE_BATCH) {
        const batch = fs.batch();
        for (let n = i; n < Math.min(count, i + WRITE_BATCH); n++) batch.delete(col.doc(searchChunkId(sourceKey, n)));
        await batch.commit();
      }
      await ref.delete();
    },

    async words(query, opts) {
      const limit = Math.max(1, Math.min(opts.limit, 100));
      if (!query.trim()) return [];
      if (onEmulator()) {
        const snap = await (await docs()).select(...RESULT_FIELDS).limit(LOCAL_SCAN_LIMIT).get();
        const scored: Array<{ hit: RankedChunk; s: number }> = [];
        for (const d of snap.docs) {
          const hit = rankedFrom(d.id, d.data(), tenantId);
          if (!hit || !shownToPeople(hit.status) || (opts.kinds?.length && !opts.kinds.includes(hit.kind))) continue;
          const s = localWordsScore(query, hit);
          if (s > 0) scored.push({ hit, s });
        }
        return scored.sort((a, b) => b.s - a.s || a.hit.id.localeCompare(b.hit.id)).slice(0, limit).map((x) => x.hit);
      }
      const { documentMatches, score } = await import("@google-cloud/firestore/pipelines");
      // search() must be the first stage after the collection, so the filter comes right after it.
      const snap = await pipelineOf(await db())
        .collection(`${root}/${SEARCH_DOCS}`)
        .search({ query: documentMatches(query), sort: score().descending(), ...(opts.lang && opts.lang !== "en" ? { languageCode: opts.lang } : {}) })
        .where(await peopleFilter(opts.kinds))
        .limit(limit)
        .select(...RESULT_FIELDS)
        .execute();
      return snap.results.map((r) => rankedFromResult(r, tenantId)).filter((h): h is RankedChunk => h !== null);
    },

    async meaning(vector, opts) {
      const limit = Math.max(1, Math.min(opts.limit, 100));
      if (!vector.length) return [];
      if (onEmulator()) {
        // The emulator runs Standard edition (Enterprise mode breaks the app's paging), and
        // Standard refuses pipelines, so the classic vector query stands in.
        // An "in" filter takes up to 30 values: today's kinds and their aliases are fewer.
        // Statuses are filtered in code, so more are read than wanted.
        const col = await docs();
        const base = opts.kinds?.length ? col.where("kind", "in", storedKindsFor(opts.kinds).slice(0, 30)) : col;
        const snap = await base
          .findNearest({ vectorField: "embedding", queryVector: vector, limit: LOCAL_NEAREST_LIMIT, distanceMeasure: "DOT_PRODUCT" })
          .get();
        return snap.docs
          .map((d) => rankedFrom(d.id, d.data(), tenantId))
          .filter((h): h is RankedChunk => h !== null && shownToPeople(h.status))
          .slice(0, limit);
      }
      // Filter first: findNearest searches only the chunks people may find, of the kinds asked.
      const snap = await pipelineOf(await db())
        .collection(`${root}/${SEARCH_DOCS}`)
        .where(await peopleFilter(opts.kinds))
        .findNearest({ field: "embedding", vectorValue: vector, distanceMeasure: "dot_product", limit })
        .limit(limit)
        .select(...RESULT_FIELDS)
        .execute();
      return snap.results.map((r) => rankedFromResult(r, tenantId)).filter((h): h is RankedChunk => h !== null);
    },

    async nearest(kinds, vector, opts) {
      return (await runNearest(ctx, kinds, vector, opts, false)).hits;
    },

    async clear() {
      const before = await (await docs()).count().get();
      const fs = await db();
      await fs.recursiveDelete(fs.doc(root));
      return before.data().count;
    },
  };
}

/**
 * The readers' nearest: kinds and statuses filtered first, each record once by its best chunk,
 * with Query Explain's analysis when `explain` (Enterprise only).
 */
async function runNearest(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  kinds: SearchKind[],
  vector: number[],
  opts: { statuses: SearchStatus[]; limit: number },
  explain: boolean,
): Promise<NearestRun> {
  const limit = Math.max(1, Math.min(opts.limit, MAX_NEAREST_RECORDS));
  if (!vector.length || !kinds.length || !opts.statuses.length) return { hits: [], explain: null };
  const root = brandRoot(ctx.tenantId);
  const db = await searchDb(ctx.region);
  if (onEmulator()) {
    // The classic vector query, kinds filtered first and statuses in code over Firestore's most.
    const snap = await db
      .collection(`${root}/${SEARCH_DOCS}`)
      .where("kind", "in", storedKindsFor(kinds).slice(0, 30))
      .findNearest({ vectorField: "embedding", queryVector: vector, limit: LOCAL_NEAREST_LIMIT, distanceMeasure: "DOT_PRODUCT", distanceResultField: SCORE_FIELD })
      .get();
    return { hits: bestPerRecord(snap.docs.map((d) => nearestFrom(d.data(), ctx.tenantId, opts.statuses)), limit), explain: null };
  }
  const { and, field } = await import("@google-cloud/firestore/pipelines");
  const snap = await pipelineOf(db)
    .collection(`${root}/${SEARCH_DOCS}`)
    .where(and(field("kind").equalAny(storedKindsFor(kinds)), field("status").equalAny([...opts.statuses])))
    .findNearest({ field: "embedding", vectorValue: vector, distanceMeasure: "dot_product", limit: limit * CHUNKS_PER_RECORD, distanceField: SCORE_FIELD })
    .select(...NEAREST_FIELDS, SCORE_FIELD)
    .execute(explain ? { explainOptions: { mode: "analyze", outputFormat: "text" } } : undefined);
  return {
    hits: bestPerRecord(snap.results.map((r) => nearestFrom(r.data(), ctx.tenantId, opts.statuses)), limit),
    explain: explain ? (snap.explainStats?.text ?? null) : null,
  };
}

/**
 * The readers' nearest with Query Explain's analysis (scripts/search-nearest-check.ts only): the
 * same query nearest() runs, its read units in `explain`. Read only.
 */
export function explainNearest(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  kinds: SearchKind[],
  vector: number[],
  opts: { statuses: SearchStatus[]; limit: number },
): Promise<NearestRun> {
  return runNearest(ctx, kinds, vector, opts, true);
}
