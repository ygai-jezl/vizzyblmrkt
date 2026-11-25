import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route: switch, sign-in, the programme and plan, then the AI original (tested in
// src/lib/content/create/aiOriginals.test.ts).
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({ forTenant: vi.fn(() => ({ workspaces: { getById: vi.fn(async (): Promise<unknown> => ({ id: "ws1" })) } })) }));
vi.mock("@/lib/tenant", () => tenant);
const content = vi.hoisted(() => ({
  getContentPlan: vi.fn(async (): Promise<unknown> => ({ id: "plan_1", workspaceId: "ws1", graph: { nodes: [{ id: "li", type: "spoke", channel: "linkedin", body: "Edited post." }] } })),
}));
vi.mock("@/lib/tenant/workspaceContent", () => content);
const originals = vi.hoisted(() => ({
  readOriginal: vi.fn(async (): Promise<unknown> => ({
    workspaceId: "ws1",
    regenerations: 0,
    pairs: [],
    original: { body: "Vizzy's post.", at: "2026-11-25T10:00:00.000Z", by: "autopilot", userId: null, stamp: null, sources: ["knowledge"] },
  })),
}));
vi.mock("@/lib/content/create/aiOriginals", () => originals);

const { GET } = await import("./route");
const params = { params: Promise.resolve({ workspaceId: "ws1", planId: "plan_1", nodeId: "li" }) };
const URL = "http://localhost/api/admin/workspace/ws1/content-plans/plan_1/nodes/li/ai-original";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONTENT_AI_ORIGINALS_ENABLED", "true");
  session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", source: "idtoken", role: "member" });
});
afterEach(() => vi.unstubAllEnvs());

describe("the AI original route", () => {
  it("shows a member the piece's AI draft and how it changed", async () => {
    const r = await GET(new Request(URL), params);
    expect(r.status).toBe(200);
    const { original } = await r.json();
    expect(original).toMatchObject({ by: "autopilot", approval: null, sources: ["knowledge"], now: { approvedAsWritten: false } });
    expect(original.sections).toHaveLength(1);
  });

  it("says when no AI draft was kept, or one belongs to another programme", async () => {
    originals.readOriginal.mockResolvedValueOnce(null);
    expect((await (await GET(new Request(URL), params)).json()).original).toBeNull();
    originals.readOriginal.mockResolvedValueOnce({ workspaceId: "ws_other", regenerations: 0, pairs: [], original: { body: "x", at: "", by: "person", userId: null, stamp: null, sources: [] } });
    expect((await (await GET(new Request(URL), params)).json()).original).toBeNull();
  });

  it("is off with its switch off, needs a sign-in, and 404s a missing plan or piece", async () => {
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await GET(new Request(URL), params)).status).toBe(401);
    content.getContentPlan.mockResolvedValueOnce(null);
    expect((await GET(new Request(URL), params)).status).toBe(404);
    expect((await GET(new Request(URL), { params: Promise.resolve({ workspaceId: "ws1", planId: "plan_1", nodeId: "gone" }) })).status).toBe(404);
    vi.stubEnv("CONTENT_AI_ORIGINALS_ENABLED", "false");
    expect((await GET(new Request(URL), params)).status).toBe(503);
    expect(originals.readOriginal).toHaveBeenCalledTimes(0);
  });
});
