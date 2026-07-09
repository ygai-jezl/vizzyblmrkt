import { describe, it, expect } from "vitest";
import {
  EBOOK_ASPECTS,
  EBOOK_ASPECT_TO_GEMINI,
  EBOOK_ASPECT_LABELS,
  ebookAspectRatioCss,
  EBOOK_IMAGE_STYLES,
  EBOOK_IMAGE_STYLE_IDS,
  DEFAULT_EBOOK_IMAGE_STYLE,
  ebookImageStyle,
  EBOOK_IMAGE_EDIT_MAX_INPUTS,
  EBOOK_IMAGE_INLINE_MAX_BYTES,
} from "./ebook";

describe("eBook image aspects", () => {
  it("maps every offered aspect to a Gemini ratio (native 1:4 pass-through)", () => {
    for (const a of EBOOK_ASPECTS) {
      expect(EBOOK_ASPECT_TO_GEMINI[a]).toBeTruthy();
      expect(EBOOK_ASPECT_LABELS[a]).toBeTruthy();
    }
    expect(EBOOK_ASPECT_TO_GEMINI["1:4"]).toBe("1:4");
    expect(ebookAspectRatioCss("1:4")).toBe("1 / 4");
    expect(ebookAspectRatioCss("1:1")).toBe("1 / 1");
  });
});

describe("eBook image styles", () => {
  it("style ids tuple stays in lockstep with EBOOK_IMAGE_STYLES", () => {
    expect([...EBOOK_IMAGE_STYLE_IDS].sort()).toEqual(EBOOK_IMAGE_STYLES.map((s) => s.id).sort());
  });

  it("resolves a style id, falling back to the first preset for unknown ids", () => {
    expect(ebookImageStyle("watercolor").id).toBe("watercolor");
    expect(ebookImageStyle("nope").id).toBe(EBOOK_IMAGE_STYLES[0]!.id);
    expect(EBOOK_IMAGE_STYLE_IDS).toContain(DEFAULT_EBOOK_IMAGE_STYLE);
  });

  it("codifies the model edit limits", () => {
    expect(EBOOK_IMAGE_EDIT_MAX_INPUTS).toBe(14);
    expect(EBOOK_IMAGE_INLINE_MAX_BYTES).toBe(7 * 1024 * 1024);
  });
});
