import { describe, it, expect } from "vitest";
import {
  sanitizeEbookHtml,
  sanitizeEbookHtmlCapped,
  buildImageAnchor,
  splitChapterByImages,
  anchoredSlotIds,
  reconcileChapterImages,
  stripImageAnchor,
} from "./ebookHtml";

describe("sanitizeEbookHtml", () => {
  it("keeps eBook block tags", () => {
    const html = "<h2>Title</h2><p><strong>Bold</strong> and <em>italic</em></p><blockquote>q</blockquote><ul><li>a</li></ul>";
    expect(sanitizeEbookHtml(html)).toBe(html);
  });

  it("drops <script> with its content and escapes stray brackets", () => {
    const out = sanitizeEbookHtml("<p>ok</p><script>alert(1)</script><p>2 < 3</p>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("2 &lt; 3");
  });

  it("preserves an image anchor div's slot id but strips other attributes", () => {
    const out = sanitizeEbookHtml('<div data-ebook-image="img_a1" class="evil" onclick="x">x</div>');
    expect(out).toBe('<div data-ebook-image="img_a1">x</div>');
  });

  it("cleans an unsafe link href", () => {
    expect(sanitizeEbookHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeEbookHtml('<a href="https://ex.com">x</a>')).toContain('href="https://ex.com"');
  });

  it("drops disallowed tags (code/pre/img) while keeping text", () => {
    const out = sanitizeEbookHtml("<pre><code>x</code></pre><img src=y><p>keep</p>");
    expect(out).not.toContain("<pre");
    expect(out).not.toContain("<code");
    expect(out).not.toContain("<img");
    expect(out).toContain("<p>keep</p>");
  });

  it("keeps tables, h4 and hr (structure), stripping cell attributes", () => {
    const table = '<table><thead><tr><th colspan="2">H</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>';
    const out = sanitizeEbookHtml(`<h4>Sub</h4>${table}<hr>`);
    expect(out).toContain("<h4>Sub</h4>");
    expect(out).toContain("<table>");
    expect(out).toContain("<thead>");
    expect(out).toContain("<tr>");
    expect(out).toContain("<th>H</th>"); // colspan stripped
    expect(out).toContain("<td>a</td>");
    expect(out).toContain("<hr>");
  });

  it("keeps bullet + ordered lists verbatim", () => {
    const list = "<ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>";
    expect(sanitizeEbookHtml(list)).toBe(list);
  });
});

describe("sanitizeEbookHtmlCapped", () => {
  it("returns as-is when already under the cap", () => {
    expect(sanitizeEbookHtmlCapped("<p>hi</p>", 100)).toBe("<p>hi</p>");
  });

  it("guarantees output <= max even when escaping re-grows a boundary tag", () => {
    // Bracket-heavy text: each < / > escapes to 4 chars, so naive slice+re-sanitize overflows.
    const raw = ">".repeat(4000) + "<p>" + "x".repeat(4000) + "</p>";
    const out = sanitizeEbookHtmlCapped(raw, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).not.toContain("<script");
  });

  it("handles a pathological all-brackets input", () => {
    const out = sanitizeEbookHtmlCapped("<".repeat(10000), 200);
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

describe("image anchors: build / split / reconcile / strip", () => {
  it("round-trips an anchor through sanitize", () => {
    const anchor = buildImageAnchor("img_x1");
    expect(sanitizeEbookHtml(`<p>a</p>${anchor}<p>b</p>`)).toBe(`<p>a</p>${anchor}<p>b</p>`);
  });

  it("splits chapter HTML into html + image segments in order", () => {
    const html = `<p>intro</p>${buildImageAnchor("img_1")}<p>after</p>`;
    const segs = splitChapterByImages(html);
    expect(segs).toEqual([
      { type: "html", html: "<p>intro</p>" },
      { type: "image", slotId: "img_1" },
      { type: "html", html: "<p>after</p>" },
    ]);
  });

  it("lists anchored slot ids (deduped, in order)", () => {
    const html = `${buildImageAnchor("img_1")}${buildImageAnchor("img_2")}${buildImageAnchor("img_1")}`;
    expect(anchoredSlotIds(html)).toEqual(["img_1", "img_2"]);
  });

  it("reconcile drops slots whose anchor is gone; keeps the rest", () => {
    const html = `<p>x</p>${buildImageAnchor("img_1")}`;
    const images = [{ id: "img_1" }, { id: "img_2" }];
    expect(reconcileChapterImages(html, images)).toEqual([{ id: "img_1" }]);
  });

  it("stripImageAnchor removes exactly the targeted anchor", () => {
    const html = `${buildImageAnchor("img_1")}${buildImageAnchor("img_2")}`;
    expect(stripImageAnchor(html, "img_1")).toBe(buildImageAnchor("img_2"));
  });
});
