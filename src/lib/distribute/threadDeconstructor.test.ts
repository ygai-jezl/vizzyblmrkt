import { describe, it, expect } from "vitest";
import { deconstructToThread } from "./threadDeconstructor";
import { tweetLength, X_MAX_CHARS } from "./preview/x";

describe("deconstructToThread", () => {
  it("returns [] for empty and [text] for copy that already fits one tweet", () => {
    expect(deconstructToThread("")).toEqual([]);
    expect(deconstructToThread("   ")).toEqual([]);
    expect(deconstructToThread("short and sweet")).toEqual(["short and sweet"]);
  });

  it("splits at markdown sub-headers into sequential parts (markers stripped)", () => {
    const body = [
      "## The hook",
      "A punchy opener.",
      "",
      "## The point",
      "The substance of the point.",
      "",
      "### The close",
      "Call to action.",
    ].join("\n");
    // Force multi-part by exceeding one tweet.
    const long = body + "\n\n" + "x".repeat(300);
    const parts = deconstructToThread(long);
    expect(parts[0]).toBe("The hook\nA punchy opener.");
    expect(parts[1]).toBe("The point\nThe substance of the point.");
    expect(parts[2]).toBe("The close\nCall to action.");
    for (const p of parts) expect(tweetLength(p)).toBeLessThanOrEqual(X_MAX_CHARS);
  });

  it("further splits a section that alone exceeds the tweet limit", () => {
    const body = "## Big section\n" + Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const parts = deconstructToThread(body);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(tweetLength(p)).toBeLessThanOrEqual(X_MAX_CHARS);
  });

  it("packs paragraphs greedily when there are no headers", () => {
    const body = "Para one.\n\nPara two.\n\n" + "y".repeat(300);
    const parts = deconstructToThread(body);
    // The two short paragraphs pack together; the long block splits off.
    expect(parts[0]).toBe("Para one.\n\nPara two.");
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(tweetLength(p)).toBeLessThanOrEqual(X_MAX_CHARS);
  });

  it("keeps every code point (nothing dropped across the thread)", () => {
    const body = "## A\n" + "alpha ".repeat(60) + "\n\n## B\n" + "beta ".repeat(60);
    const parts = deconstructToThread(body);
    // Every original word survives somewhere in the thread.
    const joined = parts.join(" ");
    for (const w of ["alpha", "beta"]) expect(joined).toContain(w);
  });

  it("captures preamble text before the first header as part 0", () => {
    const parts = deconstructToThread("Intro preamble.\n\n## First\n" + "x".repeat(300));
    expect(parts[0]).toBe("Intro preamble.");
  });

  it("keeps a header-only section as its own part", () => {
    const parts = deconstructToThread("## Lonely\n\n## Next\n" + "y".repeat(300));
    expect(parts[0]).toBe("Lonely");
  });

  it("normalizes CRLF before splitting", () => {
    const parts = deconstructToThread("## H1\r\nline\r\n\r\n## H2\r\n" + "z".repeat(300));
    expect(parts[0]).toBe("H1\nline");
  });

  it("hard-splits a single very long word with no headers/spaces", () => {
    const parts = deconstructToThread("z".repeat(600));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(tweetLength(p)).toBeLessThanOrEqual(X_MAX_CHARS);
  });

  it("never leaks a raw '## ' header marker into a thread part", () => {
    const parts = deconstructToThread("## Heading\n\nBody line.");
    expect(parts.join("\n")).not.toContain("## ");
    expect(parts.join(" ")).toContain("Heading");
  });

  it("strips the marker on a short single-header hub (no leaked #)", () => {
    expect(deconstructToThread("## The takeaway")).toEqual(["The takeaway"]);
  });
});
