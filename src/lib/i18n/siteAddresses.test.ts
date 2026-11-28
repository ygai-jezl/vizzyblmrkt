import { describe, expect, it } from "vitest";
import { asFolder, cleanSiteAddresses, sameAddresses, versionAddressOf } from "./siteAddresses";

/** A site folder per language (PAGE_LANGUAGES_ENABLED). Made-up addresses. */

describe("site folders", () => {
  it("keeps only languages in the list other than the default, each ending in a slash", () => {
    expect(cleanSiteAddresses({ en: "https://a.example/blog", fr: "https://a.example/fr/blog", de: "", es: "https://a.example/es/" }, ["en", "fr", "de"], "en")).toEqual({
      fr: "https://a.example/fr/blog/",
    });
    expect(cleanSiteAddresses(null, ["en"], "en")).toEqual({});
  });

  it("puts a version at its folder and the article's slug", () => {
    expect(versionAddressOf("https://a.example/fr/blog", "/ai-search/")).toBe("https://a.example/fr/blog/ai-search");
    expect(versionAddressOf(null, "ai-search")).toBeNull();
    expect(versionAddressOf("https://a.example/fr/", " ")).toBeNull();
    expect(asFolder("https://a.example/fr/")).toBe("https://a.example/fr/");
  });

  it("compares two sets of folders", () => {
    expect(sameAddresses({ fr: "x/", de: "y/" }, { de: "y/", fr: "x/" })).toBe(true);
    expect(sameAddresses({ fr: "x/" }, { fr: "z/" })).toBe(false);
  });
});
