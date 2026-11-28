import { describe, expect, it } from "vitest";
import { alternateLinks, languageTagsFor } from "./languageTags";

/** Google's language tags (PAGE_LANGUAGES_ENABLED). Made-up addresses. */

const EN = { lang: "en", url: "https://acme.example/blog/ai" };
const FR = { lang: "fr", url: "https://acme.example/fr/blog/ai" };
const ZH = { lang: "zh", url: "https://acme.example/zh/blog/ai" };

describe("language tags", () => {
  it("lists every version and x-default the same way on each, with each canonical on itself", () => {
    const onEnglish = languageTagsFor(EN, EN, [FR, ZH]);
    const onFrench = languageTagsFor(FR, EN, [FR, ZH]);
    expect(onEnglish.split("\n")[0]).toBe('<link rel="canonical" href="https://acme.example/blog/ai">');
    expect(onFrench.split("\n")[0]).toBe('<link rel="canonical" href="https://acme.example/fr/blog/ai">');
    expect(onEnglish.split("\n").slice(1)).toEqual(onFrench.split("\n").slice(1));
    expect(alternateLinks(EN, [FR, ZH])).toEqual([
      '<link rel="alternate" hreflang="en" href="https://acme.example/blog/ai">',
      '<link rel="alternate" hreflang="fr" href="https://acme.example/fr/blog/ai">',
      '<link rel="alternate" hreflang="zh-Hans" href="https://acme.example/zh/blog/ai">',
      '<link rel="alternate" hreflang="x-default" href="https://acme.example/blog/ai">',
    ]);
  });

  it("escapes an address", () => {
    expect(alternateLinks({ lang: "en", url: 'https://a.example/x?a=1&b="2"' }, [])[0]).toContain("x?a=1&amp;b=&quot;2&quot;");
  });
});
