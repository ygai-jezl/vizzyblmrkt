import { describe, it, expect } from "vitest";
import { sniffFontMime, FONT_FILENAME } from "./brandFontStore";

/** Build a buffer whose first 4 bytes are the given ASCII tag. */
function tagged(tag: string): Buffer {
  return Buffer.concat([Buffer.from(tag, "ascii"), Buffer.alloc(16)]);
}

describe("sniffFontMime", () => {
  it("recognises the real font containers from magic bytes", () => {
    expect(sniffFontMime(tagged("wOF2"))).toBe("font/woff2");
    expect(sniffFontMime(tagged("wOFF"))).toBe("font/woff");
    expect(sniffFontMime(tagged("OTTO"))).toBe("font/otf");
    expect(sniffFontMime(tagged("true"))).toBe("font/ttf");
    // TrueType sfnt version 0x00010000
    expect(sniffFontMime(Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00]))).toBe("font/ttf");
  });

  it("rejects non-font bytes (e.g. a PNG or empty buffer)", () => {
    expect(sniffFontMime(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // PNG
    expect(sniffFontMime(Buffer.from([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // %PDF
    expect(sniffFontMime(Buffer.alloc(2))).toBeNull();
  });
});

describe("FONT_FILENAME", () => {
  it("accepts uuid.<fontext> and rejects traversal / other types", () => {
    expect(FONT_FILENAME.test("a1b2-c3.woff2")).toBe(true);
    expect(FONT_FILENAME.test("x.ttf")).toBe(true);
    expect(FONT_FILENAME.test("../secret.woff2")).toBe(false);
    expect(FONT_FILENAME.test("evil.png")).toBe(false);
    expect(FONT_FILENAME.test("a/b.woff")).toBe(false);
  });
});
