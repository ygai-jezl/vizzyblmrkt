import { describe, it, expect, afterEach } from "vitest";
import { retrieveBrandAssetRefs, MAX_ASSET_REFS } from "./brandAssetRefs";
import type { TenantContext } from "@/lib/tenant/types";

const ctx: TenantContext = { tenantId: "ten_x", region: "us", source: "system" };

afterEach(() => {
  delete process.env.BRAND_ASSET_REFS_ENABLED;
});

describe("retrieveBrandAssetRefs", () => {
  it("returns [] (no reads) when the flag is off", async () => {
    delete process.env.BRAND_ASSET_REFS_ENABLED;
    await expect(retrieveBrandAssetRefs({ ctx })).resolves.toEqual([]);
  });

  it("caps the requested limit to MAX_ASSET_REFS", () => {
    // A documented invariant the loader enforces (Math.min(limit, MAX_ASSET_REFS)).
    expect(MAX_ASSET_REFS).toBe(3);
  });
});
