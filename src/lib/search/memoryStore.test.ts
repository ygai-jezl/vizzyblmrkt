import { describe, expect, it } from "vitest";
import { MemorySearchIndex } from "./memoryStore";
import { randomUnitVector, seededRandom } from "./nearestCheck";
import type { SearchChunkDoc, SearchKind, SearchStatus, SearchStore } from "./types";

// The in-memory index keeps to the same rules as the real one (src/lib/tenant/searchIndex.ts):
// statuses filtered before the nearest are taken, each record once, people's search hiding proposals.

const ctx = { tenantId: "ten_fernleaf" };
const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

async function put(store: SearchStore, kind: SearchKind, ref: string, vectors: number[][], status?: SearchStatus, text = `${kind} ${ref}`, tenantId = ctx.tenantId) {
  const sourceKey = `${kind}:${ref}`;
  const chunks: SearchChunkDoc[] = vectors.map((embedding, chunk) => ({
    tenantId,
    kind,
    ref,
    sourceKey,
    chunk,
    title: text,
    text,
    url: "",
    lang: "en",
    updatedAt: "2026-11-26T10:00:00.000Z",
    ...(status ? { status } : {}),
    embedding,
  }));
  await store.putSource({ sourceKey, kind, ref, hash: "h", chunks: chunks.length, embedded: true, indexedAt: "2026-11-26T10:00:00.000Z", ...(status ? { status } : {}) }, chunks, 0);
}

describe("nearest, for the readers that match by meaning", () => {
  it("filters kinds and statuses before its limit: a decided subject is found among 5,000 other chunks", async () => {
    const rand = seededRandom(7);
    const store = new MemorySearchIndex().storeFor(ctx);
    const subject = randomUnitVector(32, rand);
    await put(store, "subject", "sub_onmap", [subject], "decided");
    await put(store, "article", "plan_1", Array.from({ length: 2_500 }, () => randomUnitVector(32, rand)));
    await put(store, "subject", "sub_proposals", Array.from({ length: 2_500 }, () => randomUnitVector(32, rand)), "proposed");
    // An article chunk right on top of the subject: still not a subject.
    await put(store, "article", "plan_2", [subject]);

    const hits = await store.nearest(["subject"], subject, { statuses: ["decided"], limit: 1 });
    expect(hits.map((h) => h.ref)).toEqual(["sub_onmap"]);
    expect(hits[0]).toMatchObject({ kind: "subject", status: "decided" });
    expect(hits[0]!.score).toBeCloseTo(1);
  });

  it("gives each record once, by its best chunk, nearest first, with the score clamped to 0 to 1", async () => {
    const store = new MemorySearchIndex().storeFor(ctx);
    await put(store, "competitor", "cmp_a/art_1", [unit([1, 0, 0]), unit([0.6, 0.8, 0])], "kept");
    await put(store, "competitor", "cmp_a/art_2", [unit([0, 1, 0])], "kept");
    await put(store, "competitor", "cmp_a/art_3", [unit([-1, 0, 0])], "kept");
    const hits = await store.nearest(["competitor"], [2, 0, 0], { statuses: ["kept"], limit: 5 });
    expect(hits.map((h) => h.ref)).toEqual(["cmp_a/art_1", "cmp_a/art_2", "cmp_a/art_3"]);
    expect(hits.map((h) => h.score)).toEqual([1, 0, 0]);
  });

  it("never matches a chunk with no status, and only the statuses asked for", async () => {
    const store = new MemorySearchIndex().storeFor(ctx);
    // A competitor's summary has no status; an answered question isn't an open one.
    await put(store, "competitor", "cmp_a", [unit([1, 0])]);
    await put(store, "question", "note_bn_1", [unit([1, 0])], "answered");
    await put(store, "question", "note_bn_2", [unit([1, 0.1])], "asked");
    expect(await store.nearest(["competitor"], unit([1, 0]), { statuses: ["kept"], limit: 5 })).toEqual([]);
    expect((await store.nearest(["question"], unit([1, 0]), { statuses: ["asked"], limit: 5 })).map((h) => h.ref)).toEqual(["note_bn_2"]);
    expect((await store.nearest(["question"], unit([1, 0]), { statuses: ["asked", "answered"], limit: 5 })).map((h) => h.ref)).toEqual(["note_bn_1", "note_bn_2"]);
  });

  it("keeps each brand to its own records", async () => {
    const index = new MemorySearchIndex();
    await put(index.storeFor({ tenantId: "ten_other" }), "subject", "sub_x", [unit([1, 0])], "decided", "Repot", "ten_other");
    expect(await index.storeFor(ctx).nearest(["subject"], unit([1, 0]), { statuses: ["decided"], limit: 5 })).toEqual([]);
  });
});

describe("people's search", () => {
  it("keeps chunks with no status and those people may see, and hides proposals and answered questions", async () => {
    const store = new MemorySearchIndex().storeFor(ctx);
    await put(store, "article", "plan_1", [unit([1, 0])], undefined, "repot your fig");
    await put(store, "subject", "sub_onmap", [unit([1, 0.1])], "decided", "repot figs");
    await put(store, "subject", "sub_proposed", [unit([1, 0.05])], "proposed", "repot fig trees");
    await put(store, "question", "note_bn_1", [unit([1, 0.2])], "answered", "how do you repot a fig");
    await put(store, "question", "note_bn_2", [unit([1, 0.3])], "asked", "when do you repot a fig");
    await put(store, "note", "bn_3", [unit([1, 0.4])], "kept", "we repot figs in spring");
    const shown = ["plan_1", "sub_onmap", "note_bn_2", "bn_3"].sort();
    expect((await store.meaning(unit([1, 0]), { limit: 10 })).map((c) => c.ref).sort()).toEqual(shown);
    expect((await store.words("repot", { limit: 10 })).map((c) => c.ref).sort()).toEqual(shown);
    expect((await store.meaning(unit([1, 0]), { limit: 10 })).find((c) => c.ref === "sub_onmap")?.status).toBe("decided");
  });
});

describe("setStatus and vectorOf", () => {
  it("rewrites the status on every chunk and the manifest, keeps the vectors, and can take it off", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctx);
    await put(store, "subject", "sub_1", [unit([1, 0]), unit([0, 1])], "proposed");
    await store.setStatus("subject:sub_1", "decided");
    const chunks = [...index.chunks.get(ctx.tenantId)!.values()];
    expect(chunks.map((c) => c.status)).toEqual(["decided", "decided"]);
    expect(chunks.map((c) => c.embedding)).toEqual([unit([1, 0]), unit([0, 1])]);
    expect((await store.getManifest("subject:sub_1"))?.status).toBe("decided");
    expect(await store.vectorOf("subject:sub_1")).toEqual(unit([1, 0]));

    await store.setStatus("subject:sub_1", null);
    expect([...index.chunks.get(ctx.tenantId)!.values()].every((c) => !("status" in c))).toBe(true);
    expect(await store.getManifest("subject:sub_1")).not.toHaveProperty("status");
    // A record that isn't there: nothing happens.
    await store.setStatus("subject:sub_none", "decided");
    expect(await store.vectorOf("subject:sub_none")).toBeNull();
  });
});
