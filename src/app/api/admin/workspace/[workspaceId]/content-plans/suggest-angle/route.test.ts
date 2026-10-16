import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({ getById: vi.fn(), isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", () => ({ forTenant: () => ({ workspaces: { getById: tenant.getById } }), isRateLimited: tenant.isRateLimited }));
const suggest = vi.hoisted(() => ({ suggestAngle: vi.fn() }));
vi.mock("@/lib/content/create/suggestAngle", async (original) => ({ ...(await original<typeof import("@/lib/content/create/suggestAngle")>()), suggestAngle: suggest.suggestAngle }));

const { POST } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const params = { params: Promise.resolve({ workspaceId: "ws1" }) };
const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/admin/workspace/ws1/content-plans/suggest-angle", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", ...headers },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CREATE_SUGGEST_ANGLE_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  tenant.getById.mockResolvedValue({ id: "ws1", name: "Blog" });
  tenant.isRateLimited.mockResolvedValue(false);
  suggest.suggestAngle.mockResolvedValue({ ok: true, spark: "Rankings no longer show whether buyers see you.", basis: "map" });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST …/content-plans/suggest-angle", () => {
  it("suggests an angle for the programme from what the wizard knows", async () => {
    const res = await POST(req({ questionId: "q_aaaaaaaa", situationId: "sit_aaaaaaaa" }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ spark: "Rankings no longer show whether buyers see you.", basis: "map" });
    expect(suggest.suggestAngle).toHaveBeenCalledWith(admin, { id: "ws1", name: "Blog" }, { name: "", question: "", questionId: "q_aaaaaaaa", situationId: "sit_aaaaaaaa", previous: "" });
  });

  it("is off until switched on, before anything else is read", async () => {
    vi.stubEnv("CREATE_SUGGEST_ANGLE_ENABLED", "false");
    const res = await POST(req({ name: "x" }), params);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "suggest_angle_disabled" });
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("refuses another site, a stranger, an unknown programme, a bad body and too many at once", async () => {
    expect((await POST(req({ name: "x" }, { origin: "https://evil.example" }), params)).status).toBe(403);
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await POST(req({ name: "x" }), params)).status).toBe(401);
    tenant.getById.mockResolvedValueOnce(null);
    expect((await POST(req({ name: "x" }), params)).status).toBe(404);
    expect((await POST(req({ name: 42 }), params)).status).toBe(400);
    tenant.isRateLimited.mockResolvedValueOnce(true);
    expect((await POST(req({ name: "x" }), params)).status).toBe(429);
    expect(suggest.suggestAngle).not.toHaveBeenCalled();
  });

  it("passes on why there's no suggestion", async () => {
    suggest.suggestAngle.mockResolvedValueOnce({ ok: false, status: 502, error: "suggest_failed" });
    const res = await POST(req({ name: "x" }), params);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "suggest_failed" });
  });
});
