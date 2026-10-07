import { describe, expect, it, vi } from "vitest";

/**
 * listKnowledgePages reads the real chunk subcollection (it is tenant-layer code), so the
 * database handle is stubbed here with just the query chain it uses.
 */
const calls: { path: string[]; where?: unknown[]; select?: string[]; limit?: number } = { path: [] };
const rows: Record<string, unknown>[] = [];
const query = {
  where: vi.fn((...args: unknown[]) => {
    calls.where = args;
    return query;
  }),
  select: vi.fn((...fields: string[]) => {
    calls.select = fields;
    return query;
  }),
  limit: vi.fn((n: number) => {
    calls.limit = n;
    return query;
  }),
  get: vi.fn(async () => ({ docs: rows.map((r) => ({ data: () => r })) })),
};
const node = {
  collection: (name: string) => {
    calls.path.push(name);
    return { ...query, doc: (id: string) => (calls.path.push(id), node) };
  },
};
vi.mock("./firestore", () => ({ getDb: () => node }));

import { listKnowledgePages } from "./knowledge";
import type { TenantContext } from "./types";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };

describe("listKnowledgePages", () => {
  it("lists one source's pages once each, reading only what it returns", async () => {
    rows.push(
      { sourceUri: "https://acme.example/pricing", title: "Plans", path: "/pricing", source: "website", chunkIndex: 3 },
      { sourceUri: "https://acme.example/pricing", title: "Pricing | Acme", path: "/pricing", source: "website", chunkIndex: 2 },
      { sourceUri: "https://acme.example/", title: "Acme", path: "/", source: "website", chunkIndex: 0 },
      { sourceUri: "", title: "no address", chunkIndex: 1 },
      { title: "no address field at all", chunkIndex: 4 },
    );
    const pages = await listKnowledgePages(ctx, "workspace", "ws1", { ticketId: "tkt_1", limit: 5000 });
    // A page's title is its first chunk's; a chunk with no address is not a page.
    expect(pages).toEqual([
      { sourceUri: "https://acme.example/", title: "Acme", path: "/", source: "website" },
      { sourceUri: "https://acme.example/pricing", title: "Pricing | Acme", path: "/pricing", source: "website" },
    ]);
    expect(calls.path).toEqual(["workspaces", "ws1", "knowledge_bases"]);
    expect(calls.where).toEqual(["ticketId", "==", "tkt_1"]);
    // Never the text or the embedding, and never an unbounded read.
    expect(calls.select).toEqual(["sourceUri", "title", "path", "source", "chunkIndex"]);
    expect(calls.limit).toBe(2000);
  });
});
