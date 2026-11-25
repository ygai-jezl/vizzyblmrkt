import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route: switch, sign-in, origin check (POST), input, the autopilot's hold, then the versions
// module (tested in src/lib/content/blog/versions.test.ts).
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({ forTenant: vi.fn(() => ({ workspaces: { getById: vi.fn(async () => ({ id: "ws1" })) } })) }));
vi.mock("@/lib/tenant", () => tenant);
const content = vi.hoisted(() => ({ getContentPlan: vi.fn(async (): Promise<unknown> => ({ id: "plan_1", workspaceId: "ws1" })) }));
vi.mock("@/lib/tenant/workspaceContent", () => content);
const versions = vi.hoisted(() => ({
  listVersions: vi.fn(async () => [{ n: 1, at: "2026-11-25T10:00:00.000Z", reason: "apply", words: 900, metaTitle: "T" }]),
  restoreVersion: vi.fn(async (): Promise<unknown> => ({ ok: true, node: { id: "hub" }, kept: 2 })),
}));
vi.mock("@/lib/content/blog/versions", () => versions);

const { GET, POST } = await import("./route");
const params = { params: Promise.resolve({ workspaceId: "ws1", planId: "plan_1", nodeId: "hub" }) };
const URL = "http://localhost/api/admin/workspace/ws1/content-plans/plan_1/nodes/hub/blog/versions";
const post = (body: unknown) => new Request(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  for (const s of ["BRAND_MAP_ENABLED", "BRAND_MAP_PAGES_ENABLED", "BLOG_DATES_ENABLED", "BLOG_FRESHNESS_ENABLED", "BLOG_REFRESH_ENABLED"]) vi.stubEnv(s, "true");
  session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", source: "idtoken", role: "member" });
});
afterEach(() => vi.unstubAllEnvs());

describe("the versions route", () => {
  it("lists a member's article's versions, and is off with its switch off or signed out", async () => {
    const r = await GET(new Request(URL), params);
    expect(r.status).toBe(200);
    expect((await r.json()).versions).toHaveLength(1);
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await GET(new Request(URL), params)).status).toBe(401);
    vi.stubEnv("BLOG_REFRESH_ENABLED", "false");
    expect((await GET(new Request(URL), params)).status).toBe(503);
    expect((await POST(post({ restore: 1 }), params)).status).toBe(503);
  });

  it("restores a version by number, and nothing else", async () => {
    expect((await POST(post({ restore: 1 }), params)).status).toBe(200);
    expect(versions.restoreVersion).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ nodeId: "hub", n: 1 }));
    expect((await POST(post({ restore: 0 }), params)).status).toBe(400);
    expect((await POST(post({ restore: 1, tenantId: "ten_B" }), params)).status).toBe(400);
    versions.restoreVersion.mockResolvedValueOnce({ ok: false, error: "no_version" });
    expect((await POST(post({ restore: 7 }), params)).status).toBe(404);
    versions.restoreVersion.mockResolvedValueOnce({ ok: false, error: "locked" });
    expect((await POST(post({ restore: 1 }), params)).status).toBe(409);
  });

  it("leaves an article the autopilot is writing alone, and a plan that isn't there", async () => {
    content.getContentPlan.mockResolvedValueOnce({ id: "plan_1", workspaceId: "ws1", autopilot: { runId: "r", state: "working", at: "2026-11-25T10:00:00.000Z" } });
    expect((await POST(post({ restore: 1 }), params)).status).toBe(409);
    content.getContentPlan.mockResolvedValueOnce(null);
    expect((await POST(post({ restore: 1 }), params)).status).toBe(404);
    expect(versions.restoreVersion).not.toHaveBeenCalled();
  });
});
