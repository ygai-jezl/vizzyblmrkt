import { afterEach, describe, expect, it, vi } from "vitest";
import { brandCanUse, grantedOnlyFeatures, tenantMayUse } from "./brandAccess";

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
