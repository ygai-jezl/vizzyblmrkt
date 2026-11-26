import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { healthyAt } from "@/lib/connectors/health";
import { createDataConnection, type NewDataConnection } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { freshCollect, type ConnectionGrant } from "@/lib/types/dataConnection";
import { MemorySearchIndex } from "./memoryStore";
import { randomUnitVector, seededRandom } from "./nearestCheck";
import { searchBrand, snippetFor, type SearchViewer } from "./query";
import { indexSummary } from "./status";
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

describe("the brand map family in people's search (ADR-0025)", () => {
  beforeEach(() => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    vi.stubEnv("SEARCH_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  /** A brand whose map has one decided subject on repotting, an answered question and 5,000 proposals. */
  async function withFamily() {
    const rand = seededRandom(11);
    const store = new MemorySearchIndex().storeFor(ctx);
    const target = unit([1, 0, 0, 0]);
    const put = async (kind: SearchChunkDoc["kind"], ref: string, status: SearchChunkDoc["status"], text: string, v: number[], chunks = 1) => {
      const docs = Array.from({ length: chunks }, (_, n) => ({ ...chunk(ref, kind, text, text, v, n), ...(status ? { status } : {}), embedding: n ? randomUnitVector(4, rand) : v }));
      await store.putSource({ sourceKey: `${kind}:${ref}`, kind, ref, hash: "h", chunks, embedded: true, indexedAt: "2026-11-26T10:00:00.000Z", ...(status ? { status } : {}) }, docs, 0);
    };
    await put("subject", "sub_onmap", "decided", "Repotting figs", unit([1, 0.02, 0, 0]));
    await put("question", "note_bn_1", "answered", "How do you repot a fig?", target);
    await put("subject", "sub_proposals", "proposed", "Repotting fig trees", target, 5_000);
    return store;
  }

  it("never shows proposals or answered questions, and finds a decided subject among 5,000 proposals", async () => {
    const store = await withFamily();
    const out = await searchBrand(ctx, "repotting figs", {}, { store, embed: embedAs([1, 0, 0, 0]), rerank: noRerank, granted: true });
    if (!out.ok) throw new Error("expected ok");
    expect(out.result.hits.map((h) => h.sourceKey)).toEqual(["subject:sub_onmap"]);
  });

  it("counts only what people can find on the Search card", async () => {
    const summary = await indexSummary(ctx, { store: await withFamily() });
    expect(summary).toMatchObject({ records: 1, chunks: 1, byKind: { subject: 1 } });
  });
});

describe("searches from a connection", () => {
  // Search Console's searches for a made-up site (ADR-0013), beside an article anyone may find.
  const GSC = "dcn_ffffffffffffffffffff";
  const SEARCHES = `research:gsc:${GSC}`;
  const AT = "2026-11-22T10:00:00.000Z";
  let db: FakeFirestore;

  beforeEach(() => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    vi.stubEnv("SEARCH_ENABLED", "true");
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
    vi.stubEnv("CONNECTORS_SEARCH_TEXT_ENABLED", "true");
    db = new FakeFirestore();
  });
  afterEach(() => vi.unstubAllEnvs());

  async function withSearches(grants: ConnectionGrant[], over: Partial<NewDataConnection> = {}, tenant = { ...ctx, source: "system" as const }) {
    await createDataConnection(
      tenant,
      {
        id: GSC,
        connectorId: "search-console",
        method: "share_access",
        label: "Google Search Console",
        account: "sc-domain:fernleaf.example",
        ownerUid: "usr_admin",
        grants,
        secrets: {},
        health: healthyAt(new Date(AT)),
        pausedAt: null,
        pausedBy: null,
        status: "connected",
        createdAt: AT,
        updatedAt: AT,
        disconnectedAt: null,
        collect: freshCollect(null, 0),
        ...over,
      },
      [{ kind: "connected", by: "usr_admin", at: AT }],
      db,
    );
    const store = await seeded();
    await store.putSource(
      { sourceKey: SEARCHES, kind: "research", ref: `gsc:${GSC}`, hash: "h", chunks: 1, embedded: true, indexedAt: AT },
      [{ ...chunk(`gsc:${GSC}`, "research", "Google searches: fernleaf.example", "repotting kit for a fig: 500 impressions, 9 clicks, position 6.4 in the 28 days to 20 Nov", [1, 0.05, 0]), sourceKey: SEARCHES }],
      0,
    );
    return store;
  }
  const found = async (store: Awaited<ReturnType<typeof withSearches>>, viewer: SearchViewer | undefined) => {
    const out = await searchBrand(ctx, "repotting kit", viewer ? { viewer } : {}, { store, embed: embedAs([1, 0.05, 0]), rerank: noRerank, granted: true, db });
    if (!out.ok) throw new Error("expected ok");
    return out.result.hits.map((h) => h.sourceKey);
  };
  const admin: SearchViewer = { role: "admin", uid: "usr_admin" };
  const member: SearchViewer = { role: "member", uid: "usr_sam" };
  const vizzyFor = (forRole: "admin" | "member"): SearchViewer => ({ agent: "vizzy", forRole });

  it("are dropped for a caller that names no viewer, and kept for an admin", async () => {
    const store = await withSearches([]);
    expect(await found(store, undefined)).not.toContain(SEARCHES);
    expect(await found(store, undefined)).toContain("article:a1");
    expect(await found(store, admin)).toContain(SEARCHES);
  });

  it("show a member only when members may read the connection", async () => {
    expect(await found(await withSearches([]), member)).not.toContain(SEARCHES);
    db = new FakeFirestore();
    expect(await found(await withSearches([{ to: "members", can: "read" }]), member)).toContain(SEARCHES);
  });

  it("show Vizzy only with its grant, and for a member only when members may read it too", async () => {
    const membersOnly = await withSearches([{ to: "members", can: "read" }]);
    expect(await found(membersOnly, vizzyFor("admin"))).not.toContain(SEARCHES);
    db = new FakeFirestore();
    const vizzyOnly = await withSearches([{ to: "agent:vizzy", can: "read" }]);
    expect(await found(vizzyOnly, vizzyFor("admin"))).toContain(SEARCHES);
    expect(await found(vizzyOnly, vizzyFor("member"))).not.toContain(SEARCHES);
    db = new FakeFirestore();
    const both = await withSearches([
      { to: "members", can: "read" },
      { to: "agent:vizzy", can: "read" },
    ]);
    expect(await found(both, vizzyFor("member"))).toContain(SEARCHES);
  });

  it("are dropped for everyone once the connection is disconnected, or the switch or collecting is off", async () => {
    const store = await withSearches([], { status: "disconnected", disconnectedAt: AT });
    expect(await found(store, admin)).not.toContain(SEARCHES);
    db = new FakeFirestore();
    const live = await withSearches([]);
    vi.stubEnv("CONNECTORS_SEARCH_TEXT_ENABLED", "false");
    expect(await found(live, admin)).not.toContain(SEARCHES);
    vi.stubEnv("CONNECTORS_SEARCH_TEXT_ENABLED", "true");
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "false");
    expect(await found(live, admin)).not.toContain(SEARCHES);
  });

  it("are dropped when the connection is another brand's, or not Search Console", async () => {
    // The same connection id, but on another brand: this brand has no such connection.
    expect(await found(await withSearches([], {}, { tenantId: "ten_other", region: "us", source: "system" }), admin)).not.toContain(SEARCHES);
    db = new FakeFirestore();
    expect(await found(await withSearches([], { connectorId: "cloudflare", method: "token_fields" }), admin)).not.toContain(SEARCHES);
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
