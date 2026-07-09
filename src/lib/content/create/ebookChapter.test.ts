import { describe, it, expect } from "vitest";
import { parseChapterImagePlaceholders, fallbackChapterHtml } from "./ebookChapter";
import { CONTENT_PLAN_LIMITS } from "@/lib/types/contentPlan";

// Deterministic ids for assertions.
function seqIds() {
  let n = 0;
  return () => `img_${++n}`;
}

describe("parseChapterImagePlaceholders", () => {
  it("turns [[image: brief]] markers into placeholder slots + anchors", () => {
    const raw = "<h2>Ch</h2><p>a</p>[[image: a hero shot of a founder]]<p>b</p>";
    const { bodyHtml, images } = parseChapterImagePlaceholders(raw, seqIds());
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      id: "img_1",
      status: "placeholder",
      aspect: "1:1",
      width: 100,
      contextPrompt: "a hero shot of a founder",
    });
    expect(bodyHtml).toContain('<div data-ebook-image="img_1">');
    expect(bodyHtml).not.toContain("[[image:");
  });

  it("caps the number of image slots per chapter", () => {
    const markers = Array.from({ length: CONTENT_PLAN_LIMITS.MAX_IMAGES_PER_CHAPTER + 3 }, (_, i) => `[[image: ${i}]]`).join("");
    const { images } = parseChapterImagePlaceholders(`<p>x</p>${markers}`, seqIds());
    expect(images).toHaveLength(CONTENT_PLAN_LIMITS.MAX_IMAGES_PER_CHAPTER);
  });

  it("sanitizes the surrounding HTML (drops scripts)", () => {
    const { bodyHtml } = parseChapterImagePlaceholders("<p>ok</p><script>evil()</script>", seqIds());
    expect(bodyHtml).not.toContain("<script");
    expect(bodyHtml).not.toContain("evil()");
  });

  it("handles no markers (plain chapter)", () => {
    const { bodyHtml, images } = parseChapterImagePlaceholders("<h2>T</h2><p>body</p>", seqIds());
    expect(images).toHaveLength(0);
    expect(bodyHtml).toBe("<h2>T</h2><p>body</p>");
  });
});

describe("fallbackChapterHtml", () => {
  it("produces a safe titled body from title + summary", () => {
    const out = fallbackChapterHtml("The Shift", "Why it matters");
    expect(out).toContain("<h2>The Shift</h2>");
    expect(out).toContain("Why it matters");
  });
});
