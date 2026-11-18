import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexSource, removeFromIndex } from "./indexer";
import { MemorySearchIndex } from "./memoryStore";
import type { SearchSource } from "./types";

vi.mock("@/lib/tenant/searchIndex", () => ({
  searchStoreFor: () => {
    throw new Error("tests pass their own store");
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
