import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getAdminContext: vi.fn() }));
const tenant = vi.hoisted(() => ({ find: vi.fn(), getTenantById: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ forTenant: () => ({ members: { find: tenant.find } }), getTenantById: tenant.getTenantById }));
const bank = vi.hoisted(() => ({ listEditMemories: vi.fn(), isMemoryBankConfigured: vi.fn(() => true) }));
vi.mock("@/lib/agents/memoryBank", () => bank);

const { editPreferencesFor } = await import("./vizzyLearningAccess");

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
    expect(await editPreferencesFor(me)).toEqual(["Keeps intros short."]);
  });

  it("are none when learning is off anywhere: the switch, the brand, the person", async () => {
    vi.stubEnv("EDIT_MODE_VIZZY_LEARNING_ENABLED", "false");
    expect(await editPreferencesFor(me)).toEqual([]);
    vi.stubEnv("EDIT_MODE_VIZZY_LEARNING_ENABLED", "true");
    vi.stubEnv("GRANTED_ONLY_FEATURES", "edit_vizzy_learning");
    tenant.getTenantById.mockResolvedValueOnce({ grantedFeatures: [] });
    expect(await editPreferencesFor(me)).toEqual([]);
    vi.stubEnv("GRANTED_ONLY_FEATURES", "");
    tenant.find.mockResolvedValueOnce([{ id: "m1", userId: "u1", editLearningOff: true }]);
    expect(await editPreferencesFor(me)).toEqual([]);
    expect(bank.listEditMemories).not.toHaveBeenCalled();
  });

  it("never fail an edit or hold it up", async () => {
    bank.listEditMemories.mockRejectedValueOnce(new Error("memory_bank_500"));
    expect(await editPreferencesFor(me)).toEqual([]);
    vi.useFakeTimers();
    bank.listEditMemories.mockReturnValueOnce(new Promise(() => {}));
    const waiting = editPreferencesFor(me);
    await vi.advanceTimersByTimeAsync(1600);
    expect(await waiting).toEqual([]);
  });
});
