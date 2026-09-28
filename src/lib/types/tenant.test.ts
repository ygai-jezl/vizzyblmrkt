import { describe, it, expect } from "vitest";
import {
  TenantSchema,
  BrandVoiceSchema,
  BrandKitSchema,
  PaletteGroupSchema,
  EmailStyleInputSchema,
  EmailStyleSuggestionSchema,
} from "./tenant";

describe("TenantSchema.gitConnections", () => {
  const field = TenantSchema.shape.gitConnections;
  const conn = {
    provider: "github" as const,
    enc: { ct: "a", iv: "b", tag: "c" },
    connectedAt: "2026-06-30T00:00:00.000Z",
  };

  it("is optional", () => {
    expect(field.parse(undefined)).toBeUndefined();
    expect(field.parse({})).toEqual({});
  });

  it("accepts a SINGLE connected provider (must not be exhaustive)", () => {
    // Regression: an enum-keyed z.record required BOTH github+gitlab and 500'd a
    // tenant that had only connected github.
    expect(field.parse({ github: conn })).toEqual({ github: conn });
  });

  it("accepts both providers", () => {
    const both = { github: conn, gitlab: { ...conn, provider: "gitlab" as const } };
    expect(field.parse(both)).toEqual(both);
  });
});

describe("BrandVoiceSchema", () => {
  it("is a top-level tenant field, distinct from brandKit", () => {
    expect(TenantSchema.shape.brandVoice.parse(undefined)).toBeUndefined();
    const v = { summary: "Warm and direct", dos: ["Be clear"], donts: ["Jargon"] };
    expect(TenantSchema.shape.brandVoice.parse(v)).toMatchObject(v);
  });

  it("accepts a fully-authored voice and is nullable-tolerant per field", () => {
    const parsed = BrandVoiceSchema.parse({
      summary: null,
      dos: [],
      donts: null,
      guidelines: "Write like a friend.",
      sourceDomain: "acme.com",
    });
    expect(parsed.guidelines).toBe("Write like a friend.");
    expect(parsed.sourceDomain).toBe("acme.com");
  });

  it("rejects an over-long summary and too many items (Firestore/token caps)", () => {
    expect(BrandVoiceSchema.safeParse({ summary: "x".repeat(501) }).success).toBe(false);
    expect(BrandVoiceSchema.safeParse({ dos: Array(13).fill("a") }).success).toBe(false);
    expect(BrandVoiceSchema.safeParse({ guidelines: "x".repeat(2001) }).success).toBe(false);
  });
});

describe("BrandKitSchema colours (palette + palettes)", () => {
  it("still parses a legacy flat {hex,name} palette (back-compat)", () => {
    const parsed = BrandKitSchema.parse({
      palette: [{ hex: "#123456", name: "Primary" }, { hex: "#abcdef" }],
    });
    expect(parsed.palette).toEqual([{ hex: "#123456", name: "Primary" }, { hex: "#abcdef" }]);
    expect(parsed.palettes).toBeUndefined();
  });

  it("accepts the new role/estimated colour metadata", () => {
    const parsed = BrandKitSchema.parse({
      palette: [{ hex: "#123456", name: "Primary", role: "primary", estimated: true }],
    });
    expect(parsed.palette?.[0]).toEqual({
      hex: "#123456",
      name: "Primary",
      role: "primary",
      estimated: true,
    });
  });

  it("accepts named palette GROUPS with a source", () => {
    const group = {
      id: "g1",
      name: "brand.pdf",
      source: "pdf" as const,
      colors: [{ hex: "#000000", role: "text" }],
    };
    expect(PaletteGroupSchema.parse(group)).toEqual(group);
    expect(BrandKitSchema.parse({ palettes: [group] }).palettes).toEqual([group]);
  });

  it("enforces caps: <=24 palette, <=20 groups, <=48 colours/group, source enum", () => {
    expect(BrandKitSchema.safeParse({ palette: Array(25).fill({ hex: "#000000" }) }).success).toBe(false);
    expect(BrandKitSchema.safeParse({ palettes: Array(21).fill({ id: "x", name: "n", colors: [] }) }).success).toBe(false);
    expect(
      PaletteGroupSchema.safeParse({ id: "x", name: "n", colors: Array(49).fill({ hex: "#000000" }) }).success,
    ).toBe(false);
    expect(
      PaletteGroupSchema.safeParse({ id: "x", name: "n", source: "twitter", colors: [] }).success,
    ).toBe(false);
  });
});

describe("EmailStyleInputSchema (strict on write)", () => {
  const style = {
    logo: { id: "logo_1", filename: "0f8fad5b-d9cb-469f-a165-70867728950e.png", width: 120, height: 40 },
    companyName: "Example Co",
    headerColor: "#0B1F3A",
    accentColor: "#ff6b35",
  };
  const ok = (over: Record<string, unknown>) => EmailStyleInputSchema.safeParse({ ...style, ...over }).success;
  const logo = (over: Record<string, unknown>) => ok({ logo: { ...style.logo, ...over } });

  it("accepts a full style, a null logo and a null name, lowercasing the colours", () => {
    expect(EmailStyleInputSchema.parse(style).headerColor).toBe("#0b1f3a");
    expect(ok({ logo: null, companyName: null })).toBe(true);
  });

  it("rejects a colour that isn't #rrggbb", () => {
    for (const headerColor of ["red", "#abc", "#0b1f3acc", "0b1f3a", "#0b1f3g"]) expect(ok({ headerColor })).toBe(false);
  });

  it("rejects markup, merge syntax and hidden characters in the name, and names over 80", () => {
    const bad = ["<b>Acme</b>", "Acme {{first_name}}", "Acme }}", "*|FNAME|*", "Acme |* x", "Ac\u202Eme", "", "a".repeat(81)];
    for (const companyName of bad) expect(ok({ companyName })).toBe(false);
    expect(ok({ companyName: "Smith & Sons | Est. 1900" })).toBe(true);
  });

  it("rejects a WebP or non-uuid logo file, fractional sizes and sizes over 200x48", () => {
    expect(logo({ filename: "0f8fad5b-d9cb-469f-a165-70867728950e.webp" })).toBe(false);
    expect(logo({ filename: "../logo.png" })).toBe(false);
    expect(logo({ id: "a/b" })).toBe(false);
    expect(logo({ width: 120.5 })).toBe(false);
    expect(logo({ width: 201 })).toBe(false);
    expect(logo({ height: 49 })).toBe(false);
    expect(logo({ height: 0 })).toBe(false);
  });
});

describe("EmailStyleInputSchema header options (strict on write)", () => {
  const style = {
    logo: null,
    companyName: "Example Co",
    headerColor: "#7c3aed",
    accentColor: "#ff6b35",
  };
  const ok = (over: Record<string, unknown>) => EmailStyleInputSchema.safeParse({ ...style, ...over }).success;

  it("takes a colour 2 (lowercased) or null, and Auto / White / Black; both may be left out", () => {
    expect(EmailStyleInputSchema.parse({ ...style, headerGradientColor: "#4F46E5" }).headerGradientColor).toBe("#4f46e5");
    expect(ok({ headerGradientColor: null })).toBe(true);
    for (const headerText of ["auto", "white", "black"]) expect(ok({ headerText })).toBe(true);
    expect(EmailStyleInputSchema.parse(style)).not.toHaveProperty("headerGradientColor");
  });

  it("rejects a colour 2 that isn't #rrggbb and any other text choice", () => {
    for (const headerGradientColor of ["purple", "#abc", ""]) expect(ok({ headerGradientColor })).toBe(false);
    for (const headerText of ["pink", "Auto", "", null]) expect(ok({ headerText })).toBe(false);
  });
});

describe("TenantSchema.emailStyle (lenient on read)", () => {
  it("reads a damaged value as undefined instead of throwing", () => {
    const field = TenantSchema.shape.emailStyle;
    expect(field.parse(undefined)).toBeUndefined();
    expect(field.parse({ headerColor: "red" })).toBeUndefined();
    expect(field.parse("nonsense")).toBeUndefined();
  });

  it("a damaged header option drops alone: the colours and logo still read", () => {
    const field = TenantSchema.shape.emailStyle;
    const stored = {
      logo: { id: "logo_1", filename: "0f8fad5b-d9cb-469f-a165-70867728950e.png", width: 120, height: 40 },
      companyName: null,
      headerColor: "#7c3aed",
      accentColor: "#ff6b35",
    };
    const damaged = [
      { headerGradientColor: "purple" },
      { headerText: "pink" },
      { headerGradientColor: null, headerText: "auto" },
    ];
    for (const bad of damaged) {
      const read = field.parse({ ...stored, headerGradientColor: "#4f46e5", headerText: "white", ...bad })!;
      expect(read).toMatchObject(stored);
      for (const key of Object.keys(bad)) expect(read[key as keyof typeof read]).toBeUndefined();
    }
    expect(field.parse({ ...stored, headerGradientColor: "#4f46e5", headerText: "black" })).toMatchObject({
      headerGradientColor: "#4f46e5",
      headerText: "black",
    });
  });
});

describe("EmailStyleSuggestionSchema (strict on write)", () => {
  const suggestion = {
    logoId: "logo_1",
    companyName: null,
    headerColor: "#0B1F3A",
    accentColor: "#ff6b35",
    source: "chat",
    brief: "Make the header navy",
    notes: ["No logos yet — add a PNG or JPG in Brand › Logos"],
    suggestedBy: "usr_admin",
    suggestedAt: "2026-09-27T10:00:00.000Z",
  };
  const ok = (over: Record<string, unknown>) => EmailStyleSuggestionSchema.safeParse({ ...suggestion, ...over }).success;

  it("accepts a suggestion with or without a logo, lowercasing the colours", () => {
    expect(EmailStyleSuggestionSchema.parse(suggestion).headerColor).toBe("#0b1f3a");
    expect(ok({ logoId: null, companyName: "Example Co", source: "brand_kit", brief: "", notes: [] })).toBe(true);
  });

  it("takes the header options only when set, strictly: a #rrggbb colour 2, white or black text", () => {
    const parsed = EmailStyleSuggestionSchema.parse({ ...suggestion, headerGradientColor: "#4F46E5", headerText: "white" });
    expect(parsed).toMatchObject({ headerGradientColor: "#4f46e5", headerText: "white" });
    expect(EmailStyleSuggestionSchema.parse(suggestion)).not.toHaveProperty("headerGradientColor");
    expect(ok({ headerText: "black" })).toBe(true);
    // Defaults are never stored: absent is solid / Auto.
    expect(ok({ headerGradientColor: null })).toBe(false);
    expect(ok({ headerText: "auto" })).toBe(false);
    expect(ok({ headerGradientColor: "purple" })).toBe(false);
    expect(ok({ headerText: "pink" })).toBe(false);
  });

  it("rejects what the lenient read would drop: bad colours, names, ids, an over-long brief or notes, no key", () => {
    expect(ok({ headerColor: "navy" })).toBe(false);
    expect(ok({ companyName: "{{user.first_name}} Co" })).toBe(false);
    expect(ok({ logoId: "a/b" })).toBe(false);
    expect(ok({ source: "email" })).toBe(false);
    expect(ok({ brief: "a".repeat(501) })).toBe(false);
    expect(ok({ notes: ["a", "b", "c", "d", "e", "f"] })).toBe(false);
    expect(ok({ notes: ["a".repeat(201)] })).toBe(false);
    expect(ok({ suggestedAt: "" })).toBe(false);
    expect(ok({ suggestedBy: "" })).toBe(false);
  });
});

describe("TenantSchema.emailStyleSuggestion (lenient on read)", () => {
  it("reads a damaged value as undefined instead of throwing", () => {
    const field = TenantSchema.shape.emailStyleSuggestion;
    expect(field.parse(undefined)).toBeUndefined();
    expect(field.parse({ headerColor: "#0b1f3a" })).toBeUndefined();
    expect(field.parse(42)).toBeUndefined();
  });
});
