import { describe, it, expect } from "vitest";
import { TenantSchema, BrandVoiceSchema, BrandKitSchema, PaletteGroupSchema } from "./tenant";

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
