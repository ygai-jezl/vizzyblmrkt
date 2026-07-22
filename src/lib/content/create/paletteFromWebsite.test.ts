import { describe, it, expect } from "vitest";
import { extractBrandImageUrl } from "./paletteFromWebsite";

describe("extractBrandImageUrl", () => {
  const base = "https://example.com/";

  it("prefers og:image over icon links", () => {
    const html = `
      <link rel="icon" href="/favicon.ico">
      <meta property="og:image" content="https://cdn.example.com/brand.png">`;
    expect(extractBrandImageUrl(html, base)).toBe("https://cdn.example.com/brand.png");
  });

  it("resolves a relative apple-touch-icon against the base URL", () => {
    const html = `<link rel="apple-touch-icon" href="/icons/touch.png">`;
    expect(extractBrandImageUrl(html, base)).toBe("https://example.com/icons/touch.png");
  });

  it("also matches name=twitter:image", () => {
    const html = `<meta name="twitter:image" content="https://example.com/tw.png">`;
    expect(extractBrandImageUrl(html, base)).toBe("https://example.com/tw.png");
  });

  it("skips non-https candidates and falls through to the next", () => {
    const html = `
      <meta property="og:image" content="http://insecure.example.com/x.png">
      <link rel="icon" href="https://example.com/ok.png">`;
    expect(extractBrandImageUrl(html, base)).toBe("https://example.com/ok.png");
  });

  it("returns null when there is no usable image", () => {
    expect(extractBrandImageUrl("<p>nothing</p>", base)).toBeNull();
    expect(
      extractBrandImageUrl(`<meta property="og:image" content="http://only-http.example/x.png">`, base),
    ).toBeNull();
  });
});
