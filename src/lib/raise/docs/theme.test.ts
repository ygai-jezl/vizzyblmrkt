import { describe, expect, it } from "vitest";
import type { BrandKit, BrandTypography } from "@/lib/types/tenant";
import { ACME } from "./testing/fixtures";
import { DEFAULT_ACCENT, contrastOnWhite, deckThemeFor, loadDeckTheme } from "./theme";

const kit = (palette: BrandKit["palette"], fonts?: string[]): BrandKit => ({ palette, ...(fonts ? { fonts } : {}) });

describe("the starter look", () => {
  it("takes the primary colour, then accent, then the first, then a default", () => {
    const base = { tenantId: "ten_acme" };
    expect(deckThemeFor({ ...base, brandKit: kit([{ hex: "#111111" }, { hex: "#0055aa", role: "Primary" }, { hex: "#aa0055", role: "accent" }]) }).accent).toBe("#0055AA");
    expect(deckThemeFor({ ...base, brandKit: kit([{ hex: "#111111" }, { hex: "#aa0055", role: "accent" }]) }).accent).toBe("#AA0055");
    expect(deckThemeFor({ ...base, brandKit: kit([{ hex: "nope" }, { hex: "#226633" }]) }).accent).toBe("#226633");
    expect(deckThemeFor(base).accent).toBe(DEFAULT_ACCENT);
  });

  it("darkens a light accent for text until it reads on white, and keeps a dark one", () => {
    const light = deckThemeFor({ tenantId: "ten_acme", brandKit: kit([{ hex: "#FFD54F", role: "primary" }]) });
    expect(light.accent).toBe("#FFD54F");
    expect(contrastOnWhite(light.accentText)).toBeGreaterThanOrEqual(3);
    expect(light.accentText).not.toBe(light.accent);
    expect(light.accentInk).toBe("#111114");
    const dark = deckThemeFor({ tenantId: "ten_acme", brandKit: kit([{ hex: "#123456", role: "primary" }]) });
    expect(dark.accentText).toBe("#123456");
    expect(dark.accentInk).toBe("#FFFFFF");
  });

  it("takes fonts from the text styles, then the kit's fonts, then Inter", () => {
    const typography: BrandTypography = { styles: [{ id: "1", name: "Title", role: "title", fontFamily: "Fraunces" }, { id: "2", name: "Body", role: "body", fontFamily: "Work Sans" }] };
    const styled = deckThemeFor({ tenantId: "ten_acme", brandTypography: typography, brandKit: kit([], ["Lora", "Karla"]) });
    expect(styled.headingFont).toContain("Fraunces");
    expect(styled.bodyFont).toContain("Work Sans");
    const fromKit = deckThemeFor({ tenantId: "ten_acme", brandKit: kit([], ["Lora", "Karla"]) });
    expect(fromKit.headingFont).toContain("Lora");
    expect(fromKit.bodyFont).toContain("Karla");
    expect(deckThemeFor({ tenantId: "ten_acme" }).headingFont).toContain("Inter");
  });

  it("loads the brand's own uploaded fonts with safe names, and only those it uses", () => {
    const typography: BrandTypography = { styles: [{ id: "1", name: "Heading", role: "heading", fontFamily: "Acme Sans" }] };
    const t = deckThemeFor({
      tenantId: "ten_acme",
      brandTypography: typography,
      fonts: [
        { family: "Acme Sans", filename: "0f8fad5b-d9cb-469f-a165-70867728950e.woff2" },
        { family: "Unused Serif", filename: "1f8fad5b-d9cb-469f-a165-70867728950e.woff2" },
      ],
    });
    expect(t.fontFaces).toEqual([{ family: "Acme Sans", url: "/api/brand-font/ten_acme/0f8fad5b-d9cb-469f-a165-70867728950e.woff2" }]);
    const hostile = deckThemeFor({ tenantId: "ten_acme", brandTypography: { styles: [{ id: "1", name: "H", role: "heading", fontFamily: "Bad'};x{" }] }, fonts: [{ family: "Bad'};x{", filename: "a.woff2" }] });
    expect(hostile.fontFaces[0]!.family).toBe("Badx");
  });

  it("uses the primary logo, the newest without one, and none gives logoUrl null", async () => {
    const logo = (id: string, isPrimary: boolean) => ({ id, tenantId: "ten_acme", filename: `${id}.png`, mimeType: "image/png", title: id, byteSize: 1, isPrimary, createdAt: "2026-11-01T00:00:00.000Z" });
    const deps = (logos: ReturnType<typeof logo>[]) => ({ loadTenant: async () => null, logos: async () => logos, fonts: async () => [] });
    expect((await loadDeckTheme(ACME, deps([logo("new", false), logo("main", true)]))).logoUrl).toBe("/api/brand-logo/ten_acme/main.png");
    expect((await loadDeckTheme(ACME, deps([logo("new", false)]))).logoUrl).toBe("/api/brand-logo/ten_acme/new.png");
    expect((await loadDeckTheme(ACME, deps([]))).logoUrl).toBeNull();
    // A failed read is soft.
    expect((await loadDeckTheme(ACME, { loadTenant: async () => null, logos: async () => Promise.reject(new Error("down")), fonts: async () => [] })).logoUrl).toBeNull();
  });
});
