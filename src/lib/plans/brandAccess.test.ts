import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tenant } from "@/lib/types/tenant";
import { brandCanUse, FEATURE_NEEDS, grantedOnlyFeatures, mayReachWith, METERED_FEATURES, tenantMayUse } from "./brandAccess";
import { INCLUDED_IN_EVERY_PLAN } from "./catalog";

const ctx = { tenantId: "ten_test" };

describe("brand access", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lets every brand use every feature when nothing is kept for granted brands", async () => {
    vi.stubEnv("GRANTED_ONLY_FEATURES", "");
    const load = vi.fn();
    expect(await brandCanUse(ctx, "edit_vizzy_learning", load)).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  it("reads the list with spaces and empty entries", () => {
    vi.stubEnv("GRANTED_ONLY_FEATURES", " edit_vizzy_learning, ,edit_vizzy ");
    expect([...grantedOnlyFeatures()].sort()).toEqual(["edit_vizzy", "edit_vizzy_learning"]);
  });

  it("keeps a listed feature for brands granted it", async () => {
    vi.stubEnv("GRANTED_ONLY_FEATURES", "edit_vizzy_learning");
    const granted = vi.fn(async () => ({ grantedFeatures: ["edit_vizzy_learning"] }) as never);
    const notGranted = vi.fn(async () => ({ grantedFeatures: ["something_else"] }) as never);
    expect(await brandCanUse(ctx, "edit_vizzy_learning", granted)).toBe(true);
    expect(await brandCanUse(ctx, "edit_vizzy_learning", notGranted)).toBe(false);
    expect(granted).toHaveBeenCalledWith("ten_test");
  });

  it("leaves a feature that isn't listed open while another is kept", async () => {
    vi.stubEnv("GRANTED_ONLY_FEATURES", "edit_vizzy_learning");
    const load = vi.fn(async () => null);
    expect(await brandCanUse(ctx, "edit_vizzy", load)).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  it("says no when the brand can't be read or has no grants", async () => {
    vi.stubEnv("GRANTED_ONLY_FEATURES", "edit_vizzy");
    expect(await brandCanUse(ctx, "edit_vizzy", async () => Promise.reject(new Error("down")))).toBe(false);
    expect(tenantMayUse(null, "edit_vizzy")).toBe(false);
    expect(tenantMayUse({}, "edit_vizzy")).toBe(false);
  });
});

describe("brand access with plans off", () => {
  afterEach(() => vi.unstubAllEnvs());

  /** Exactly the answer before plans: held back features need a grant, the rest are open. */
  const today = (granted: boolean, heldBack: boolean) => !heldBack || granted;

  it("gives exactly today's answers, whatever plan copy a brand carries", async () => {
    vi.stubEnv("PLANS_ENABLED", "false");
    for (const feature of METERED_FEATURES) {
      for (const granted of [false, true]) {
        for (const heldBack of [false, true]) {
          vi.stubEnv("GRANTED_ONLY_FEATURES", heldBack ? feature : "");
          for (const orgPlan of [undefined, "free", "platinum"] as const) {
            const tenant = { grantedFeatures: granted ? [feature] : [], orgPlan } as Pick<Tenant, "grantedFeatures" | "orgPlan">;
            const want = today(granted, heldBack);
            expect(tenantMayUse(tenant, feature), `${feature} granted=${granted} held=${heldBack} plan=${orgPlan}`).toBe(want);
            const load = vi.fn(async () => tenant as Tenant);
            expect(await brandCanUse(ctx, feature, load)).toBe(want);
            if (!heldBack) expect(load).not.toHaveBeenCalled();
          }
        }
      }
    }
  });
});

describe("brand access with plans on", () => {
  beforeEach(() => {
    vi.stubEnv("PLANS_ENABLED", "true");
    vi.stubEnv("GRANTED_ONLY_FEATURES", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  const on = (orgPlan: unknown, grantedFeatures: string[] = []) => ({ orgPlan, grantedFeatures }) as Pick<Tenant, "grantedFeatures" | "orgPlan">;

  it("follows the plan: included is yes, left out is no", async () => {
    expect(tenantMayUse(on("ultra"), "competitors")).toBe(true);
    expect(tenantMayUse(on("pro"), "competitors")).toBe(false);
    expect(tenantMayUse(on("pro"), "brand_search")).toBe(true);
    expect(tenantMayUse(on("pro"), "article_autopilot")).toBe(false);
    expect(tenantMayUse(on("ultra"), "article_autopilot")).toBe(true);
    expect(tenantMayUse(on("free"), "edit_vizzy")).toBe(false);
    expect(tenantMayUse(on("self_hosted"), "next_up")).toBe(true);
    expect(await brandCanUse(ctx, "next_up", async () => on("pro") as Tenant)).toBe(false);
    expect(await brandCanUse(ctx, "next_up", async () => on("ultra") as Tenant)).toBe(true);
  });

  it("lets a brand's own grant add a feature its plan lacks", async () => {
    expect(tenantMayUse(on("free", ["competitors"]), "competitors")).toBe(true);
    expect(await brandCanUse(ctx, "competitors", async () => on("free", ["competitors"]) as Tenant)).toBe(true);
  });

  it("still holds back a GRANTED_ONLY feature the plan includes, unless the brand is granted it", () => {
    vi.stubEnv("GRANTED_ONLY_FEATURES", "edit_vizzy_learning");
    expect(tenantMayUse(on("ultra"), "edit_vizzy_learning")).toBe(false);
    expect(tenantMayUse(on("ultra", ["edit_vizzy_learning"]), "edit_vizzy_learning")).toBe(true);
    expect(tenantMayUse(on("free", ["edit_vizzy_learning"]), "edit_vizzy_learning")).toBe(true);
  });

  it("is open with no plan copy or an unknown plan", () => {
    expect(tenantMayUse(on(undefined), "competitors")).toBe(true);
    expect(tenantMayUse(on("platinum"), "competitors")).toBe(true);
    expect(tenantMayUse({}, "next_up")).toBe(true);
    expect(tenantMayUse(null, "next_up")).toBe(true);
  });

  it("reads the brand unless every plan includes the feature", async () => {
    const load = vi.fn(async () => on("ultra") as Tenant);
    for (const feature of METERED_FEATURES) {
      load.mockClear();
      await brandCanUse(ctx, feature, load);
      expect(load.mock.calls.length, feature).toBe(INCLUDED_IN_EVERY_PLAN.includes(feature) ? 0 : 1);
    }
  });

  it("reaches the autopilot only with the Next up it needs, and leaves the autopilot's own check alone", () => {
    expect(FEATURE_NEEDS).toEqual({ article_autopilot: "next_up" });
    // No plan has the autopilot without Next up, but a brand's own grant can give it alone.
    expect(tenantMayUse(on("pro", ["article_autopilot"]), "article_autopilot")).toBe(true);
    expect(mayReachWith(on("pro", ["article_autopilot"]), "article_autopilot", true)).toBe(false);
    expect(mayReachWith(on("pro", ["article_autopilot", "next_up"]), "article_autopilot", true)).toBe(true);
    expect(mayReachWith(on("pro", ["next_up"]), "article_autopilot", true)).toBe(false);
    expect(mayReachWith(on("ultra"), "article_autopilot", true)).toBe(true);
    expect(mayReachWith(on("free", ["article_autopilot"]), "article_autopilot", true)).toBe(false);
    expect(mayReachWith(on("pro"), "article_autopilot", false)).toBe(true);
    vi.stubEnv("GRANTED_ONLY_FEATURES", "next_up");
    expect(mayReachWith(on("ultra"), "article_autopilot", true)).toBe(false);
    expect(mayReachWith(on("ultra", ["next_up"]), "article_autopilot", true)).toBe(true);
  });

  it("answers a failed read as no for a held back feature and yes otherwise", async () => {
    const down = async () => Promise.reject(new Error("down"));
    expect(await brandCanUse(ctx, "competitors", down)).toBe(true);
    vi.stubEnv("GRANTED_ONLY_FEATURES", "competitors");
    expect(await brandCanUse(ctx, "competitors", down)).toBe(false);
  });
});
