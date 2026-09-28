import { describe, it, expect } from "vitest";
import {
  accentFor,
  bandInk,
  bandStops,
  bandTextContrast,
  cleanCompanyName,
  contrastRatio,
  isEmailHeaderImage,
  isLogoUrlShape,
  readableAcross,
  readableOn,
  resolveStoredStyle,
  safeLogoUrl,
  styleFromBrandKit,
  type EmailStyleLogoOption,
} from "./emailStyle";
import type { BrandKit } from "@/lib/types/tenant";

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const logoUrl = (tenant: string, file = `${UUID}.png`, origin = "https://app.example.com") =>
  `${origin}/api/brand-logo/${tenant}/${file}`;

describe("contrast", () => {
  it("black on white is 21:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
  });

  it("readableOn always gives at least 4.5:1, over a sweep of backgrounds", () => {
    const steps = [0, 0x22, 0x44, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xcc, 0xee, 0xff];
    const hex = (n: number) => n.toString(16).padStart(2, "0");
    let worst = Infinity;
    for (const r of steps)
      for (const g of steps)
        for (const b of steps) {
          const bg = `#${hex(r)}${hex(g)}${hex(b)}`;
          worst = Math.min(worst, contrastRatio(bg, readableOn(bg)));
        }
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });

  it("puts black on a light accent and white on a dark one", () => {
    expect(readableOn("#ffd400")).toBe("#000000");
    expect(readableOn("#0b1f3a")).toBe("#ffffff");
  });
});

describe("the header band's colours", () => {
  it("readableAcross one colour is exactly readableOn, over a sweep of backgrounds", () => {
    const steps = [0, 0x22, 0x44, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xcc, 0xee, 0xff];
    const hex = (n: number) => n.toString(16).padStart(2, "0");
    for (const r of steps)
      for (const g of steps)
        for (const b of steps) {
          const bg = `#${hex(r)}${hex(g)}${hex(b)}`;
          expect(readableAcross([bg])).toBe(readableOn(bg));
        }
  });

  it("across a light-to-dark gradient, picks by the worse stop", () => {
    // Black reads on the light violet alone, but only 1.8:1 on the dark end; white is 2.7:1 at worst.
    expect(readableOn("#a78bfa")).toBe("#000000");
    expect(readableAcross(["#a78bfa", "#312e81"])).toBe("#ffffff");
    expect(bandInk({ headerColor: "#a78bfa", headerGradientColor: "#312e81" })).toBe("#ffffff");
    expect(readableAcross(["#ffd400", "#f5b700"])).toBe("#000000");
  });

  it("a forced text colour wins, and bandTextContrast is its worst contrast across the stops", () => {
    const white = { headerColor: "#ffd400", headerText: "white" as const };
    expect(bandInk(white)).toBe("#ffffff");
    expect(bandTextContrast(white)).toBeLessThan(3);
    const black = { headerColor: "#7c3aed", headerGradientColor: "#4f46e5", headerText: "black" as const };
    expect(bandInk(black)).toBe("#000000");
    expect(bandTextContrast(black)).toBeCloseTo(contrastRatio("#4f46e5", "#000000"), 5);
    expect(bandTextContrast(black)).toBeGreaterThan(3);
    expect(bandTextContrast({ headerColor: "#5b21b6", headerText: "black" })).toBeLessThan(3);
  });

  it("bandStops: what the band draws — a bad colour 2 is dropped, a bad header draws #111111", () => {
    expect(bandStops({ headerColor: "#7c3aed", headerGradientColor: "#4f46e5" })).toEqual(["#7c3aed", "#4f46e5"]);
    expect(bandStops({ headerColor: "#7c3aed" })).toEqual(["#7c3aed"]);
    expect(bandStops({ headerColor: "#ffd400", headerGradientColor: "purple" })).toEqual(["#ffd400"]);
    expect(bandStops({ headerColor: "#ffd400", headerGradientColor: "#FFD400" })).toEqual(["#ffd400"]);
    expect(bandStops({ headerColor: "#fff", headerGradientColor: "#4f46e5" })).toEqual(["#111111", "#4f46e5"]);
    expect(bandStops({ headerColor: "red" })).toEqual(["#111111"]);
  });
});

describe("accentFor", () => {
  it("#FFD400: a button takes it; links and the insight rule keep today's colour", () => {
    const style = { accentColor: "#FFD400" };
    expect(accentFor(style, "button")).toBe("#ffd400");
    expect(accentFor(style, "link")).toBeNull();
    expect(accentFor(style, "rule")).toBeNull();
  });

  it("a dark accent is used everywhere", () => {
    const style = { accentColor: "#0b1f3a" };
    expect(accentFor(style, "button")).toBe("#0b1f3a");
    expect(accentFor(style, "link")).toBe("#0b1f3a");
    expect(accentFor(style, "rule")).toBe("#0b1f3a");
  });

  it("no style → null", () => {
    expect(accentFor(null, "button")).toBeNull();
    expect(accentFor({ accentColor: "navy" }, "button")).toBeNull();
  });
});

describe("logo URLs", () => {
  it("accepts this tenant's https PNG/JPEG logo", () => {
    expect(safeLogoUrl(logoUrl("ten_A"), "ten_A")).toBe(logoUrl("ten_A"));
    expect(safeLogoUrl(logoUrl("ten_A", `${UUID}.jpeg`), "ten_A")).toBe(logoUrl("ten_A", `${UUID}.jpeg`));
  });

  it("rejects http, another tenant, WebP, a query string, a hash, credentials and a foreign path", () => {
    expect(safeLogoUrl(logoUrl("ten_A", undefined, "http://app.example.com"), "ten_A")).toBeNull();
    expect(safeLogoUrl(logoUrl("ten_B"), "ten_A")).toBeNull();
    expect(safeLogoUrl(logoUrl("ten_A", `${UUID}.webp`), "ten_A")).toBeNull();
    expect(safeLogoUrl(`${logoUrl("ten_A")}?v=1`, "ten_A")).toBeNull();
    expect(safeLogoUrl(`${logoUrl("ten_A")}#x`, "ten_A")).toBeNull();
    expect(safeLogoUrl(logoUrl("ten_A", undefined, "https://u:p@app.example.com"), "ten_A")).toBeNull();
    expect(safeLogoUrl(`https://app.example.com/api/workspace-asset/ten_A/${UUID}.png`, "ten_A")).toBeNull();
    expect(safeLogoUrl(`https://app.example.com/api/brand-logo/ten_A/x/${UUID}.png`, "ten_A")).toBeNull();
    expect(safeLogoUrl(`/api/brand-logo/ten_A/${UUID}.png`, "ten_A")).toBeNull();
    expect(safeLogoUrl("javascript:alert(1)", "ten_A")).toBeNull();
  });

  it("the tenant-agnostic shape check passes any tenant but nothing else", () => {
    expect(isLogoUrlShape(logoUrl("ten_B"))).toBe(true);
    expect(isLogoUrlShape(logoUrl("ten_B", undefined, "http://app.example.com"))).toBe(false);
    expect(isLogoUrlShape("https://ok.example.com/a.png")).toBe(false);
  });
});

describe("isEmailHeaderImage", () => {
  const row = {
    category: "header" as const,
    filename: `${UUID}.jpg`,
    mimeType: "image/jpeg",
    width: 1200,
    height: 300,
  };

  it("a header PNG/JPEG with a whole-pixel size within 1200 × 2400", () => {
    expect(isEmailHeaderImage(row)).toBe(true);
    expect(isEmailHeaderImage({ ...row, filename: `${UUID}.png`, mimeType: "image/png" })).toBe(true);
    expect(isEmailHeaderImage({ ...row, width: 1, height: 2400 })).toBe(true);
  });

  it("not WebP, another category, a bad filename, or a missing or out-of-range size", () => {
    expect(isEmailHeaderImage({ ...row, filename: `${UUID}.webp`, mimeType: "image/webp" })).toBe(false);
    expect(isEmailHeaderImage({ ...row, mimeType: "image/webp" })).toBe(false);
    expect(isEmailHeaderImage({ ...row, category: "icon" })).toBe(false);
    expect(isEmailHeaderImage({ ...row, category: "graphic" })).toBe(false);
    expect(isEmailHeaderImage({ ...row, filename: "banner.jpg" })).toBe(false);
    expect(isEmailHeaderImage({ ...row, filename: `../${UUID}.jpg` })).toBe(false);
    expect(isEmailHeaderImage({ ...row, width: undefined })).toBe(false);
    expect(isEmailHeaderImage({ ...row, height: undefined })).toBe(false);
    expect(isEmailHeaderImage({ ...row, width: 1201 })).toBe(false);
    expect(isEmailHeaderImage({ ...row, height: 2401 })).toBe(false);
    expect(isEmailHeaderImage({ ...row, width: 0 })).toBe(false);
    expect(isEmailHeaderImage({ ...row, height: 300.5 })).toBe(false);
  });
});

describe("cleanCompanyName", () => {
  it("strips invisible (U+2063), bidi-override (U+202E) and control characters", () => {
    expect(cleanCompanyName("Ac\u2063me\u202E Co\u0000")).toBe("Acme Co");
    expect(cleanCompanyName("Acme\u200B\u00ADLtd")).toBe("AcmeLtd");
  });

  it("turns line breaks into single spaces and trims", () => {
    expect(cleanCompanyName("  Acme\n\tCo \u2028 Ltd  ")).toBe("Acme Co Ltd");
  });

  it("is null when blank or not a string", () => {
    expect(cleanCompanyName("   ")).toBeNull();
    expect(cleanCompanyName("\u202E")).toBeNull();
    expect(cleanCompanyName(null)).toBeNull();
    expect(cleanCompanyName(42)).toBeNull();
  });

  it("clips to 80 without splitting an emoji", () => {
    expect(cleanCompanyName("a".repeat(100))).toBe("a".repeat(80));
    const clipped = cleanCompanyName(`${"a".repeat(79)}😀`)!;
    expect(clipped).toBe("a".repeat(79));
  });

  it("leaves markup for the schema to reject", () => {
    expect(cleanCompanyName("{{name}} *|FNAME|*")).toBe("{{name}} *|FNAME|*");
  });
});

describe("resolveStoredStyle", () => {
  const stored = {
    logo: { id: "logo_1", filename: `${UUID}.png`, width: 120, height: 40 },
    companyName: null,
    headerColor: "#0B1F3A",
    accentColor: "#ff6b35",
  };
  const opts = { logoUrlFor: () => logoUrl("ten_A"), fallbackName: "Example Co" };

  it("maps a saved style to what the renderers draw", () => {
    expect(resolveStoredStyle(stored, opts)).toEqual({
      logo: { url: logoUrl("ten_A"), width: 120, height: 40 },
      name: null,
      altName: "Example Co",
      headerColor: "#0b1f3a",
      accentColor: "#ff6b35",
    });
  });

  it("a company name is shown and used as alt text", () => {
    const r = resolveStoredStyle({ ...stored, companyName: "Acme" }, opts)!;
    expect(r.name).toBe("Acme");
    expect(r.altName).toBe("Acme");
  });

  it("no usable logo URL → a name band; no style → null", () => {
    expect(resolveStoredStyle(stored, { ...opts, logoUrlFor: () => null })!.logo).toBeNull();
    expect(resolveStoredStyle(null, opts)).toBeNull();
    expect(resolveStoredStyle({ ...stored, headerColor: "red" }, opts)).toBeNull();
  });

  it("keeps the logo within 200×48", () => {
    const big = { ...stored, logo: { ...stored.logo, width: 999.6, height: 0.2 } };
    expect(resolveStoredStyle(big, opts)!.logo).toMatchObject({ width: 200, height: 1 });
  });

  describe("header options", () => {
    const today = resolveStoredStyle(stored, opts);
    const options = { headerGradientColor: "#4F46E5", headerText: "white" as const };

    it("sets a gradient and a forced text colour with headerOptions on", () => {
      expect(resolveStoredStyle({ ...stored, ...options }, { ...opts, headerOptions: true })).toStrictEqual({
        ...today,
        headerGradientColor: "#4f46e5",
        headerText: "white",
      });
    });

    it("adds no keys with headerOptions off, for the defaults, or for equal stops", () => {
      expect(resolveStoredStyle({ ...stored, ...options }, opts)).toStrictEqual(today);
      expect(resolveStoredStyle({ ...stored, ...options }, { ...opts, headerOptions: false })).toStrictEqual(today);
      const on = { ...opts, headerOptions: true };
      expect(resolveStoredStyle({ ...stored, headerGradientColor: null, headerText: "auto" }, on)).toStrictEqual(today);
      expect(resolveStoredStyle({ ...stored, headerGradientColor: "#0B1F3A" }, on)).toStrictEqual(today);
      expect(resolveStoredStyle({ ...stored, headerGradientColor: "purple" }, on)).toStrictEqual(today);
    });
  });
});

describe("styleFromBrandKit", () => {
  const logo = (over: Partial<EmailStyleLogoOption>): EmailStyleLogoOption => ({
    id: "logo_1",
    filename: `${UUID}.png`,
    mimeType: "image/png",
    isPrimary: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...over,
  });
  const pngLogo = logo({ isPrimary: true });

  it("matches colours by role first", () => {
    const kit: BrandKit = {
      palette: [
        { hex: "#ffffff", name: "Paper", role: "background" },
        { hex: "#ff6b35", name: "Brand orange", role: "accent" },
        { hex: "#0b1f3a", name: "Ink", role: "Primary" },
      ],
    };
    expect(styleFromBrandKit(kit, [pngLogo])).toEqual({
      logoId: "logo_1",
      companyName: null,
      headerColor: "#0b1f3a",
      accentColor: "#ff6b35",
      notes: [],
    });
  });

  it("falls back to names when there are no roles (the guidelines-PDF extract shape)", () => {
    const kit: BrandKit = {
      palette: [
        { hex: "#FFFFFF", name: "White" },
        { hex: "#1A1A1A", name: "Charcoal" },
        { hex: "#2F6FEB", name: "Primary Blue" },
        { hex: "#F5B700", name: "Highlight Yellow" },
      ],
    };
    const s = styleFromBrandKit(kit, [pngLogo]);
    expect(s.headerColor).toBe("#2f6feb");
    expect(s.accentColor).toBe("#f5b700");
  });

  it("then the first non-neutral colours, searching palette then palettes", () => {
    const kit: BrandKit = {
      palette: [{ hex: "#f4f4f4", name: "Light grey" }],
      palettes: [
        {
          id: "g1",
          name: "From the PDF",
          source: "pdf",
          colors: [
            { hex: "#ABC", name: "Sky" },
            { hex: "#0b1f3aCC", name: "Deep" },
          ],
        },
      ],
    };
    const s = styleFromBrandKit(kit, [pngLogo]);
    expect(s.headerColor).toBe("#aabbcc");
    expect(s.accentColor).toBe("#0b1f3a");
  });

  it("an empty palette gives a dark header and the same button", () => {
    const s = styleFromBrandKit({ palette: [] }, [pngLogo]);
    expect(s).toMatchObject({ headerColor: "#111111", accentColor: "#111111" });
    expect(styleFromBrandKit(null, [])).toMatchObject({ headerColor: "#111111", accentColor: "#111111" });
  });

  it("the button falls back to the header when there's only one colour", () => {
    const s = styleFromBrandKit({ palette: [{ hex: "#2f6feb", name: "Blue" }] }, [pngLogo]);
    expect(s).toMatchObject({ headerColor: "#2f6feb", accentColor: "#2f6feb" });
  });

  it("a WebP primary: uses the newest PNG/JPEG, else says why there's no logo", () => {
    const webp = logo({ id: "logo_w", filename: `${UUID}.webp`, mimeType: "image/webp", isPrimary: true, createdAt: "2026-09-03T00:00:00.000Z" });
    const oldPng = logo({ id: "logo_old", createdAt: "2026-08-01T00:00:00.000Z" });
    const newJpg = logo({ id: "logo_new", filename: `${UUID}.jpg`, mimeType: "image/jpeg", createdAt: "2026-09-02T00:00:00.000Z" });
    expect(styleFromBrandKit(null, [webp, oldPng, newJpg])).toMatchObject({ logoId: "logo_new", notes: [] });

    const alone = styleFromBrandKit(null, [webp]);
    expect(alone.logoId).toBeNull();
    expect(alone.notes).toEqual(["Your primary logo is WebP, which Outlook can't show — upload a PNG or JPG"]);
  });

  it("no primary flag: the newest logo counts as primary", () => {
    const older = logo({ id: "logo_a", createdAt: "2026-08-01T00:00:00.000Z" });
    const newer = logo({ id: "logo_b", createdAt: "2026-09-01T00:00:00.000Z" });
    expect(styleFromBrandKit(null, [older, newer]).logoId).toBe("logo_b");
  });

  it("no logos: says to add one", () => {
    const s = styleFromBrandKit({ palette: [{ hex: "#2f6feb", role: "primary" }] }, []);
    expect(s.logoId).toBeNull();
    expect(s.notes).toEqual(["No logos yet — add a PNG or JPG in Brand › Logos"]);
  });
});
