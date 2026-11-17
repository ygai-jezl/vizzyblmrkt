import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySearchIndex } from "./memoryStore";
import { searchBrand, snippetFor } from "./query";
import { rerank } from "./rerank";
import type { SearchChunkDoc } from "./types";

vi.mock("@/lib/tenant/searchIndex", () => ({
  searchStoreFor: () => {
    throw new Error("tests pass their own store");
  },
}));

const ctx = { tenantId: "ten_fernleaf", region: "us" as const };
const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const chunk = (ref: string, kind: SearchChunkDoc["kind"], title: string, text: string, v: number[], n = 0): SearchChunkDoc => ({
  tenantId: ctx.tenantId,
  kind,
  ref,
  sourceKey: `${kind}:${ref}`,
  chunk: n,
  title,
  text,
  url: `/admin/${ref}`,
  lang: "en",
  updatedAt: "2026-11-17T00:00:00Z",
  embedding: unit(v),
  embeddingModel: "gemini-embedding-001@768",
});

async function seeded() {
  const index = new MemorySearchIndex();
  const store = index.storeFor(ctx);
  const put = async (...docs: SearchChunkDoc[]) =>
    store.putSource({ sourceKey: docs[0]!.sourceKey, kind: docs[0]!.kind, ref: docs[0]!.ref, hash: "h", chunks: docs.length, embedded: true, indexedAt: "" }, docs, 0);
  await put(chunk("a1", "article", "Repotting a fiddle leaf fig", "Use the FL-204 repotting kit in spring.", [1, 0.1, 0]), chunk("a1", "article", "Repotting a fiddle leaf fig", "Water after repotting.", [0.9, 0.2, 0], 1));
  await put(chunk("b1", "broadcast", "Returns are free", "Returns are free for 30 days on every kit, including FL-204.", [0.2, 1, 0]));
  await put(chunk("p1", "post", "Bigger pots", "Move your plant into a bigger pot when roots show.", [0.95, 0, 0.1]));
  // Another brand's record, findable by the same words and meaning.
  const other = index.storeFor({ tenantId: "ten_other" });
  await other.putSource({ sourceKey: "article:x1", kind: "article", ref: "x1", hash: "h", chunks: 1, embedded: true, indexedAt: "" }, [{ ...chunk("x1", "article", "Repotting", "FL-204 repotting kit", [1, 0, 0]), tenantId: "ten_other" }], 0);
  return store;
}

const embedAs = (v: number[] | null) => vi.fn(async () => [v ? unit(v) : null]);
const noRerank = vi.fn(async () => null);

describe("searchBrand", () => {
  beforeEach(() => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    vi.stubEnv("SEARCH_ENABLED", "true");
    noRerank.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is off while either switch is off, and refuses a brand without search", async () => {
    const store = await seeded();
    vi.stubEnv("SEARCH_ENABLED", "false");
    expect(await searchBrand(ctx, "repot", {}, { store, embed: embedAs([1, 0, 0]), rerank: noRerank, granted: true })).toEqual({ ok: false, error: "search_disabled" });
    vi.stubEnv("SEARCH_ENABLED", "true");
    expect(await searchBrand(ctx, "repot", {}, { store, embed: embedAs([1, 0, 0]), rerank: noRerank, granted: false })).toEqual({ ok: false, error: "not_granted" });
  });

  it("merges words and meaning, one result per record, and says which side found each", async () => {
    const store = await seeded();
    const out = await searchBrand(ctx, "FL-204 repotting kit", {}, { store, embed: embedAs([1, 0.05, 0]), rerank: noRerank, granted: true });
    if (!out.ok) throw new Error("expected ok");
    const keys = out.result.hits.map((h) => h.sourceKey);
    expect(keys[0]).toBe("article:a1");
    expect(new Set(keys).size).toBe(keys.length);
    expect(out.result.hits.find((h) => h.sourceKey === "article:a1")?.matched).toBe("both");
    expect(out.result.hits.find((h) => h.sourceKey === "post:p1")?.matched).toBe("meaning");
    expect(keys).not.toContain("article:x1");
    expect(out.result.meaning).toBe(true);
  });

  it("finds a question by its key terms although no record has every word", async () => {
    const store = await seeded();
    const out = await searchBrand(ctx, "what is the returns window for a kit", {}, { store, embed: embedAs(null), rerank: noRerank, granted: true });
    if (!out.ok) throw new Error("expected ok");
    expect(out.result.hits[0]?.sourceKey).toBe("broadcast:b1");
    expect(out.result.meaning).toBe(false);
  });

  it("keeps to the kinds asked for", async () => {
    const store = await seeded();
    const out = await searchBrand(ctx, "FL-204", { kinds: ["broadcast"] }, { store, embed: embedAs([1, 0, 0]), rerank: noRerank, granted: true });
    if (!out.ok) throw new Error("expected ok");
    expect(out.result.hits.map((h) => h.kind)).toEqual(["broadcast"]);
  });

  it("uses the Ranking API's order when it answers", async () => {
    const store = await seeded();
    const order = vi.fn(async () => ["post:p1", "article:a1"]);
    const out = await searchBrand(ctx, "repotting", {}, { store, embed: embedAs([1, 0, 0]), rerank: order, granted: true });
    if (!out.ok) throw new Error("expected ok");
    expect(out.result.reranked).toBe(true);
    expect(out.result.hits[0]?.sourceKey).toBe("post:p1");
  });

  it("answers nothing for an empty query", async () => {
    const store = await seeded();
    const out = await searchBrand(ctx, "   ", {}, { store, embed: embedAs([1, 0, 0]), rerank: noRerank, granted: true });
    expect(out).toEqual({ ok: true, result: { hits: [], reranked: false, meaning: false } });
  });
});

describe("snippetFor", () => {
  it("shows the text around the first term when it is far in", () => {
    const text = `${"Intro words. ".repeat(40)}The FL-204 kit has gloves.`;
    expect(snippetFor(text, "FL-204")).toContain("FL-204");
    expect(snippetFor("Short text.", "x")).toBe("Short text.");
  });
});

describe("rerank", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("only runs for US brands on a real project with its switch on", async () => {
    const fetchSpy = vi.fn();
    const records = [
      { id: "a", title: "A", content: "a" },
      { id: "b", title: "B", content: "b" },
    ];
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    vi.stubEnv("SEARCH_ENABLED", "true");
    vi.stubEnv("SEARCH_RERANK_ENABLED", "true");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "demo-yougrow");
    expect(await rerank("q", records, "us", { fetch: fetchSpy, token: async () => "t" })).toBeNull();
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "acme-project");
    expect(await rerank("q", records, "eu", { fetch: fetchSpy, token: async () => "t" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ records: [{ id: "b" }, { id: "a" }] }), { status: 200 }));
    expect(await rerank("q", records, "us", { fetch: fetchSpy, token: async () => "t" })).toEqual(["b", "a"]);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("locations/us/rankingConfigs");
  });

  it("keeps the merged order when the call fails", async () => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    vi.stubEnv("SEARCH_ENABLED", "true");
    vi.stubEnv("SEARCH_RERANK_ENABLED", "true");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "acme-project");
    const records = [
      { id: "a", title: "A", content: "a" },
      { id: "b", title: "B", content: "b" },
    ];
    expect(await rerank("q", records, "us", { fetch: vi.fn(async () => new Response("no", { status: 403 })), token: async () => "t" })).toBeNull();
  });
});
