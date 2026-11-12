import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({
  find: vi.fn(),
  update: vi.fn(),
  isRateLimited: vi.fn(async () => false),
  getTenantById: vi.fn(),
}));
vi.mock("@/lib/tenant", () => ({
  forTenant: () => ({ members: { find: tenant.find, update: tenant.update } }),
  isRateLimited: tenant.isRateLimited,
  getTenantById: tenant.getTenantById,
}));
const bank = vi.hoisted(() => ({
  listEditMemories: vi.fn(),
  forgetAllEditMemories: vi.fn(),
  forgetEditMemory: vi.fn(),
  getEditMemory: vi.fn(),
  learnFromEdits: vi.fn(),
  isMemoryBankConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/agents/memoryBank", () => bank);
const control = vi.hoisted(() => ({ appendBrandVoiceRule: vi.fn() }));
vi.mock("@/lib/tenant/control", () => control);

const memories = await import("./memories/route");
const one = await import("./memories/[memoryId]/route");
const brandVoice = await import("./memories/[memoryId]/brand-voice/route");
const learn = await import("./learn/route");
const settings = await import("./settings/route");

const member = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "member" };
const admin = { ...member, role: "admin" };

const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/admin/editor/vizzy/memories", {
    method,
    headers: { "content-type": "application/json", host: "localhost", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const params = (memoryId: string) => ({ params: Promise.resolve({ memoryId }) });
const entry = { instruction: "shorter", kind: "selection", outcome: "kept", before: "a long line", after: "a line" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_EDIT_MODE_VIZZY_ENABLED", "true");
  vi.stubEnv("EDIT_MODE_VIZZY_LEARNING_ENABLED", "true");
  vi.stubEnv("BRAND_VOICE_ENABLED", "true");
  vi.stubEnv("GRANTED_ONLY_FEATURES", "");
  session.getAdminContext.mockResolvedValue(member);
  tenant.find.mockResolvedValue([{ id: "m1", userId: "u1", tenantId: "ten_A", role: "member", joinedAt: "x" }]);
  tenant.isRateLimited.mockResolvedValue(false);
  bank.isMemoryBankConfigured.mockReturnValue(true);
  bank.listEditMemories.mockResolvedValue([{ id: "1", text: "Keeps intros short.", source: "learned", createdAt: null }]);
});
afterEach(() => vi.unstubAllEnvs());

describe("the learning routes", () => {
  it("list the person's memories and whether they learn", async () => {
    const res = await memories.GET(req("GET"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ learn: true, memories: [{ id: "1", text: "Keeps intros short." }] });
    expect(bank.listEditMemories).toHaveBeenCalledWith(member);
  });

  it("are off until both switches are on, before anything is read", async () => {
    vi.stubEnv("EDIT_MODE_VIZZY_LEARNING_ENABLED", "false");
    const res = await memories.GET(req("GET"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "learning_disabled" });
    vi.stubEnv("EDIT_MODE_VIZZY_LEARNING_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_EDIT_MODE_VIZZY_ENABLED", "false");
    expect((await memories.GET(req("GET"))).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("refuse another site, a stranger, a copy without Memory Bank and a brand without it", async () => {
    expect((await memories.GET(req("GET", undefined, { origin: "https://evil.example" }))).status).toBe(403);
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await memories.GET(req("GET"))).status).toBe(401);
    bank.isMemoryBankConfigured.mockReturnValueOnce(false);
    expect(await (await memories.GET(req("GET"))).json()).toEqual({ error: "learning_not_configured" });
    vi.stubEnv("GRANTED_ONLY_FEATURES", "edit_vizzy_learning");
    tenant.getTenantById.mockResolvedValueOnce({ grantedFeatures: [] });
    const res = await memories.GET(req("GET"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_included" });
    expect(bank.listEditMemories).not.toHaveBeenCalled();
  });

  it("forget one memory, or all, and say not found for one that isn't the person's", async () => {
    bank.forgetEditMemory.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await one.DELETE(req("DELETE"), params("1"))).status).toBe(200);
    expect((await one.DELETE(req("DELETE"), params("9"))).status).toBe(404);
    expect(bank.forgetEditMemory).toHaveBeenCalledWith(member, "9");
    bank.forgetAllEditMemories.mockResolvedValueOnce(3);
    expect(await (await memories.DELETE(req("DELETE"))).json()).toEqual({ forgotten: 3 });
  });

  it("learn from a visit, unless the person switched it off", async () => {
    const res = await learn.POST(req("POST", { entries: [entry] }));
    expect(res.status).toBe(202);
    expect(bank.learnFromEdits).toHaveBeenCalledWith(member, [entry]);
    expect(tenant.isRateLimited).toHaveBeenCalledWith("user:ten_A:u1", expect.objectContaining({ prefix: "edit_vizzy_learn" }));

    tenant.find.mockResolvedValueOnce([{ id: "m1", userId: "u1", tenantId: "ten_A", role: "member", joinedAt: "x", editLearningOff: true }]);
    expect(await (await learn.POST(req("POST", { entries: [entry] }))).json()).toEqual({ learned: false, reason: "learning_off" });
    expect(bank.learnFromEdits).toHaveBeenCalledTimes(1);

    expect((await learn.POST(req("POST", { entries: [] }))).status).toBe(400);
  });

  it("store the person's choice on their own membership", async () => {
    expect(await (await settings.PUT(req("PUT", { learn: false }))).json()).toEqual({ learn: false });
    expect(tenant.find).toHaveBeenCalledWith({ where: [["userId", "==", "u1"]], limit: 1 });
    expect(tenant.update).toHaveBeenCalledWith("m1", { editLearningOff: true });
    tenant.find.mockResolvedValueOnce([]);
    expect((await settings.PUT(req("PUT", { learn: true }))).status).toBe(404);
  });

  it("let only an admin add their own memory to the brand voice", async () => {
    expect((await brandVoice.POST(req("POST"), params("1"))).status).toBe(403);
    session.getAdminContext.mockResolvedValue(admin);
    bank.getEditMemory.mockResolvedValueOnce(null);
    expect((await brandVoice.POST(req("POST"), params("9"))).status).toBe(404);
    bank.getEditMemory.mockResolvedValue({ id: "1", text: "Keeps intros short.", source: "learned", createdAt: null });
    control.appendBrandVoiceRule.mockResolvedValueOnce("added").mockResolvedValueOnce("full");
    expect(await (await brandVoice.POST(req("POST"), params("1"))).json()).toEqual({ added: true });
    expect(control.appendBrandVoiceRule).toHaveBeenCalledWith("ten_A", "Keeps intros short.");
    expect((await brandVoice.POST(req("POST"), params("1"))).status).toBe(409);
  });
});
