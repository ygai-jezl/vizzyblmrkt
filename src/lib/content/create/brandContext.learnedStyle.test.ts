import { describe, it, expect } from "vitest";
import { assembleBrandContext } from "./brandContext";
import type { BrandKit } from "@/lib/types/tenant";

const kit = (over: Partial<BrandKit> = {}): BrandKit => ({
  summary: "Acme",
  learnedImageStyle: "soft daylight, muted palette, candid people",
  ...over,
});

describe("assembleBrandContext — learned image style (feedback loop)", () => {
  it("auto-includes the kit's learned style when the field is absent (automatic apply)", () => {
    const out = assembleBrandContext({ brandKit: kit() });
    expect(out).toContain("Learned brand image style");
    expect(out).toContain("soft daylight, muted palette, candid people");
  });

  it("SUPPRESSES the learned style when passed an explicit null (override off)", () => {
    const out = assembleBrandContext({ brandKit: kit(), learnedImageStyle: null });
    expect(out).not.toContain("Learned brand image style");
    // ...but the rest of the brand context is still emitted.
    expect(out).toContain("Acme");
  });

  it("uses an explicit string over the kit's stored value", () => {
    const out = assembleBrandContext({ brandKit: kit(), learnedImageStyle: "bold neon 3d render" });
    expect(out).toContain("bold neon 3d render");
    expect(out).not.toContain("soft daylight");
  });

  it("emits nothing extra when there is no learned style anywhere", () => {
    const out = assembleBrandContext({ brandKit: kit({ learnedImageStyle: null }) });
    expect(out).not.toContain("Learned brand image style");
  });

  it("keeps the learned style INSIDE the untrusted-data fence", () => {
    const out = assembleBrandContext({ brandKit: kit() });
    const fenceStart = out.indexOf("<brand_context>");
    const fenceEnd = out.indexOf("</brand_context>");
    const learnedAt = out.indexOf("Learned brand image style");
    expect(learnedAt).toBeGreaterThan(fenceStart);
    expect(learnedAt).toBeLessThan(fenceEnd);
  });
});
