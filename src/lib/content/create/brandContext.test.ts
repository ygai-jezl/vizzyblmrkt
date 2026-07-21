import { describe, it, expect } from "vitest";
import { assembleBrandContext, layoutPaletteHexes, resolveBrandVoiceText } from "./brandContext";
import type { EmailLayout } from "@/lib/types/emailLayout";

describe("assembleBrandContext", () => {
  it("returns '' when there is nothing to say (fully null)", () => {
    expect(assembleBrandContext({})).toBe("");
    expect(assembleBrandContext({ brandKit: {} })).toBe("");
  });

  it("is null-tolerant — includes only present fields, fenced as untrusted", () => {
    const out = assembleBrandContext({
      brandVoice: "warm and direct",
      brandKit: { tone: "confident", palette: [{ hex: "#112233", name: "Primary" }], donts: ["no clip art"] },
    });
    expect(out).toContain("<brand_context>");
    expect(out).toContain("UNTRUSTED DATA");
    expect(out).toContain("warm and direct");
    expect(out).toContain("confident");
    expect(out).toContain("#112233");
    expect(out).toContain("no clip art");
    // absent fields are simply omitted
    expect(out).not.toContain("Fonts:");
    expect(out).not.toContain("Audience:");
  });

  it("harvests the layout's own colours into the palette", () => {
    const layout: EmailLayout = {
      blocks: [
        { id: "b", kind: "button", label: "x", href: "", align: "center", bg: "#abcdef", color: "#ffffff", radius: 8 },
        { id: "h", kind: "heading", html: "Hi", level: 2, align: "left", sectionBg: "#123456" },
      ],
    };
    expect(layoutPaletteHexes(layout).sort()).toEqual(["#123456", "#abcdef", "#ffffff"].sort());
    const out = assembleBrandContext({ layout });
    expect(out).toContain("#abcdef");
    expect(out).toContain("#123456");
  });
});

describe("resolveBrandVoiceText", () => {
  it("the authored tenant-global voice wins over the legacy workspace free text", () => {
    const out = resolveBrandVoiceText({
      tenantBrandVoice: { summary: "Confident and warm", dos: ["Be clear"] },
      workspaceBrandVoice: "legacy workspace blurb",
    });
    expect(out).toContain("Summary: Confident and warm");
    expect(out).toContain("Do: Be clear");
    expect(out).not.toContain("legacy workspace blurb");
  });

  it("falls back to the legacy workspace voice when no global voice is authored", () => {
    expect(
      resolveBrandVoiceText({ tenantBrandVoice: null, workspaceBrandVoice: "legacy blurb" }),
    ).toBe("legacy blurb");
    // An empty/whitespace-only global voice does NOT shadow the workspace fallback.
    expect(
      resolveBrandVoiceText({ tenantBrandVoice: { summary: "   " }, workspaceBrandVoice: "legacy" }),
    ).toBe("legacy");
  });

  it("returns null when neither is set (byte-identical to today's behaviour)", () => {
    expect(resolveBrandVoiceText({})).toBeNull();
    expect(resolveBrandVoiceText({ tenantBrandVoice: {}, workspaceBrandVoice: "  " })).toBeNull();
  });
});
