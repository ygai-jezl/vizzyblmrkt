import { localWordsScore } from "./text";
import type { RankedChunk, SearchChunkDoc, SearchManifest, SearchStore } from "./types";

/**
 * An in-memory search index for tests (the fake Firestore has no pipelines). One shared map of
 * brands, so a test can check that one brand's store never sees another's. Text search uses the
 * same stand-in the emulator does; search by meaning is a dot product over unit vectors.
 */
export class MemorySearchIndex {
  readonly chunks = new Map<string, Map<string, SearchChunkDoc>>();
  readonly manifests = new Map<string, Map<string, SearchManifest>>();

  private brandChunks(tenantId: string) {
    let m = this.chunks.get(tenantId);
    if (!m) this.chunks.set(tenantId, (m = new Map()));
    return m;
  }

  private brandManifests(tenantId: string) {
    let m = this.manifests.get(tenantId);
    if (!m) this.manifests.set(tenantId, (m = new Map()));
    return m;
  }

  storeFor(ctx: { tenantId: string }): SearchStore {
    const tenantId = ctx.tenantId;
    const chunks = () => this.brandChunks(tenantId);
    const manifests = () => this.brandManifests(tenantId);
    const key = (sourceKey: string, n: number) => `${sourceKey}#${n}`;
    const ranked = (id: string, c: SearchChunkDoc): RankedChunk => ({
      id,
      sourceKey: c.sourceKey,
      kind: c.kind,
      ref: c.ref,
      chunk: c.chunk,
      title: c.title,
      text: c.text,
      url: c.url,
    });

    return {
      async getManifest(sourceKey) {
        return manifests().get(sourceKey) ?? null;
      },
      async listManifests() {
        return [...manifests().values()];
      },
      async putSource(manifest, list, previousChunks) {
        for (const c of list) if (c.tenantId !== tenantId || c.sourceKey !== manifest.sourceKey) throw new Error("search_index_wrong_source");
        for (const c of list) chunks().set(key(c.sourceKey, c.chunk), { ...c });
        for (let n = list.length; n < previousChunks; n++) chunks().delete(key(manifest.sourceKey, n));
        manifests().set(manifest.sourceKey, { ...manifest });
      },
      async removeSource(sourceKey) {
        const m = manifests().get(sourceKey);
        for (let n = 0; n < (m?.chunks ?? 0); n++) chunks().delete(key(sourceKey, n));
        manifests().delete(sourceKey);
      },
      async words(query, opts) {
        return [...chunks().entries()]
          .filter(([, c]) => !opts.kinds?.length || opts.kinds.includes(c.kind))
          .map(([id, c]) => ({ id, c, s: localWordsScore(query, c) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s || a.id.localeCompare(b.id))
          .slice(0, opts.limit)
          .map((x) => ranked(x.id, x.c));
      },
      async meaning(vector, opts) {
        return [...chunks().entries()]
          .filter(([, c]) => c.embedding && (!opts.kinds?.length || opts.kinds.includes(c.kind)))
          .map(([id, c]) => ({ id, c, d: (c.embedding ?? []).reduce((sum, v, i) => sum + v * (vector[i] ?? 0), 0) }))
          .sort((a, b) => b.d - a.d || a.id.localeCompare(b.id))
          .slice(0, opts.limit)
          .map((x) => ranked(x.id, x.c));
      },
      async clear() {
        const n = chunks().size;
        chunks().clear();
        manifests().clear();
        return n;
      },
    };
  }
}
