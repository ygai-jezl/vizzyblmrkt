import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * listKnowledgePages reads the real subcollections (it is tenant-layer code), so the
 * database handle is stubbed here with just the query chain it uses: a source's page
 * records first, and its chunks when it has none.
 */
type Calls = { path: string[]; where?: unknown[]; select?: string[]; limit?: number };
const calls: Record<string, Calls> = {};
const rows: { knowledge_pages: Record<string, unknown>[]; knowledge_bases: Record<string, unknown>[] } = { knowledge_pages: [], knowledge_bases: [] };

function queryFor(name: string, path: string[]) {
  const c: Calls = (calls[name] = { path });
  const query = {
    where: vi.fn((...args: unknown[]) => ((c.where = args), query)),
    select: vi.fn((...fields: string[]) => ((c.select = fields), query)),
    limit: vi.fn((n: number) => ((c.limit = n), query)),
    get: vi.fn(async () => ({ docs: (name in rows ? rows[name as keyof typeof rows] : []).map((r) => ({ data: () => r })) })),
  };
  return query;
}
function node(path: string[]): { collection: (name: string) => unknown } {
  return {
    collection: (name: string) => ({ ...queryFor(name, [...path, name]), doc: (id: string) => node([...path, name, id]) }),
  };
}
vi.mock("./firestore", () => ({ getDb: () => node([]) }));

import { listKnowledgePages } from "./knowledge";
import type { TenantContext } from "./types";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };

beforeEach(() => {
  rows.knowledge_pages = [];
  rows.knowledge_bases = [];
  for (const k of Object.keys(calls)) delete calls[k];
});

describe("listKnowledgePages", () => {
  it("lists a source's pages from their records only when asked, in crawl order, with their links", async () => {
    rows.knowledge_pages.push(
      { url: "https://acme.example/pricing", title: "Pricing | Acme", path: "/pricing", source: "website", links: ["https://acme.example/", 7], pageIndex: 1 },
      { url: "https://acme.example/", title: "Acme", path: "/", source: "website", links: [], pageIndex: 0 },
      { title: "no address", pageIndex: 2 },
    );
    const pages = await listKnowledgePages(ctx, "workspace", "ws1", { ticketId: "tkt_1", records: true });
    expect(pages).toEqual([
      { sourceUri: "https://acme.example/", title: "Acme", path: "/", source: "website", links: [] },
      { sourceUri: "https://acme.example/pricing", title: "Pricing | Acme", path: "/pricing", source: "website", links: ["https://acme.example/"] },
    ]);
    expect(calls.knowledge_pages).toMatchObject({ path: ["workspaces", "ws1", "knowledge_pages"], where: ["ticketId", "==", "tkt_1"], limit: 600 });
    // One read a page: the chunks are not touched.
    expect(calls.knowledge_bases).toBeUndefined();
  });

  it("never reads the records unless asked, so everyone else's listing is as before", async () => {
    rows.knowledge_pages.push({ url: "https://acme.example/pricing", title: "Pricing plans | Acme", pageIndex: 0 });
    rows.knowledge_bases.push({ sourceUri: "https://acme.example/pricing", title: "Pricing", path: "/pricing", source: "website", chunkIndex: 0 });
    expect(await listKnowledgePages(ctx, "workspace", "ws1", { ticketId: "tkt_1" })).toEqual([
      { sourceUri: "https://acme.example/pricing", title: "Pricing", path: "/pricing", source: "website" },
    ]);
    expect(calls.knowledge_pages).toBeUndefined();
  });

  it("lists a source read before page records from its chunks, once each, reading only what it returns", async () => {
    rows.knowledge_bases.push(
      { sourceUri: "https://acme.example/pricing", title: "Plans", path: "/pricing", source: "website", chunkIndex: 3 },
      { sourceUri: "https://acme.example/pricing", title: "Pricing | Acme", path: "/pricing", source: "website", chunkIndex: 2 },
      { sourceUri: "https://acme.example/", title: "Acme", path: "/", source: "website", chunkIndex: 0 },
      { sourceUri: "", title: "no address", chunkIndex: 1 },
      { title: "no address field at all", chunkIndex: 4 },
    );
    const pages = await listKnowledgePages(ctx, "workspace", "ws1", { ticketId: "tkt_1", limit: 5000 });
    // A page's title is its first chunk's; a chunk with no address is not a page; no links were kept.
    expect(pages).toEqual([
      { sourceUri: "https://acme.example/", title: "Acme", path: "/", source: "website" },
      { sourceUri: "https://acme.example/pricing", title: "Pricing | Acme", path: "/pricing", source: "website" },
    ]);
    expect(calls.knowledge_bases!.path).toEqual(["workspaces", "ws1", "knowledge_bases"]);
    expect(calls.knowledge_bases!.where).toEqual(["ticketId", "==", "tkt_1"]);
    // Never the text or the embedding, and never an unbounded read.
    expect(calls.knowledge_bases!.select).toEqual(["sourceUri", "title", "path", "source", "chunkIndex"]);
    expect(calls.knowledge_bases!.limit).toBe(2000);
  });
});
