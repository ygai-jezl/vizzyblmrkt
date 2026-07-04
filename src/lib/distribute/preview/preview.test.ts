import { describe, it, expect } from "vitest";
import { splitIntoTweets, tweetLength, isSingleTweet, X_MAX_CHARS } from "./x";
import { truncateSeeMore, LINKEDIN_SEE_MORE_CHARS } from "./linkedin";
import { truncateCaption, INSTAGRAM_CAPTION_CHARS } from "./instagram";
import { cpLength, cutAtWord } from "./text";

describe("X thread splitting", () => {
  it("returns [] for empty and [text] for short copy", () => {
    expect(splitIntoTweets("")).toEqual([]);
    expect(splitIntoTweets("   ")).toEqual([]);
    expect(splitIntoTweets("short tweet")).toEqual(["short tweet"]);
  });

  it("splits long copy into parts each within the 280 limit", () => {
    const body = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const parts = splitIntoTweets(body);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(tweetLength(p)).toBeLessThanOrEqual(X_MAX_CHARS);
    // No word is lost or split across parts (rejoin drops only the pack whitespace).
    expect(parts.join(" ").split(/\s+/)).toEqual(body.split(/\s+/));
  });

  it("hard-splits a single token longer than the limit", () => {
    const url = "x".repeat(300);
    const parts = splitIntoTweets(url);
    expect(parts.length).toBe(2);
    expect(tweetLength(parts[0]!)).toBe(280);
    expect(parts.join("")).toBe(url);
  });

  it("hard-splits an emoji wall on grapheme boundaries (never severs a cluster)", () => {
    const family = "👨‍👩‍👧‍👦"; // one grapheme = 7 code points
    expect(tweetLength(family)).toBe(7);
    const wall = family.repeat(50); // 350 code points > 280
    const parts = splitIntoTweets(wall);
    expect(parts.join("")).toBe(wall); // nothing lost
    // Each part is whole clusters only → code-point length is a multiple of 7.
    for (const p of parts) expect(tweetLength(p) % 7).toBe(0);
  });

  it("terminates (no infinite loop) for a non-positive limit", () => {
    const parts = splitIntoTweets("hello world", 0);
    expect(parts.join("")).toBe("helloworld");
    for (const p of parts) expect(tweetLength(p)).toBeLessThanOrEqual(1);
  });

  it("preserves a line break within a part when it fits", () => {
    const parts = splitIntoTweets("line one\nline two");
    expect(parts).toEqual(["line one\nline two"]);
  });

  it("isSingleTweet reflects the 280 limit", () => {
    expect(isSingleTweet("a".repeat(280))).toBe(true);
    expect(isSingleTweet("a".repeat(281))).toBe(false);
  });
});

describe("LinkedIn see-more truncation", () => {
  it("does not truncate short, few-line copy", () => {
    const r = truncateSeeMore("A short post.\nTwo lines.");
    expect(r.truncated).toBe(false);
    expect(r.visible).toBe("A short post.\nTwo lines.");
  });

  it("truncates after the line limit", () => {
    const r = truncateSeeMore("l1\nl2\nl3\nl4\nl5", { lineLimit: 3 });
    expect(r.truncated).toBe(true);
    expect(r.visible).toBe("l1\nl2\nl3");
  });

  it("truncates after the char limit at a word boundary", () => {
    const body = Array.from({ length: 60 }, () => "word").join(" "); // 300+ chars, one line
    const r = truncateSeeMore(body);
    expect(r.truncated).toBe(true);
    expect(cpLength(r.visible)).toBeLessThanOrEqual(LINKEDIN_SEE_MORE_CHARS);
    expect(r.visible.endsWith("word")).toBe(true); // cut on a boundary, not mid-word
  });

  it("hard-cuts a single long line with no spaces to <= the char limit", () => {
    const r = truncateSeeMore("x".repeat(500));
    expect(r.truncated).toBe(true);
    expect(cpLength(r.visible)).toBeLessThanOrEqual(LINKEDIN_SEE_MORE_CHARS);
  });
});

describe("Instagram caption truncation", () => {
  it("keeps a short caption whole", () => {
    const r = truncateCaption("Nice photo ✨");
    expect(r.truncated).toBe(false);
    expect(r.visible).toBe("Nice photo ✨");
  });

  it("truncates a long caption at the caption limit", () => {
    const body = Array.from({ length: 40 }, () => "caption").join(" ");
    const r = truncateCaption(body);
    expect(r.truncated).toBe(true);
    expect(cpLength(r.visible)).toBeLessThanOrEqual(INSTAGRAM_CAPTION_CHARS);
  });
});

describe("text helpers", () => {
  it("cpLength counts astral code points as 1", () => {
    expect(cpLength("a😀b")).toBe(3);
  });
  it("cutAtWord prefers a nearby word boundary", () => {
    expect(cutAtWord("hello world foo", 8)).toBe("hello");
  });
  it("cutAtWord hard-cuts to <= limit when there is no space", () => {
    expect(cutAtWord("x".repeat(50), 20)).toBe("x".repeat(20));
  });
  it("cutAtWord returns text unchanged when within the limit", () => {
    expect(cutAtWord("short", 20)).toBe("short");
  });
});
