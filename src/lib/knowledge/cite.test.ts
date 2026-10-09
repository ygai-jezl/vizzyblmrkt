import { afterEach, describe, expect, it, vi } from "vitest";
import { CITE_TAG, isCiteSource, isCiteSourcesEnabled, isCiteSourcesUiEnabled, isWebSource, withCiteTag } from "./cite";

afterEach(() => vi.unstubAllEnvs());

describe("cite sources", () => {
  it("is off until its flag says true, server and screen each on their own", () => {
    expect(isCiteSourcesEnabled()).toBe(false);
    expect(isCiteSourcesUiEnabled()).toBe(false);
    vi.stubEnv("CREATE_BLOG_CITE_SOURCES_ENABLED", "true");
    expect(isCiteSourcesEnabled()).toBe(true);
    expect(isCiteSourcesUiEnabled()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_BLOG_CITE_SOURCES_ENABLED", "true");
    expect(isCiteSourcesUiEnabled()).toBe(true);
  });

  it("is the ordinary tag `cite`, so a source typed that way is one too", () => {
    expect(CITE_TAG).toBe("cite");
    expect(isCiteSource(["pricing", "cite"])).toBe(true);
    expect(isCiteSource(["citation"])).toBe(false);
    expect(isCiteSource(null)).toBe(false);
  });

  it("adds the tag once and takes it away, leaving the other tags alone", () => {
    expect(withCiteTag(["pricing"], true)).toEqual(["cite", "pricing"]);
    expect(withCiteTag(["cite", "pricing"], true)).toEqual(["cite", "pricing"]);
    expect(withCiteTag(["pricing", "cite"], false)).toEqual(["pricing"]);
    expect(withCiteTag(null, false)).toEqual([]);
  });

  it("never loses the tag to the cap on how many a source may carry", () => {
    const full = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const tags = withCiteTag(full, true);
    expect(tags).toHaveLength(20);
    expect(tags[0]).toBe("cite");
  });

  it("only a page on the web can be cited", () => {
    expect(isWebSource("docs_url")).toBe(true);
    expect(isWebSource("website")).toBe(true);
    expect(isWebSource("github")).toBe(false);
    expect(isWebSource(undefined)).toBe(false);
  });
});
