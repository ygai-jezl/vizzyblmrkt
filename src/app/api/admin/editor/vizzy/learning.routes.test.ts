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

describe("the learn route's loop_learn line", () => {
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  const signedIn = { ...member, email: "someone@example.com" };
  const linesLogged = () =>
    [...info.mock.calls, ...warn.mock.calls]
      .map((c) => String(c[0]))
      .filter((s) => s.startsWith("{"))
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((l) => l.event === "loop_learn");
  const onlyLine = () => {
    const all = linesLogged();
    expect(all).toHaveLength(1);
    const raw = JSON.stringify(all[0]);
    for (const secret of ["shorter", "a long line", "a line\"", "u1", "someone@example.com", "Keeps intros"]) expect(raw).not.toContain(secret);
    return all[0]!;
  };
  const close = (body: unknown) => learn.POST(req("POST", body));

  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    session.getAdminContext.mockResolvedValue(signedIn);
  });
  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
  });

  it("says what it learned, with the brand and never the person or the words", async () => {
    expect((await close({ entries: [entry, entry] })).status).toBe(202);
    expect(onlyLine()).toEqual({
      severity: "INFO",
      message: "[loops] edit_mode learned",
      event: "loop_learn",
      kind: "edit_mode",
      outcome: "learned",
      reason: null,
      tenantId: "ten_A",
      plan: "plans_off",
      granted: null,
      grantedOnly: false,
      region: "us",
      agentRegion: "us",
      editVizzy: true,
      via: "learning_key",
      entries: 2,
    });
  });

  it("logs the switch once a signed in person closes, and answers as before", async () => {
    vi.stubEnv("EDIT_MODE_VIZZY_LEARNING_ENABLED", "false");
    const res = await close({ entries: [entry] });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "learning_disabled" });
    expect(onlyLine()).toMatchObject({ outcome: "skipped", reason: "switch", entries: 1 });
    expect(bank.learnFromEdits).not.toHaveBeenCalled();
  });

  it("logs nothing for a body that isn't a close, or a stranger", async () => {
    vi.stubEnv("EDIT_MODE_VIZZY_LEARNING_ENABLED", "false");
    expect((await close({ nope: true })).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
    vi.stubEnv("EDIT_MODE_VIZZY_LEARNING_ENABLED", "true");
    expect((await close({ entries: [] })).status).toBe(400);
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await close({ entries: [entry] })).status).toBe(401);
    expect(linesLogged()).toEqual([]);
  });

  it("logs a copy without Memory Bank", async () => {
    bank.isMemoryBankConfigured.mockReturnValue(false);
    expect(await (await close({ entries: [entry] })).json()).toEqual({ error: "learning_not_configured" });
    expect(onlyLine()).toMatchObject({ outcome: "skipped", reason: "not_configured" });
  });

  it("logs the plan, with the grant and the hold, from one read of the brand", async () => {
    vi.stubEnv("GRANTED_ONLY_FEATURES", "edit_vizzy_learning");
    tenant.getTenantById.mockResolvedValueOnce({ grantedFeatures: [] });
    const res = await close({ entries: [entry] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_included" });
    expect(onlyLine()).toMatchObject({ reason: "plan", plan: "plans_off", granted: false, grantedOnly: true });
    expect(tenant.getTenantById).toHaveBeenCalledTimes(1);

    info.mockClear();
    vi.stubEnv("GRANTED_ONLY_FEATURES", "");
    vi.stubEnv("PLANS_ENABLED", "true");
    tenant.getTenantById.mockResolvedValue({ orgPlan: "pro", grantedFeatures: [] });
    expect((await close({ skipped: 3 })).status).toBe(403);
    expect(onlyLine()).toMatchObject({ reason: "plan", plan: "pro", granted: false, grantedOnly: false, editVizzy: true, entries: 3 });
    expect(tenant.getTenantById).toHaveBeenCalledTimes(2);
  });

  it("logs the person's own choice, for their changes or only their count", async () => {
    const off = [{ id: "m1", userId: "u1", tenantId: "ten_A", role: "member", joinedAt: "x", editLearningOff: true }];
    tenant.find.mockResolvedValueOnce(off);
    expect(await (await close({ entries: [entry] })).json()).toEqual({ learned: false, reason: "learning_off" });
    expect(onlyLine()).toMatchObject({ reason: "off_by_person" });
    info.mockClear();
    tenant.find.mockResolvedValueOnce(off);
    expect(await (await close({ skipped: 2 })).json()).toEqual({ learned: false, reason: "learning_off" });
    expect(onlyLine()).toMatchObject({ reason: "off_by_person", entries: 2 });
    expect(bank.learnFromEdits).not.toHaveBeenCalled();
  });

  it("logs the person's choice failing to load as one error, and learns nothing", async () => {
    tenant.find.mockRejectedValueOnce(new Error("firestore unavailable for someone@example.com"));
    const res = await close({ entries: [entry] });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "memory_unavailable" });
    expect(onlyLine()).toMatchObject({ severity: "WARNING", outcome: "skipped", reason: "error", code: "other", entries: 1 });
    expect(bank.learnFromEdits).not.toHaveBeenCalled();
  });

  it("logs a count when learning was on but the page couldn't offer it, and learns nothing", async () => {
    expect(await (await close({ skipped: 4 })).json()).toEqual({ learned: false, reason: "not_loaded" });
    expect(onlyLine()).toMatchObject({ severity: "WARNING", reason: "error", code: "not_loaded", entries: 4 });
    expect(bank.learnFromEdits).not.toHaveBeenCalled();
    expect(tenant.isRateLimited).not.toHaveBeenCalled();
  });

  it("logs the rate limit as budget", async () => {
    tenant.isRateLimited.mockResolvedValueOnce(true);
    expect((await close({ entries: [entry] })).status).toBe(429);
    expect(onlyLine()).toMatchObject({ reason: "budget" });
  });

  it("logs Memory Bank failing as an error code, never its message", async () => {
    bank.learnFromEdits.mockRejectedValueOnce(new Error("memory_bank_404"));
    expect((await close({ entries: [entry] })).status).toBe(502);
    expect(onlyLine()).toMatchObject({ severity: "WARNING", reason: "error", code: "memory_bank_404" });
    warn.mockClear();
    bank.learnFromEdits.mockRejectedValueOnce(new Error("upstream said: a long line about someone@example.com"));
    expect((await close({ entries: [entry] })).status).toBe(502);
    expect(onlyLine()).toMatchObject({ reason: "error", code: "other" });
  });

  it("is written only by the learn route", async () => {
    await memories.GET(req("GET"));
    await settings.PUT(req("PUT", { learn: false }));
    expect(linesLogged()).toEqual([]);
  });

  it("leaves a list Memory Bank fails its own line with the bank's code, so not_loaded can be told apart", async () => {
    const listLines = () =>
      warn.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.startsWith("{"))
        .map((s) => JSON.parse(s) as Record<string, unknown>)
        .filter((l) => l.event === "memory_list_failed");
    bank.listEditMemories.mockRejectedValueOnce(new Error("memory_bank_403"));
    expect((await memories.GET(req("GET"))).status).toBe(502);
    expect(listLines()).toEqual([
      {
        severity: "WARNING",
        message: "[loops] memory list failed: memory_bank_403",
        event: "memory_list_failed",
        tenantId: "ten_A",
        region: "us",
        agentRegion: "us",
        code: "memory_bank_403",
      },
    ]);
    expect(linesLogged()).toEqual([]);
    for (const secret of ["u1", "someone@example.com"]) expect(JSON.stringify(listLines())).not.toContain(secret);
    warn.mockClear();
    bank.listEditMemories.mockResolvedValueOnce([]);
    expect((await memories.GET(req("GET"))).status).toBe(200);
    expect(listLines()).toEqual([]);
  });
});

describe("with Edit mode learning following Vizzy", () => {
  let info: ReturnType<typeof vi.spyOn>;
  const lines = () =>
    info.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const pro = { id: "ten_A", orgPlan: "pro", grantedFeatures: [] };

  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubEnv("PLANS_ENABLED", "true");
    tenant.getTenantById.mockResolvedValue(pro);
  });
  afterEach(() => info.mockRestore());

  it("changes nothing while the switch is off", async () => {
    expect(await (await memories.GET(req("GET"))).json()).toEqual({ error: "not_included" });
    expect((await learn.POST(req("POST", { entries: [entry] }))).status).toBe(403);
    expect(bank.learnFromEdits).not.toHaveBeenCalled();
    expect(lines()).toEqual([expect.objectContaining({ reason: "plan", plan: "pro", editVizzy: true })]);
  });

  it("lets a Pro brand in the agent's region see, forget and learn", async () => {
    vi.stubEnv("EDIT_MODE_LEARNING_FOLLOWS_VIZZY_ENABLED", "true");
    expect((await memories.GET(req("GET"))).status).toBe(200);
    bank.forgetAllEditMemories.mockResolvedValueOnce(1);
    expect(await (await memories.DELETE(req("DELETE"))).json()).toEqual({ forgotten: 1 });
    expect((await learn.POST(req("POST", { entries: [entry] }))).status).toBe(202);
    expect(bank.learnFromEdits).toHaveBeenCalledWith(member, [entry]);
    expect(lines()).toEqual([expect.objectContaining({ outcome: "learned", via: "edit_vizzy", plan: "pro", region: "us", agentRegion: "us" })]);
  });

  it("keeps a brand in another region out with not_in_region, logged as region", async () => {
    vi.stubEnv("EDIT_MODE_LEARNING_FOLLOWS_VIZZY_ENABLED", "true");
    session.getAdminContext.mockResolvedValue({ ...member, region: "eu" });
    expect(await (await memories.GET(req("GET"))).json()).toEqual({ error: "not_in_region" });
    const res = await learn.POST(req("POST", { entries: [entry] }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_in_region" });
    expect(bank.learnFromEdits).not.toHaveBeenCalled();
    expect(lines()).toEqual([expect.objectContaining({ outcome: "skipped", reason: "region", region: "eu", agentRegion: "us" })]);
  });

  it("still follows the person's choice and Edit mode's learning switch", async () => {
    vi.stubEnv("EDIT_MODE_LEARNING_FOLLOWS_VIZZY_ENABLED", "true");
    tenant.find.mockResolvedValueOnce([{ id: "m1", userId: "u1", tenantId: "ten_A", role: "member", joinedAt: "x", editLearningOff: true }]);
    expect(await (await learn.POST(req("POST", { entries: [entry] }))).json()).toEqual({ learned: false, reason: "learning_off" });
    vi.stubEnv("EDIT_MODE_VIZZY_LEARNING_ENABLED", "false");
    expect(await (await learn.POST(req("POST", { entries: [entry] }))).json()).toEqual({ error: "learning_disabled" });
    expect(bank.learnFromEdits).not.toHaveBeenCalled();
    expect(lines().map((l) => l.reason)).toEqual(["off_by_person", "switch"]);
  });
});

