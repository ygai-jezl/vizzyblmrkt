import { describe, it, expect, afterEach, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { retrieveSemanticKnowledgeContext } from "./knowledgeRetrieval";
import type { TenantContext, KnowledgeCollectionLike } from "@/lib/tenant/types";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };

afterEach(() => vi.unstubAllEnvs());

/** A fake vector collection whose findNearest returns the given docs. */
function fakeChunks(docs: Array<Record<string, unknown>>): KnowledgeCollectionLike {
  return {
    findNearest: () => ({
      get: async () => ({
        empty: docs.length === 0,
        size: docs.length,
        docs: docs.map((d, i) => ({ id: `c${i}`, data: () => d })),
      }),
    }),
  };
}

function dbWithCampaign(): FakeFirestore {
  const db = new FakeFirestore();
  db.seed("campaigns", "camp1", { tenantId: "ten_A", waitlistName: "Launch" });
  return db;
}

const chunk = (over: Record<string, unknown> = {}) => ({
  tenantId: "ten_A",
  campaignId: "camp1",
  title: "README",
  content: "We charge per seat.",
  sourceUri: "https://github.com/org/repo/blob/HEAD/README.md",
  path: "README.md",
  heading: null,
  ...over,
});

describe("retrieveSemanticKnowledgeContext", () => {
  it("returns null when the feature flag is off (no DB / embed calls)", async () => {
    vi.stubEnv("KNOWLEDGE_RAG_ENABLED", "false");
    const embed = vi.fn();
    const res = await retrieveSemanticKnowledgeContext(
      { ctx, campaignId: "camp1", queryText: "pricing" },
      { db: dbWithCampaign(), embed: embed as never },
    );
    expect(res).toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });

  it("returns null when the campaign is not owned (never queries chunks)", async () => {
    vi.stubEnv("KNOWLEDGE_RAG_ENABLED", "true");
    const embed = vi.fn();
    const db = new FakeFirestore(); // campaign absent for ten_A
    db.seed("campaigns", "camp1", { tenantId: "ten_OTHER" });
    const res = await retrieveSemanticKnowledgeContext(
      { ctx, campaignId: "camp1", queryText: "pricing" },
      { db, embed: embed as never },
    );
    expect(res).toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });

  it("returns null when query embedding fails (degrade)", async () => {
    vi.stubEnv("KNOWLEDGE_RAG_ENABLED", "true");
    const res = await retrieveSemanticKnowledgeContext(
      { ctx, campaignId: "camp1", queryText: "pricing" },
      { db: dbWithCampaign(), embed: async () => null, chunks: fakeChunks([chunk()]) },
    );
    expect(res).toBeNull();
  });

  it("filters out chunks from another tenant/campaign (defence in depth)", async () => {
    vi.stubEnv("KNOWLEDGE_RAG_ENABLED", "true");
    const res = await retrieveSemanticKnowledgeContext(
      { ctx, campaignId: "camp1", queryText: "pricing" },
      {
        db: dbWithCampaign(),
        embed: async () => [0.1, 0.2, 0.3],
        chunks: fakeChunks([
          chunk({ content: "ours" }),
          chunk({ tenantId: "ten_EVIL", content: "leaked tenant" }),
          chunk({ campaignId: "other", content: "leaked campaign" }),
        ]),
      },
    );
    expect(res).not.toBeNull();
    expect(res!.chunks).toHaveLength(1);
    expect(res!.chunks[0]!.content).toBe("ours");
    expect(res!.formatted).toContain("ours");
    expect(res!.formatted).not.toContain("leaked");
  });

  it("formats a grounding block with source citations", async () => {
    vi.stubEnv("KNOWLEDGE_RAG_ENABLED", "true");
    const res = await retrieveSemanticKnowledgeContext(
      { ctx, campaignId: "camp1", queryText: "pricing" },
      { db: dbWithCampaign(), embed: async () => [0.1], chunks: fakeChunks([chunk()]) },
    );
    expect(res!.formatted).toContain("[Source: README");
    expect(res!.formatted).toContain("We charge per seat.");
  });

  it("returns empty (not null) when there are no neighbours", async () => {
    vi.stubEnv("KNOWLEDGE_RAG_ENABLED", "true");
    const res = await retrieveSemanticKnowledgeContext(
      { ctx, campaignId: "camp1", queryText: "pricing" },
      { db: dbWithCampaign(), embed: async () => [0.1], chunks: fakeChunks([]) },
    );
    expect(res).not.toBeNull();
    expect(res!.chunks).toHaveLength(0);
    expect(res!.formatted).toBe("");
  });
});
