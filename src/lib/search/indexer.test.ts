import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateIndex, indexSource, indexSources, removeFromIndex, storedKindOf, storedSourceKey } from "./indexer";
import { MemorySearchIndex } from "./memoryStore";
import type { SearchSource } from "./types";

// Tests pass their own store, except where one sets `defaultStore` to check the brand's own path.
const searchIndex = vi.hoisted(() => ({ defaultStore: null as null | ((ctx: { tenantId: string }) => unknown) }));
vi.mock("@/lib/tenant/searchIndex", () => ({
  searchStoreFor: (ctx: { tenantId: string }) => {
    if (!searchIndex.defaultStore) throw new Error("tests pass their own store");
    return searchIndex.defaultStore(ctx);
  },
}));

const ctxA = { tenantId: "ten_fernleaf", region: "us" as const };
const ctxB = { tenantId: "ten_other", region: "us" as const };

const article: SearchSource = {
  kind: "article",
  ref: "plan_1",
  title: "Repotting a fiddle leaf fig",
  body: "# Repotting\n\nUse the **FL-204** repotting kit in spring.",
  format: "markdown",
  url: "/admin/workspace/ws_1/create/plan_1",
};

function fakeEmbed() {
  const calls: string[][] = [];
  const embed = vi.fn(async (items: Array<{ content: string }>) => {
    calls.push(items.map((i) => i.content));
    return items.map((_, i) => {
      const v = [1, i + 1, 0];
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    });
  });
  return { embed, calls };
}

describe("indexSource", () => {
  beforeEach(() => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    vi.stubEnv("GRANTED_ONLY_FEATURES", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("does nothing while the switch is off", async () => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "false");
    const index = new MemorySearchIndex();
    const { embed } = fakeEmbed();
    expect(await indexSource(ctxA, article, { store: index.storeFor(ctxA), embed })).toBe("off");
    expect(embed).not.toHaveBeenCalled();
    expect(index.chunks.size).toBe(0);
  });

  it("does nothing for a brand that isn't granted search", async () => {
    const index = new MemorySearchIndex();
    const { embed } = fakeEmbed();
    expect(await indexSource(ctxA, article, { store: index.storeFor(ctxA), embed, granted: false })).toBe("not_granted");
    expect(embed).not.toHaveBeenCalled();
  });

  it("stores plain-text chunks with their vectors and model, findable by words and meaning", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctxA);
    const { embed } = fakeEmbed();
    expect(await indexSource(ctxA, article, { store, embed, granted: true })).toBe("indexed");
    const manifest = await store.getManifest("article:plan_1");
    expect(manifest).toMatchObject({ kind: "article", ref: "plan_1", chunks: 1, embedded: true });
    const chunk = [...(index.chunks.get("ten_fernleaf")?.values() ?? [])][0]!;
    expect(chunk.text).toBe("Repotting\n\nUse the FL-204 repotting kit in spring.");
    expect(chunk.embeddingModel).toBe("gemini-embedding-001@768");
    expect(chunk.tenantId).toBe("ten_fernleaf");
    expect((await store.words("fl204", { limit: 5 })).map((h) => h.ref)).toEqual(["plan_1"]);
    expect((await store.meaning([1, 1, 0].map((x) => x / Math.SQRT2), { limit: 5 })).map((h) => h.ref)).toEqual(["plan_1"]);
  });

  it("doesn't embed again when nothing changed, and does when the text did", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctxA);
    const { embed } = fakeEmbed();
    await indexSource(ctxA, article, { store, embed, granted: true });
    expect(await indexSource(ctxA, article, { store, embed, granted: true })).toBe("unchanged");
    expect(embed).toHaveBeenCalledTimes(1);
    expect(await indexSource(ctxA, { ...article, body: "New text about citrus." }, { store, embed, granted: true })).toBe("indexed");
    expect(embed).toHaveBeenCalledTimes(2);
    expect((await store.words("citrus", { limit: 5 })).length).toBe(1);
    expect((await store.words("repotting kit spring", { limit: 5 })).length).toBe(0);
  });

  it("drops chunks past the new count when a record gets shorter", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctxA);
    const { embed } = fakeEmbed();
    const long = Array.from({ length: 6 }, (_, i) => `Section ${i}. ` + "plant care ".repeat(60)).join("\n\n");
    await indexSource(ctxA, { ...article, body: long, format: "plain" }, { store, embed, granted: true });
    const before = (await store.getManifest("article:plan_1"))?.chunks ?? 0;
    expect(before).toBeGreaterThan(2);
    await indexSource(ctxA, { ...article, body: "Short now.", format: "plain" }, { store, embed, granted: true });
    expect(index.chunks.get("ten_fernleaf")?.size).toBe(1);
  });

  it("keeps the text without vectors when embedding fails, and tries again next time", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctxA);
    const failing = vi.fn(async (items: unknown[]) => items.map(() => null));
    expect(await indexSource(ctxA, article, { store, embed: failing, granted: true })).toBe("indexed_without_vectors");
    expect((await store.words("repotting", { limit: 5 })).length).toBe(1);
    const { embed } = fakeEmbed();
    expect(await indexSource(ctxA, article, { store, embed, granted: true })).toBe("indexed");
  });

  it("removes a record whose text is now empty, and on delete", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctxA);
    const { embed } = fakeEmbed();
    await indexSource(ctxA, article, { store, embed, granted: true });
    expect(await indexSource(ctxA, { ...article, title: "", body: "" }, { store, embed, granted: true })).toBe("removed");
    expect(index.chunks.get("ten_fernleaf")?.size).toBe(0);
    await indexSource(ctxA, article, { store, embed, granted: true });
    expect(await removeFromIndex(ctxA, "article", "plan_1", { store })).toBe("removed");
    expect(await store.getManifest("article:plan_1")).toBeNull();
  });

  it("never lets one brand see or change another's index", async () => {
    const index = new MemorySearchIndex();
    const { embed } = fakeEmbed();
    await indexSource(ctxA, article, { store: index.storeFor(ctxA), embed, granted: true });
    const storeB = index.storeFor(ctxB);
    expect(await storeB.words("repotting", { limit: 5 })).toEqual([]);
    expect(await storeB.meaning([1, 0, 0], { limit: 5 })).toEqual([]);
    expect(await storeB.getManifest("article:plan_1")).toBeNull();
    await removeFromIndex(ctxB, "article", "plan_1", { store: storeB });
    expect(await index.storeFor(ctxA).getManifest("article:plan_1")).not.toBeNull();
  });

  it("returns failed, not an error, when the store breaks", async () => {
    const index = new MemorySearchIndex();
    const store = { ...index.storeFor(ctxA), putSource: vi.fn(async () => Promise.reject(new Error("boom"))) };
    const { embed } = fakeEmbed();
    expect(await indexSource(ctxA, article, { store, embed, granted: true })).toBe("failed");
  });
});

describe("the name an Idea Board item is written under", () => {
  const clipping: SearchSource = { kind: "idea_board", ref: "i1", title: "Repot in spring", body: "Saved from a gardening forum." };
  const stored = (index: MemorySearchIndex) => ({
    manifests: [...(index.manifests.get("ten_fernleaf")?.values() ?? [])].map((m) => `${m.kind} ${m.sourceKey}`),
    chunks: [...(index.chunks.get("ten_fernleaf")?.values() ?? [])].map((c) => `${c.kind} ${c.sourceKey}`),
  });

  beforeEach(() => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    vi.stubEnv("GRANTED_ONLY_FEATURES", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is idea while the switch is off, and idea_board once it is on; other kinds keep their name", () => {
    expect(storedKindOf("idea_board")).toBe("idea");
    expect(storedSourceKey("idea_board", "i1")).toBe("idea:i1");
    vi.stubEnv("SEARCH_KIND_IDEA_BOARD_ENABLED", "true");
    expect(storedKindOf("idea_board")).toBe("idea_board");
    expect(storedSourceKey("idea_board", "i1")).toBe("idea_board:i1");
    for (const kind of ["article", "template", "image"] as const) expect(storedKindOf(kind)).toBe(kind);
  });

  it("writes the chunks and manifest as idea with the switch off, read back as idea_board", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctxA);
    const { embed } = fakeEmbed();
    expect(await indexSource(ctxA, clipping, { store, embed, granted: true })).toBe("indexed");
    expect(stored(index)).toEqual({ manifests: ["idea idea:i1"], chunks: ["idea idea:i1"] });
    expect(await store.getManifest("idea:i1")).toMatchObject({ kind: "idea_board", ref: "i1" });
    expect((await store.words("repot", { limit: 5, kinds: ["idea_board"] })).map((h) => h.kind)).toEqual(["idea_board"]);
    // A version that moves with the text unchanged keeps the stored name.
    expect(await indexSource(ctxA, clipping, { store, embed, granted: true, version: "v2" })).toBe("unchanged");
    expect(stored(index).manifests).toEqual(["idea idea:i1"]);
  });

  it("writes them as idea_board with the switch on", async () => {
    vi.stubEnv("SEARCH_KIND_IDEA_BOARD_ENABLED", "true");
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctxA);
    const { embed } = fakeEmbed();
    expect(await indexSource(ctxA, clipping, { store, embed, granted: true })).toBe("indexed");
    expect(stored(index)).toEqual({ manifests: ["idea_board idea_board:i1"], chunks: ["idea_board idea_board:i1"] });
  });

  it("removes an item under both names, whichever the switch says", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctxA);
    const { embed } = fakeEmbed();
    await indexSource(ctxA, clipping, { store, embed, granted: true });
    vi.stubEnv("SEARCH_KIND_IDEA_BOARD_ENABLED", "true");
    await indexSource(ctxA, clipping, { store, embed, granted: true });
    expect(stored(index).manifests).toEqual(["idea idea:i1", "idea_board idea_board:i1"]);
    expect(await removeFromIndex(ctxA, "idea_board", "i1", { store })).toBe("removed");
    expect(stored(index)).toEqual({ manifests: [], chunks: [] });
  });
});

describe("removeFromIndex with indexing off", () => {
  // Erasing a connection's searches (ADR-0013): Google searches for a made-up site.
  const searches: SearchSource = { kind: "research", ref: "gsc:dcn_aaaaaaaaaaaaaaaaaaaa", title: "Google searches: example.com", body: "", parts: [{ text: "repot a fig: 120 impressions, 4 clicks, position 8.2" }] };

  beforeEach(() => vi.stubEnv("SEARCH_INDEX_ENABLED", "true"));
  afterEach(() => {
    vi.unstubAllEnvs();
    searchIndex.defaultStore = null;
  });

  async function indexedForBoth() {
    const index = new MemorySearchIndex();
    const { embed } = fakeEmbed();
    await indexSource(ctxA, searches, { store: index.storeFor(ctxA), embed, granted: true });
    await indexSource(ctxB, searches, { store: index.storeFor(ctxB), embed, granted: true });
    return index;
  }
  const keys = (index: MemorySearchIndex, tenantId: string) => [...(index.manifests.get(tenantId)?.keys() ?? [])];

  it("leaves it alone unless forced, then removes it from this brand only, through the brand's own store", async () => {
    const index = await indexedForBoth();
    vi.stubEnv("SEARCH_INDEX_ENABLED", "false");
    searchIndex.defaultStore = (ctx) => index.storeFor(ctx);
    expect(await removeFromIndex(ctxA, "research", searches.ref)).toBe("off");
    expect(keys(index, ctxA.tenantId)).toEqual(["research:gsc:dcn_aaaaaaaaaaaaaaaaaaaa"]);
    expect(await removeFromIndex(ctxA, "research", searches.ref, { force: true })).toBe("removed");
    expect(keys(index, ctxA.tenantId)).toEqual([]);
    expect(index.chunks.get(ctxA.tenantId)?.size ?? 0).toBe(0);
    // Another brand's record under the same ref is never touched.
    expect(keys(index, ctxB.tenantId)).toEqual(["research:gsc:dcn_aaaaaaaaaaaaaaaaaaaa"]);
    // Removing again finds nothing, and says so the same way.
    expect(await removeFromIndex(ctxA, "research", searches.ref, { force: true })).toBe("removed");
  });

  it("counts a copy without the search databases as nothing to remove, and any other failure as failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = (err: unknown) => ({ ...new MemorySearchIndex().storeFor(ctxA), removeSource: async () => Promise.reject(err) });
    const missing = Object.assign(new Error("5 NOT_FOUND: The database (search) does not exist for project made-up-project"), { code: 5 });
    expect(await removeFromIndex(ctxA, "research", searches.ref, { force: true, store: broken(missing) })).toBe("removed");
    expect(await removeFromIndex(ctxA, "research", searches.ref, { force: true, store: broken(Object.assign(new Error("unavailable"), { code: 14 })) })).toBe("failed");
    warn.mockRestore();
  });
});

describe("the brand map family and statuses (ADR-0023)", () => {
  beforeEach(() => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    vi.stubEnv("SEARCH_FAMILY_INDEX_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  const subject: SearchSource = { kind: "subject", ref: "sub_1", title: "Repotting figs", body: "Repotting figs\n\nWhen do I repot a fig?", url: "/admin/brand-kit/map", status: "proposed" };

  it("indexes the family for a brand without brand search, and nothing else of it", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctxA);
    const { embed } = fakeEmbed();
    expect(await indexSource(ctxA, subject, { store, embed, granted: false })).toBe("indexed");
    expect(await indexSource(ctxA, { kind: "competitor", ref: "cmp_1/art_1", title: "T", body: "B", status: "kept" }, { store, embed, granted: false })).toBe("indexed");
    expect(await indexSource(ctxA, { kind: "question", ref: "note_bn_1", title: "Q?", body: "Q?", status: "asked" }, { store, embed, granted: false })).toBe("indexed");
    // The brand map's own questions, competitors' summaries and every other kind still need brand search.
    expect(await indexSource(ctxA, { kind: "question", ref: "q_1", title: "Q?", body: "Q?" }, { store, embed, granted: false })).toBe("not_granted");
    expect(await indexSource(ctxA, { kind: "competitor", ref: "cmp_1", title: "Them", body: "A shop." }, { store, embed, granted: false })).toBe("not_granted");
    expect(await indexSource(ctxA, article, { store, embed, granted: false })).toBe("not_granted");
    // Off, the family needs brand search like the rest.
    vi.stubEnv("SEARCH_FAMILY_INDEX_ENABLED", "false");
    expect(await indexSource(ctxA, { ...subject, ref: "sub_2" }, { store, embed, granted: false })).toBe("not_granted");
  });

  it("keeps the status on every chunk and the manifest, and a status change embeds nothing", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctxA);
    const { embed } = fakeEmbed();
    await indexSource(ctxA, subject, { store, embed, granted: true });
    expect((await store.getManifest("subject:sub_1"))?.status).toBe("proposed");
    expect(await indexSource(ctxA, { ...subject, status: "decided" }, { store, embed, granted: true, version: "v2" })).toBe("unchanged");
    expect(embed).toHaveBeenCalledTimes(1);
    expect(await store.getManifest("subject:sub_1")).toMatchObject({ status: "decided", version: "v2" });
    expect([...index.chunks.get(ctxA.tenantId)!.values()].map((c) => c.status)).toEqual(["decided"]);
    expect((await store.nearest(["subject"], [1, 1, 0].map((x) => x / Math.SQRT2), { statuses: ["decided"], limit: 5 })).map((h) => h.ref)).toEqual(["sub_1"]);
    // A record indexed before statuses gets one with no embedding.
    await indexSource(ctxA, { ...subject, ref: "sub_3", status: undefined }, { store, embed, granted: true });
    expect(await indexSource(ctxA, { ...subject, ref: "sub_3", status: "decided" }, { store, embed, granted: true })).toBe("unchanged");
    expect(embed).toHaveBeenCalledTimes(2);
    expect((await store.getManifest("subject:sub_3"))?.status).toBe("decided");
  });

  it("embeds many records in one call and gives back each one's vector, read back when unchanged", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctxA);
    const { embed, calls } = fakeEmbed();
    const two = [subject, { ...subject, ref: "sub_2", title: "Fig leaves", body: "Why do fig leaves drop?" }];
    const first = await indexSources(ctxA, two, { store, embed });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    expect(first.map((r) => r.outcome)).toEqual(["indexed", "indexed"]);
    expect(first[0]!.vector).not.toEqual(first[1]!.vector);
    const again = await indexSources(ctxA, two, { store, embed });
    expect(calls).toHaveLength(1);
    expect(again.map((r) => r.outcome)).toEqual(["unchanged", "unchanged"]);
    expect(again.map((r) => r.vector)).toEqual(first.map((r) => r.vector));
  });

  it("says what --apply would do on a dry run: embed, rewrite the status only, or nothing", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctxA);
    const { embed } = fakeEmbed();
    expect(estimateIndex(subject, null)).toMatchObject({ action: "embed", chunks: 1 });
    expect(estimateIndex(subject, null).chars).toBe(subject.body.length + subject.title.length);
    await indexSource(ctxA, subject, { store, embed, granted: true });
    const m = await store.getManifest("subject:sub_1");
    expect(estimateIndex(subject, m).action).toBe("none");
    expect(estimateIndex({ ...subject, status: "decided" }, m).action).toBe("status");
    expect(estimateIndex({ ...subject, body: "", title: "" }, m).action).toBe("remove");
  });
});

