import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getAdminContext: vi.fn() }));
const tenant = vi.hoisted(() => ({ find: vi.fn(), getTenantById: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ forTenant: () => ({ members: { find: tenant.find } }), getTenantById: tenant.getTenantById }));
const bank = vi.hoisted(() => ({ listEditMemories: vi.fn(), isMemoryBankConfigured: vi.fn(() => true) }));
vi.mock("@/lib/agents/memoryBank", () => bank);

const { editPreferencesFor, learningAccess } = await import("./vizzyLearningAccess");

const me = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "member" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_EDIT_MODE_VIZZY_ENABLED", "true");
  vi.stubEnv("EDIT_MODE_VIZZY_LEARNING_ENABLED", "true");
  vi.stubEnv("GRANTED_ONLY_FEATURES", "");
  tenant.find.mockResolvedValue([{ id: "m1", userId: "u1" }]);
  bank.isMemoryBankConfigured.mockReturnValue(true);
  bank.listEditMemories.mockResolvedValue([{ id: "1", text: "Keeps intros short.", source: "learned", createdAt: null }]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("the person's preferences for an edit", () => {
  it("are their memories when learning is on for them", async () => {
    expect(await editPreferencesFor(me, "edit_mode")).toEqual(["Keeps intros short."]);
  });

  it("are none when learning is off anywhere: the switch, the brand, the person", async () => {
    vi.stubEnv("EDIT_MODE_VIZZY_LEARNING_ENABLED", "false");
    expect(await editPreferencesFor(me, "edit_mode")).toEqual([]);
    vi.stubEnv("EDIT_MODE_VIZZY_LEARNING_ENABLED", "true");
    vi.stubEnv("GRANTED_ONLY_FEATURES", "edit_vizzy_learning");
    tenant.getTenantById.mockResolvedValueOnce({ grantedFeatures: [] });
    expect(await editPreferencesFor(me, "edit_mode")).toEqual([]);
    vi.stubEnv("GRANTED_ONLY_FEATURES", "");
    tenant.find.mockResolvedValueOnce([{ id: "m1", userId: "u1", editLearningOff: true }]);
    expect(await editPreferencesFor(me, "edit_mode")).toEqual([]);
    expect(bank.listEditMemories).not.toHaveBeenCalled();
  });

  it("never fail an edit or hold it up", async () => {
    bank.listEditMemories.mockRejectedValueOnce(new Error("memory_bank_500"));
    expect(await editPreferencesFor(me, "edit_mode")).toEqual([]);
    vi.useFakeTimers();
    bank.listEditMemories.mockReturnValueOnce(new Promise(() => {}));
    const waiting = editPreferencesFor(me, "edit_mode");
    await vi.advanceTimersByTimeAsync(1600);
    expect(await waiting).toEqual([]);
  });
});

describe("which brands may learn from edits", () => {
  const plan = (orgPlan: string, over: Record<string, unknown> = {}) => vi.fn(async () => ({ id: "ten_A", orgPlan, grantedFeatures: [], ...over }) as never);
  const us = { tenantId: "ten_A", region: "us" } as const;
  const eu = { tenantId: "ten_A", region: "eu" } as const;

  beforeEach(() => vi.stubEnv("PLANS_ENABLED", "true"));

  it("needs the learning key for every kind with the switch off, exactly as before", async () => {
    expect(await learningAccess(us, "edit_mode", plan("pro"))).toMatchObject({ ok: false, reason: "plan" });
    expect(await learningAccess(eu, "edit_mode", plan("pro"))).toMatchObject({ ok: false, reason: "plan" });
    expect(await learningAccess(us, "edit_mode", plan("ultra"))).toMatchObject({ ok: true, via: "learning_key" });
    expect(await learningAccess(us, "content_write", plan("pro"))).toMatchObject({ ok: false, reason: "plan" });
    expect(await learningAccess(us, "edit_mode", plan("pro", { grantedFeatures: ["edit_vizzy_learning"] }))).toMatchObject({ ok: true });
  });

  describe("with Edit mode learning following Vizzy", () => {
    beforeEach(() => vi.stubEnv("EDIT_MODE_LEARNING_FOLLOWS_VIZZY_ENABLED", "true"));

    it("lets a brand with Vizzy in Edit mode in the agent's region learn without the key", async () => {
      const load = plan("pro");
      const access = await learningAccess(us, "edit_mode", load);
      expect(access).toMatchObject({ ok: true, via: "edit_vizzy", facts: { plan: "pro", editVizzy: true, region: "us", agentRegion: "us" } });
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("keeps a brand in another region out with reason region", async () => {
      expect(await learningAccess(eu, "edit_mode", plan("pro"))).toMatchObject({ ok: false, reason: "region", facts: { region: "eu", agentRegion: "us" } });
      vi.stubEnv("ROOT_AGENT_LOCATION", "europe-west4");
      expect(await learningAccess(eu, "edit_mode", plan("pro"))).toMatchObject({ ok: true, via: "edit_vizzy" });
      expect(await learningAccess(us, "edit_mode", plan("pro"))).toMatchObject({ ok: false, reason: "region" });
      vi.stubEnv("ROOT_AGENT_LOCATION", "australia-southeast1");
      expect(await learningAccess(us, "edit_mode", plan("pro"))).toMatchObject({ ok: false, reason: "region" });
    });

    it("leaves a brand without Vizzy in Edit mode, and every post, on the key", async () => {
      expect(await learningAccess(us, "edit_mode", plan("free"))).toMatchObject({ ok: false, reason: "plan", facts: { editVizzy: false } });
      expect(await learningAccess(us, "content_write", plan("pro"))).toMatchObject({ ok: false, reason: "plan" });
      expect((await learningAccess(us, "content_write", plan("pro"))).facts).not.toHaveProperty("editVizzy");
    });

    it("keeps the key's own brands learning in any region", async () => {
      expect(await learningAccess(eu, "edit_mode", plan("ultra"))).toMatchObject({ ok: true, via: "learning_key" });
      expect(await learningAccess(eu, "content_write", plan("ultra"))).toMatchObject({ ok: true, via: "learning_key" });
    });

    it("follows every hold on Vizzy in Edit mode, and none on the learning key", async () => {
      vi.stubEnv("GRANTED_ONLY_FEATURES", "edit_vizzy");
      expect(await learningAccess(us, "edit_mode", plan("pro"))).toMatchObject({ ok: false, reason: "plan" });
      expect(await learningAccess(us, "edit_mode", plan("pro", { grantedFeatures: ["edit_vizzy"] }))).toMatchObject({ ok: true, via: "edit_vizzy" });
      vi.stubEnv("GRANTED_ONLY_FEATURES", "edit_vizzy_learning");
      expect(await learningAccess(us, "edit_mode", plan("pro"))).toMatchObject({ ok: true, via: "edit_vizzy", facts: { grantedOnly: true, granted: false } });
      expect(await learningAccess(us, "content_write", plan("ultra"))).toMatchObject({ ok: false, reason: "plan" });
    });

    it("does nothing without Edit mode's learning switch", async () => {
      vi.stubEnv("EDIT_MODE_VIZZY_LEARNING_ENABLED", "false");
      expect(await learningAccess(us, "edit_mode", plan("pro"))).toMatchObject({ ok: false, reason: "plan" });
    });

    it("gives Edit mode the person's preferences, and post drafts none, for the same brand", async () => {
      tenant.getTenantById.mockResolvedValue({ id: "ten_A", orgPlan: "pro", grantedFeatures: [] });
      expect(await editPreferencesFor(me, "edit_mode")).toEqual(["Keeps intros short."]);
      expect(await editPreferencesFor(me, "content_write")).toEqual([]);
      tenant.find.mockResolvedValueOnce([{ id: "m1", userId: "u1", editLearningOff: true }]);
      expect(await editPreferencesFor(me, "edit_mode")).toEqual([]);
      expect(await editPreferencesFor({ ...me, region: "eu" }, "edit_mode")).toEqual([]);
      expect(bank.listEditMemories).toHaveBeenCalledTimes(1);
    });
  });
});

