import { describe, it, expect } from "vitest";
import {
  SHARE_PLATFORM_IDS,
  buildShareUrl,
  getSharePlatform,
  isSharePlatformId,
  parseEnabledPlatforms,
} from "./socialPlatforms";

// A link + message with characters that MUST be percent-encoded (space, &, #, ').
const url = "https://wl.example.com/w/abc?ref=XYZ 123&a=1";
const message = "I'm #42 — join me & win!";

describe("buildShareUrl", () => {
  it("twitter: message in text, link in url, both encoded", () => {
    const out = buildShareUrl("twitter", { url, message });
    expect(out.startsWith("https://twitter.com/intent/tweet?")).toBe(true);
    expect(out).toContain(`text=${encodeURIComponent(message)}`);
    expect(out).toContain(`url=${encodeURIComponent(url)}`);
  });

  it("whatsapp: combines message + url into one encoded text field", () => {
    const out = buildShareUrl("whatsapp", { url, message });
    expect(out).toBe(
      `https://wa.me/?text=${encodeURIComponent(`${message} ${url}`)}`,
    );
  });

  it("telegram: carries url + text", () => {
    const out = buildShareUrl("telegram", { url, message });
    expect(out).toContain(`url=${encodeURIComponent(url)}`);
    expect(out).toContain(`text=${encodeURIComponent(message)}`);
  });

  it("facebook: link only, ignores the message", () => {
    const out = buildShareUrl("facebook", { url, message });
    expect(out).toBe(
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
    );
    expect(out).not.toContain(encodeURIComponent(message));
  });

  it("linkedin: link only, ignores the message", () => {
    const out = buildShareUrl("linkedin", { url, message });
    expect(out).toBe(
      `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
    );
    expect(out).not.toContain(encodeURIComponent(message));
  });

  it("email: mailto with subject + combined body", () => {
    const out = buildShareUrl("email", { url, message });
    expect(out.startsWith("mailto:?")).toBe(true);
    expect(out).toContain(`body=${encodeURIComponent(`${message} ${url}`)}`);
  });

  it("reddit: carries url + title", () => {
    const out = buildShareUrl("reddit", { url, message });
    expect(out).toContain(`url=${encodeURIComponent(url)}`);
    expect(out).toContain(`title=${encodeURIComponent(message)}`);
  });

  it("never leaves a raw space in any platform's output", () => {
    for (const id of SHARE_PLATFORM_IDS) {
      expect(buildShareUrl(id, { url, message })).not.toMatch(/ /);
    }
  });
});

describe("parseEnabledPlatforms", () => {
  it("drops unknown ids", () => {
    expect(parseEnabledPlatforms(["twitter", "myspace", "reddit"])).toEqual([
      "twitter",
      "reddit",
    ]);
  });

  it("dedupes and returns the canonical order regardless of input order", () => {
    expect(parseEnabledPlatforms(["reddit", "twitter", "twitter"])).toEqual([
      "twitter",
      "reddit",
    ]);
  });

  it("handles undefined / null / empty", () => {
    expect(parseEnabledPlatforms(undefined)).toEqual([]);
    expect(parseEnabledPlatforms(null)).toEqual([]);
    expect(parseEnabledPlatforms([])).toEqual([]);
  });
});

describe("platform metadata", () => {
  it("only facebook + linkedin lack custom-text support", () => {
    const noText = SHARE_PLATFORM_IDS.filter((id) => !getSharePlatform(id).supportsText);
    expect(noText).toEqual(["facebook", "linkedin"]);
  });

  it("isSharePlatformId narrows known ids only", () => {
    expect(isSharePlatformId("twitter")).toBe(true);
    expect(isSharePlatformId("nope")).toBe(false);
    expect(isSharePlatformId(123)).toBe(false);
  });
});
