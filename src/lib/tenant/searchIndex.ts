import { createHash } from "node:crypto";
import { FieldValue, Firestore } from "@google-cloud/firestore";
import { documentMatches, field, score } from "@google-cloud/firestore/pipelines";
import type { PipelineResult, PipelineSource } from "@google-cloud/firestore/pipelines";
import type { Region } from "@/lib/types/tenant";
import { localWordsScore } from "@/lib/search/text";
import type { RankedChunk, SearchKind, SearchManifest, SearchStore } from "@/lib/search/types";
import { isSearchKind } from "@/lib/search/types";
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
 */

export const SEARCH_DOCS = "search_docs" as const;
export const SEARCH_SOURCES = "search_sources" as const;
/** Fields a search returns (never the embedding: it is most of each doc's size). */
const RESULT_FIELDS = ["tenantId", "sourceKey", "kind", "ref", "chunk", "title", "text", "url"] as const;
/** The most docs the emulator's stand-in text search reads for one brand. */
const LOCAL_SCAN_LIMIT = 2000;
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

function searchDb(region: Region): Firestore {
  const databaseId = searchDatabaseIdForRegion(region);
  const cached = clients.get(databaseId);
  if (cached) return cached;
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? (onEmulator() ? "demo-yougrow" : undefined);
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

function rankedFromResult(r: PipelineResult, tenantId: string): RankedChunk | null {
  return rankedFrom(r.ref?.id ?? r.id ?? "", r.data(), tenantId);
}

function rankedFrom(id: string, data: Record<string, unknown> | undefined, tenantId: string): RankedChunk | null {
  if (!data || data.tenantId !== tenantId || !isSearchKind(data.kind)) return null;
  return {
    id,
    sourceKey: String(data.sourceKey ?? ""),
    kind: data.kind,
    ref: String(data.ref ?? ""),
    chunk: typeof data.chunk === "number" ? data.chunk : 0,
    title: String(data.title ?? ""),
    text: String(data.text ?? ""),
    url: String(data.url ?? ""),
  };
}

function manifestFrom(data: Record<string, unknown> | undefined): SearchManifest | null {
  if (!data || !isSearchKind(data.kind) || typeof data.sourceKey !== "string") return null;
  return {
    sourceKey: data.sourceKey,
    kind: data.kind,
    ref: String(data.ref ?? ""),
    hash: String(data.hash ?? ""),
    chunks: typeof data.chunks === "number" ? data.chunks : 0,
    embedded: data.embedded === true,
    indexedAt: String(data.indexedAt ?? ""),
  };
}

/** The index for one brand, in its region's search database. */
export function searchStoreFor(ctx: Pick<TenantContext, "tenantId" | "region">): SearchStore {
  const tenantId = ctx.tenantId;
  const root = brandRoot(tenantId);
  const db = () => searchDb(ctx.region);
  const docs = () => db().collection(`${root}/${SEARCH_DOCS}`);
  const sources = () => db().collection(`${root}/${SEARCH_SOURCES}`);

  const kindFilter = (kinds?: SearchKind[]) => (kinds && kinds.length ? field("kind").equalAny(kinds) : null);

  return {
    async getManifest(sourceKey) {
      const snap = await sources().doc(searchManifestId(sourceKey)).get();
      const m = manifestFrom(snap.data());
      return m && m.sourceKey === sourceKey ? m : null;
    },

    async listManifests() {
      const out: SearchManifest[] = [];
      let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
      // Page by document id: Enterprise doesn't add a tiebreaker to the sort, so sort by the id itself.
      for (;;) {
        let q = sources().orderBy("__name__").limit(500);
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
      for (let i = 0; i < chunks.length; i += WRITE_BATCH) {
        const batch = db().batch();
        for (const c of chunks.slice(i, i + WRITE_BATCH)) {
          const { embedding, ...rest } = c;
          batch.set(docs().doc(searchChunkId(c.sourceKey, c.chunk)), {
            ...rest,
            ...(embedding ? { embedding: FieldValue.vector(embedding) } : {}),
          });
        }
        await batch.commit();
      }
      if (previousChunks > chunks.length) {
        const batch = db().batch();
        for (let n = chunks.length; n < previousChunks; n++) batch.delete(docs().doc(searchChunkId(manifest.sourceKey, n)));
        await batch.commit();
      }
      await sources().doc(searchManifestId(manifest.sourceKey)).set({ ...manifest, tenantId });
    },

    async removeSource(sourceKey) {
      const ref = sources().doc(searchManifestId(sourceKey));
      const m = manifestFrom((await ref.get()).data());
      const count = m?.sourceKey === sourceKey ? m.chunks : 0;
      for (let i = 0; i < count; i += WRITE_BATCH) {
        const batch = db().batch();
        for (let n = i; n < Math.min(count, i + WRITE_BATCH); n++) batch.delete(docs().doc(searchChunkId(sourceKey, n)));
        await batch.commit();
      }
      await ref.delete();
    },

    async words(query, opts) {
      const limit = Math.max(1, Math.min(opts.limit, 100));
      if (!query.trim()) return [];
      if (onEmulator()) {
        const snap = await docs().select(...RESULT_FIELDS).limit(LOCAL_SCAN_LIMIT).get();
        const scored: Array<{ hit: RankedChunk; s: number }> = [];
        for (const d of snap.docs) {
          const hit = rankedFrom(d.id, d.data(), tenantId);
          if (!hit || (opts.kinds?.length && !opts.kinds.includes(hit.kind))) continue;
          const s = localWordsScore(query, hit);
          if (s > 0) scored.push({ hit, s });
        }
        return scored.sort((a, b) => b.s - a.s || a.hit.id.localeCompare(b.hit.id)).slice(0, limit).map((x) => x.hit);
      }
      let p = pipelineOf(db())
        .collection(`${root}/${SEARCH_DOCS}`)
        .search({ query: documentMatches(query), sort: score().descending(), ...(opts.lang && opts.lang !== "en" ? { languageCode: opts.lang } : {}) });
      const kinds = kindFilter(opts.kinds);
      if (kinds) p = p.where(kinds);
      const snap = await p.limit(limit).select(...RESULT_FIELDS).execute();
      return snap.results.map((r) => rankedFromResult(r, tenantId)).filter((h): h is RankedChunk => h !== null);
    },

    async meaning(vector, opts) {
      const limit = Math.max(1, Math.min(opts.limit, 100));
      if (!vector.length) return [];
      if (onEmulator()) {
        // The emulator runs Standard edition (Enterprise mode breaks the app's paging), and
        // Standard refuses pipelines, so the classic vector query stands in.
        const base = opts.kinds?.length ? docs().where("kind", "in", opts.kinds.slice(0, 30)) : docs();
        const snap = await base
          .findNearest({ vectorField: "embedding", queryVector: vector, limit, distanceMeasure: "DOT_PRODUCT" })
          .get();
        return snap.docs.map((d) => rankedFrom(d.id, d.data(), tenantId)).filter((h): h is RankedChunk => h !== null);
      }
      const kinds = kindFilter(opts.kinds);
      let p = pipelineOf(db())
        .collection(`${root}/${SEARCH_DOCS}`)
        .findNearest({ field: "embedding", vectorValue: vector, distanceMeasure: "dot_product", limit: kinds ? Math.min(limit * 3, 300) : limit });
      if (kinds) p = p.where(kinds);
      const snap = await p.limit(limit).select(...RESULT_FIELDS).execute();
      return snap.results.map((r) => rankedFromResult(r, tenantId)).filter((h): h is RankedChunk => h !== null);
    },

    async clear() {
      const before = await docs().count().get();
      await db().recursiveDelete(db().doc(root));
      return before.data().count;
    },
  };
}
