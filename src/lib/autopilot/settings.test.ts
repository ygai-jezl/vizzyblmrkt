import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/lib/tenant/types";
import { readAutopilotSettings, saveAutopilotSettings, type SettingsDeps } from "./adminApi";

const ADMIN: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const MEMBER: TenantContext = { ...ADMIN, role: "member" };

const deps = (over: Partial<SettingsDeps> = {}): SettingsDeps => ({
  canUse: async () => true,
  loadTenant: async () => ({ id: "ten_A", grantedFeatures: ["next_up"], featureLimits: { article_autopilot: 4 } }) as never,
  listProgrammes: async () => [{ id: "ws1", name: "Blog" }, { id: "ws2", name: "Product" }],
  drafts: async () => 1,
  lookups: async () => 12,
  save: vi.fn(async () => true),
  ...over,
});

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_NEXT_UP_ENABLED", "true");
  vi.stubEnv("CREATE_ARTICLE_AUTOPILOT_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("autopilot settings", () => {
  it("are off until set, and show this month's use against the caps", async () => {
    expect(await readAutopilotSettings(MEMBER, deps())).toMatchObject({
      status: 200,
      body: { settings: { mode: "off", weekday: 1, perWeek: 1, channels: ["linkedin", "x"] }, canDraft: true, month: { lookups: 12, lookupLimit: 100, drafts: 1, draftLimit: 4 } },
    });
    vi.stubEnv("CREATE_ARTICLE_AUTOPILOT_ENABLED", "false");
    expect(await readAutopilotSettings(MEMBER, deps())).toEqual({ status: 503, body: { error: "unavailable" } });
  });

  it("let only admins change them, Draft only with the feature and a programme", async () => {
    const d = deps();
    expect(await saveAutopilotSettings(MEMBER, { mode: "suggest" }, d)).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(await saveAutopilotSettings(ADMIN, { mode: "draft" }, d)).toEqual({ status: 400, body: { error: "programme_required" } });
    expect(await saveAutopilotSettings(ADMIN, { mode: "suggest", workspaceId: "ws_other" }, d)).toEqual({ status: 400, body: { error: "invalid_input" } });
    expect(await saveAutopilotSettings(ADMIN, { mode: "weekly" }, d)).toEqual({ status: 400, body: { error: "invalid_input" } });
    expect(await saveAutopilotSettings(ADMIN, { mode: "suggest", perWeek: 10 }, d)).toMatchObject({ status: 200, body: { settings: { perWeek: 10 } } });
    expect(await saveAutopilotSettings(ADMIN, { mode: "suggest", perWeek: 11 }, d)).toEqual({ status: 400, body: { error: "invalid_input" } });
    expect(await saveAutopilotSettings(ADMIN, { mode: "draft", workspaceId: "ws1", focus: "More agencies" }, d)).toMatchObject({ status: 200, body: { settings: { mode: "draft", workspaceId: "ws1" } } });
    expect(d.save).toHaveBeenCalledWith("ten_A", expect.objectContaining({ mode: "draft", focus: "More agencies" }));
    vi.stubEnv("GRANTED_ONLY_FEATURES", "next_up,article_autopilot");
    expect(await saveAutopilotSettings(ADMIN, { mode: "draft", workspaceId: "ws1" }, deps())).toEqual({ status: 403, body: { error: "not_included" } });
  });
});
