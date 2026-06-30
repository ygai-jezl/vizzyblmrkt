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
