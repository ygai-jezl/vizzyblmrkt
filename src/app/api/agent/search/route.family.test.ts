import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vizzy's search_brand reads people's search: the brand map family's proposals and answered
// questions (ADR-0025) never reach it, whatever it asks for. The real query runs on an in-memory index.
const auth = vi.hoisted(() => ({
  isCanvasAuthConfigured: vi.fn(() => true),
  verifyCanvasContext: vi.fn(() => ({ ok: true, claims: {} })),
  tenantContextFromCanvasToken: vi.fn(),
}));
vi.mock("@/lib/canvas/auth", () => auth);
vi.mock("@/lib/plans/brandAccess", () => ({ brandCanUse: vi.fn(async () => true) }));
vi.mock("@/lib/tenant/searchIndex", async (original) => (await import("@/lib/search/testing/memorySearch")).withMemorySearch(await original<object>()));
vi.mock("@/lib/agents/embeddings", async (original) => ({
  ...(await original<object>()),
  embedForSearch: vi.fn(async (items: unknown[]) => items.map(() => [1, 0])),
}));

const { POST } = await import("./route");
const { testSearchIndex } = await import("@/lib/search/testing/memorySearch");

const ctx = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_sam", role: "member" };
const post = (body: unknown) =>
  new Request("http://localhost/api/agent/search", { method: "POST", headers: { "x-canvas-context": "tok", "content-type": "application/json" }, body: JSON.stringify(body) });

async function put(kind: "subject" | "question", ref: string, status: "decided" | "proposed" | "answered" | "asked", text: string) {
  const sourceKey = `${kind}:${ref}`;
  await testSearchIndex.storeFor(ctx).putSource(
    { sourceKey, kind, ref, hash: "h", chunks: 1, embedded: true, indexedAt: "2026-11-26T10:00:00.000Z", status },
    [{ tenantId: ctx.tenantId, kind, ref, sourceKey, chunk: 0, title: text, text, url: "/admin/brand-kit/map", lang: "en", updatedAt: "2026-11-26T10:00:00.000Z", status, embedding: [1, 0] }],
    0,
  );
}

beforeEach(() => {
  vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
  vi.stubEnv("SEARCH_ENABLED", "true");
  vi.stubEnv("VIZZY_SEARCH_ENABLED", "true");
  auth.tenantContextFromCanvasToken.mockReturnValue(ctx);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/agent/search and the brand map family", () => {
  it("shows a decided subject and an open question, never a proposal or an answered question", async () => {
    await put("subject", "sub_onmap", "decided", "Repotting figs");
    await put("subject", "sub_proposed", "proposed", "Repotting fig trees");
    await put("question", "note_bn_open", "asked", "When do you repot a fig?");
    await put("question", "note_bn_done", "answered", "How do you repot a fig?");
    for (const kinds of [undefined, ["subject", "question"]]) {
      const res = await POST(post({ query: "repot fig", ...(kinds ? { kinds } : {}) }));
      expect(res.status).toBe(200);
      const titles = (await res.json()).results.map((r: { title: string }) => r.title).sort();
      expect(titles).toEqual(["Repotting figs", "When do you repot a fig?"]);
    }
  });
});
