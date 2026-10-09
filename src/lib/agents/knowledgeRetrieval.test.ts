import { describe, it, expect, afterEach, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { retrieveSemanticKnowledgeContext } from "./knowledgeRetrieval";
import type { TenantContext, KnowledgeCollectionLike } from "@/lib/tenant/types";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
afterEach(() => vi.unstubAllEnvs());

/** Fake vector collection: where() returns self, findNearest().get() yields docs. */
function fakeChunks(docs: Array<Record<string, unknown>>): KnowledgeCollectionLike {
  const self: KnowledgeCollectionLike = {
    where: () => self,
    findNearest: () => ({
      get: async () => ({
        empty: docs.length === 0,
        size: docs.length,
        docs: docs.map((d, i) => ({ id: `c${i}`, data: () => d })),
      }),
    }),
  };
  return self;
}

function dbWithWorkspace(): FakeFirestore {
  const db = new FakeFirestore();
  db.seed("workspaces", "ws1", { tenantId: "ten_A", name: "WS" });
  return db;
}

const chunk = (over: Record<string, unknown> = {}) => ({
  tenantId: "ten_A",
  ownerKind: "workspace",
  ownerId: "ws1",
  title: "README",
  content: "We charge per seat.",
  sourceUri: "https://github.com/org/repo/blob/HEAD/README.md",
  path: "README.md",
  heading: null,
  topic: "sales",
  tags: ["pricing"],
  ...over,
});

const baseReq = {
  ctx,
  ownerKind: "workspace" as const,
  ownerId: "ws1",
  queryText: "pricing",
};

describe("retrieveSemanticKnowledgeContext", () => {
  it("returns null when the flag is off (no DB/embed calls)", async () => {
    vi.stubEnv("KNOWLEDGE_RAG_ENABLED", "false");
    const embed = vi.fn();
    const res = await retrieveSemanticKnowledgeContext(baseReq, {
      db: dbWithWorkspace(),
      embed: embed as never,
    });
    expect(res).toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });

  it("bypassEnabledFlag runs even when the flag is off (admin test box)", async () => {
    vi.stubEnv("KNOWLEDGE_RAG_ENABLED", "false");
    const res = await retrieveSemanticKnowledgeContext(
      { ...baseReq, bypassEnabledFlag: true },
      { db: dbWithWorkspace(), embed: async () => [0.1], chunks: fakeChunks([chunk()]) },
    );
    expect(res).not.toBeNull();
    expect(res!.chunks).toHaveLength(1);
  });

  it("returns null when the owner is not owned (never queries)", async () => {
    vi.stubEnv("KNOWLEDGE_RAG_ENABLED", "true");
    const embed = vi.fn();
    const db = new FakeFirestore();
    db.seed("workspaces", "ws1", { tenantId: "ten_OTHER" });
    const res = await retrieveSemanticKnowledgeContext(baseReq, { db, embed: embed as never });
    expect(res).toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });

  it("returns null when query embedding fails (degrade)", async () => {
    vi.stubEnv("KNOWLEDGE_RAG_ENABLED", "true");
    const res = await retrieveSemanticKnowledgeContext(baseReq, {
      db: dbWithWorkspace(),
      embed: async () => null,
      chunks: fakeChunks([chunk()]),
    });
    expect(res).toBeNull();
  });

  it("filters out chunks from another tenant/owner (defence in depth)", async () => {
    vi.stubEnv("KNOWLEDGE_RAG_ENABLED", "true");
    const res = await retrieveSemanticKnowledgeContext(baseReq, {
      db: dbWithWorkspace(),
      embed: async () => [0.1, 0.2],
      chunks: fakeChunks([
        chunk({ content: "ours" }),
        chunk({ tenantId: "ten_EVIL", content: "leaked tenant" }),
        chunk({ ownerId: "other", content: "leaked owner" }),
        chunk({ ownerKind: "campaign", content: "leaked kind" }),
      ]),
    });
    expect(res!.chunks).toHaveLength(1);
    expect(res!.chunks[0]!.content).toBe("ours");
    expect(res!.formatted).not.toContain("leaked");
  });

  it("formats a grounding block; empty (not null) when no neighbours", async () => {
    vi.stubEnv("KNOWLEDGE_RAG_ENABLED", "true");
    const ok = await retrieveSemanticKnowledgeContext(baseReq, {
      db: dbWithWorkspace(),
      embed: async () => [0.1],
      chunks: fakeChunks([chunk()]),
    });
    expect(ok!.formatted).toContain("[Source: README");
    expect(ok!.formatted).toContain("We charge per seat.");

    const empty = await retrieveSemanticKnowledgeContext(baseReq, {
      db: dbWithWorkspace(),
      embed: async () => [0.1],
      chunks: fakeChunks([]),
    });
    expect(empty).not.toBeNull();
    expect(empty!.chunks).toHaveLength(0);
    expect(empty!.formatted).toBe("");
  });
});

describe("a cite source on someone else's site", () => {
  // Honours the query's limit, like the real collection: the nearest come first.
  function nearestOf(docs: Array<Record<string, unknown>>): KnowledgeCollectionLike & { asked: number[] } {
    const asked: number[] = [];
    const self: KnowledgeCollectionLike & { asked: number[] } = {
      asked,
      where: () => self,
      findNearest: (opts) => ({
        get: async () => {
          asked.push(opts.limit);
          const got = docs.slice(0, opts.limit);
          return { empty: got.length === 0, size: got.length, docs: got.map((d, i) => ({ id: `c${i}`, data: () => d })) };
        },
      }),
    };
    return self;
  }

  const page = (sourceUri: string, content: string, tags: string[] = []) =>
    chunk({ source: "docs_url", sourceUri, path: null, title: content, content, tags });
  const study = (n: number) => page("https://research.example.org/report", `A study finding ${n}`, ["cite"]);
  const ours = (n: number) => page(`https://acme.example/page-${n}`, `Our own page ${n}`);

  /** The workspace's sources: its own site, and a study marked as one to cite. */
  function db(tickets: Array<Record<string, unknown>> = []): FakeFirestore {
    const fs = dbWithWorkspace();
    const base = { tenantId: "ten_A", ownerKind: "workspace", ownerId: "ws1", status: "done" };
    [
      { source: "website", sourceUri: "https://acme.example", tags: [] },
      { source: "docs_url", sourceUri: "https://research.example.org/report", tags: ["cite"] },
      ...tickets,
    ].forEach((t, i) => fs.seed("ingestion_tickets", `tkt_${i}`, { ...base, ...t }));
    return fs;
  }

  const on = () => {
    vi.stubEnv("KNOWLEDGE_RAG_ENABLED", "true");
    vi.stubEnv("CREATE_BLOG_CITE_SOURCES_ENABLED", "true");
  };

  it("is left out of the brand's own material, and the gap is made up from the brand's pages", async () => {
    on();
    const chunks = nearestOf([study(1), ours(1), study(2), ours(2), ours(3), ours(4), ours(5)]);
    const res = await retrieveSemanticKnowledgeContext({ ...baseReq, limit: 3 }, { db: db(), embed: async () => [0.1], chunks });
    expect(res!.chunks.map((c) => c.content)).toEqual(["Our own page 1", "Our own page 2", "Our own page 3"]);
    expect(res!.formatted).not.toContain("A study finding");
    // One look found two to leave out; one further look (3, twice the 2 left out, and 4
    // to spare) made them up.
    expect(chunks.asked).toEqual([3, 11]);
  });

  it("is returned to the caller that asks for it — blog research, and the operator's search box", async () => {
    on();
    const chunks = nearestOf([study(1), ours(1), study(2)]);
    const res = await retrieveSemanticKnowledgeContext(
      { ...baseReq, limit: 3, includeCited: true },
      { db: db(), embed: async () => [0.1], chunks },
    );
    expect(res!.chunks.map((c) => c.content)).toEqual(["A study finding 1", "Our own page 1", "A study finding 2"]);
    expect(chunks.asked).toEqual([3]);
  });

  it("stays the brand's own material when the cite source is on the brand's own site", async () => {
    on();
    const ownReport = page("https://docs.acme.example/benchmark-2026", "Our own benchmark", ["cite"]);
    const chunks = nearestOf([ownReport, study(1), ours(1)]);
    const res = await retrieveSemanticKnowledgeContext({ ...baseReq, limit: 3 }, { db: db(), embed: async () => [0.1], chunks });
    expect(res!.chunks.map((c) => c.content)).toEqual(["Our own benchmark", "Our own page 1"]);
  });

  it("takes nothing as the brand's own when the workspace has no site of its own in its knowledge", async () => {
    on();
    const fs = dbWithWorkspace();
    fs.seed("ingestion_tickets", "t", {
      tenantId: "ten_A", ownerKind: "workspace", ownerId: "ws1", status: "done",
      source: "docs_url", sourceUri: "https://research.example.org/report", tags: ["cite"],
    });
    const chunks = nearestOf([study(1), chunk({ content: "From the repo" })]);
    const res = await retrieveSemanticKnowledgeContext({ ...baseReq, limit: 2 }, { db: fs, embed: async () => [0.1], chunks });
    expect(res!.chunks.map((c) => c.content)).toEqual(["From the repo"]);
  });

  it("is not what a code repo is, even one that carries the tag", async () => {
    on();
    const repo = chunk({ source: "github", content: "From the repo", tags: ["cite"] });
    const chunks = nearestOf([repo]);
    const res = await retrieveSemanticKnowledgeContext(baseReq, { db: db(), embed: async () => [0.1], chunks });
    expect(res!.chunks.map((c) => c.content)).toEqual(["From the repo"]);
    expect(chunks.asked).toEqual([6]);
  });

  it("is ordinary knowledge while the flag is off: nothing is left out and nothing more is asked", async () => {
    vi.stubEnv("KNOWLEDGE_RAG_ENABLED", "true");
    const chunks = nearestOf([study(1), ours(1)]);
    const res = await retrieveSemanticKnowledgeContext({ ...baseReq, limit: 2 }, { db: db(), embed: async () => [0.1], chunks });
    expect(res!.chunks.map((c) => c.content)).toEqual(["A study finding 1", "Our own page 1"]);
    expect(chunks.asked).toEqual([2]);
  });
});
