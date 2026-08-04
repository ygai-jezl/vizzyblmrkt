import { describe, it, expect } from "vitest";
import { BrandTypographySchema, TextStyleSchema } from "./tenant";

describe("BrandTypographySchema", () => {
  it("parses a full typography payload", () => {
    const parsed = BrandTypographySchema.parse({
      styles: [
        { id: "1", name: "Title", role: "title", fontFamily: "Montserrat", size: 42, bold: true },
        { id: "2", name: "Body", role: "body", fontFamily: null, size: 16 },
      ],
      guidelines: "Pair Montserrat headings with Inter body.",
    });
    expect(parsed.styles).toHaveLength(2);
    expect(parsed.styles?.[0]?.role).toBe("title");
  });

  it("rejects an unknown role and out-of-range size", () => {
    expect(() =>
      TextStyleSchema.parse({ id: "1", name: "X", role: "banner", size: 16 }),
    ).toThrow();
    expect(() =>
      TextStyleSchema.parse({ id: "1", name: "X", role: "body", size: 4 }),
    ).toThrow();
    expect(() =>
      TextStyleSchema.parse({ id: "1", name: "X", role: "body", size: 999 }),
    ).toThrow();
  });

  it("caps the number of styles at 24", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: String(i),
      name: `S${i}`,
      role: "body" as const,
    }));
    expect(() => BrandTypographySchema.parse({ styles: many })).toThrow();
  });
});
