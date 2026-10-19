import { afterEach, describe, expect, it, vi } from "vitest";
import { isCanonicalHost, siteEmbedScriptSrc, siteMetadataBase, siteOrigin, siteWaitlistCampaign } from "./flags";
import { AI_BOTS, CONTENT_SIGNAL, robotsTxt } from "./robots";
import { sitemapEntries, sitemapXml } from "./sitemap";
import { serializeJsonLd, siteGraph, baseGraph } from "./jsonLd";
import { siteMetadata } from "./metadata";
import { resolveFeature, resolveLang, resolveStage } from "./routes";
import { siteLlmsTxt } from "./llms";

const ORIGIN = "https://yougrow.ai";
const on = (...names: string[]) => { for (const n of names) vi.stubEnv(n, "true"); };

afterEach(() => vi.unstubAllEnvs());

describe("origin", () => {
  it("is NEXT_PUBLIC_SITE_ORIGIN, else the platform origin, else none (no built-in host)", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_ORIGIN", "");
    expect(siteOrigin()).toBe("");
    expect(siteMetadataBase()).toBeUndefined();
    expect(isCanonicalHost("localhost:3002")).toBe(false);
    expect(siteEmbedScriptSrc()).toBe("/embed.js");
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_ORIGIN", "https://app.example.com/");
    expect(siteOrigin()).toBe("https://app.example.com");
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", " https://www.example.com/ ");
    expect(siteOrigin()).toBe("https://www.example.com");
    expect(siteEmbedScriptSrc()).toBe("https://www.example.com/embed.js");
    expect(siteMetadataBase()?.toString()).toBe("https://www.example.com/");
  });

  it("only the canonical host is canonical", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_ORIGIN", "https://yougrow.ai/");
    expect(isCanonicalHost("yougrow.ai")).toBe(true);
    expect(isCanonicalHost("YouGrow.ai")).toBe(true);
    expect(isCanonicalHost("vizzybl-marketing-prod--vizzybl-marketing-prod.us-central1.hosted.app")).toBe(false);
    expect(isCanonicalHost("localhost:3002")).toBe(false);
    expect(isCanonicalHost(null)).toBe(false);
  });

  it("embeds the configured waitlist campaign only", () => {
    vi.stubEnv("SITE_WAITLIST_CAMPAIGN", "");
    expect(siteWaitlistCampaign()).toBe("");
    vi.stubEnv("SITE_WAITLIST_CAMPAIGN", " spring-launch ");
    expect(siteWaitlistCampaign()).toBe("spring-launch");
    vi.stubEnv("SITE_WAITLIST_CAMPAIGN", '"><script>');
    expect(siteWaitlistCampaign()).toBe("");
  });
});

describe("robots.txt", () => {
  it("welcomes every crawler on the canonical host, by name too, and points at the sitemap", () => {
    const txt = robotsTxt(ORIGIN, { indexable: true });
    expect(txt).toMatch(/^User-agent: \*\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: \/\n/m);
    for (const bot of ["GPTBot", "ClaudeBot", "Google-Extended", "PerplexityBot", "CCBot", "Applebot-Extended", "Googlebot"]) {
      expect(txt).toContain(`User-agent: ${bot}\n`);
    }
    // The named group repeats the rules (a named bot ignores the * group).
    expect(txt.split(`Content-Signal: ${CONTENT_SIGNAL}`)).toHaveLength(3);
    expect(txt.split("Disallow: /admin\n")).toHaveLength(3);
    expect(txt).toContain("Disallow: /api/\n");
    expect(txt).not.toMatch(/^Disallow: \/$/m);
    expect(txt).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    expect(AI_BOTS.length).toBeGreaterThan(100);
  });

  it("keeps every other host out of search", () => {
    expect(robotsTxt(ORIGIN, { indexable: false })).toMatch(/User-agent: \*\nDisallow: \/\n/);
  });
});

describe("sitemap.xml", () => {
  it("lists only the homepage while the loop is off", () => {
    expect(sitemapEntries(ORIGIN).map((e) => e.loc)).toEqual([`${ORIGIN}/`]);
  });

  it("lists the loop pages, then every language with hreflang alternates", () => {
    on("SITE_LOOP_ENABLED");
    const en = sitemapEntries(ORIGIN);
    expect(en).toHaveLength(18);
    expect(en.map((e) => e.loc)).toContain(`${ORIGIN}/features/brand-kit`);
    expect(en[0]!.alternates).toBeUndefined();

    on("SITE_LANGUAGES_ENABLED");
    const all = sitemapEntries(ORIGIN);
    expect(all).toHaveLength(108);
    const plan = all.find((e) => e.loc === `${ORIGIN}/ja/loop/plan`)!;
    expect(plan.alternates).toMatchObject({ en: `${ORIGIN}/loop/plan`, ar: `${ORIGIN}/ar/loop/plan`, "x-default": `${ORIGIN}/loop/plan` });
    expect(Object.keys(plan.alternates!)).toHaveLength(7);
    const xml = sitemapXml(all);
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9" xmlns:xhtml="http:\/\/www.w3.org\/1999\/xhtml">/);
    expect(xml.match(/<url>/g)).toHaveLength(108);
    expect(xml).toContain(`<xhtml:link rel="alternate" hreflang="fr" href="${ORIGIN}/fr/features/content-canvas"/>`);
  });

  it("adds the developer docs and help pages when they are on", () => {
    on("DEVELOPERS_DOCS_ENABLED", "NEXT_PUBLIC_HELP_PAGES_ENABLED");
    const locs = sitemapEntries(ORIGIN).map((e) => e.loc);
    expect(locs).toContain(`${ORIGIN}/developers`);
    expect(locs).toContain(`${ORIGIN}/help`);
  });
});

describe("JSON-LD", () => {
  it("describes a feature page: who we are, the page, breadcrumbs and the five steps", () => {
    const g = siteGraph(ORIGIN, "fr", { kind: "feature", slug: "journeys" })["@graph"] as Record<string, unknown>[];
    expect(g.map((x) => x["@type"])).toEqual(["Organization", "WebSite", "SoftwareApplication", "WebPage", "BreadcrumbList", "HowTo"]);
    expect(g[3]!.url).toBe(`${ORIGIN}/fr/features/email-journeys`);
    expect(g[3]!.inLanguage).toBe("fr");
    expect((g[5]!.step as unknown[]).length).toBe(5);
    expect(g[0]).toMatchObject({ sameAs: ["https://www.linkedin.com/company/yougrowai/", "https://github.com/ygai-jezl/vizzyblmrkt"], logo: { url: `${ORIGIN}/brand/yougrow-logo.png` } });
  });

  it("lists the six stages on the homepage, with the questions when asked", () => {
    const g = siteGraph(ORIGIN, "en", { kind: "home" }, { withFaq: true })["@graph"] as Record<string, unknown>[];
    expect(g.map((x) => x["@type"])).toEqual(["Organization", "WebSite", "SoftwareApplication", "WebPage", "ItemList", "FAQPage"]);
    expect((g[4]!.itemListElement as { url: string }[]).map((x) => x.url)).toContain(`${ORIGIN}/loop/understand`);
    const stage = siteGraph(ORIGIN, "ar", { kind: "stage", id: "launch" })["@graph"] as Record<string, unknown>[];
    expect(stage.map((x) => x["@type"])).toEqual(["Organization", "WebSite", "SoftwareApplication", "WebPage", "BreadcrumbList", "ItemList"]);
    expect(baseGraph(ORIGIN)["@graph"]).toHaveLength(3);
  });

  it("never lets the text close its script tag", () => {
    expect(serializeJsonLd({ name: "</script><b>" })).toBe('{"name":"\\u003c/script>\\u003cb>"}');
  });
});

describe("page metadata", () => {
  it("gives a canonical address, a share card, and hreflang only with the languages on", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", ORIGIN);
    on("SITE_LOOP_ENABLED");
    const m = siteMetadata("en", { kind: "stage", id: "plan" });
    expect(m.alternates).toEqual({ canonical: "/loop/plan" });
    expect(m.metadataBase?.toString()).toBe(`${ORIGIN}/`);
    expect(m.openGraph).toMatchObject({ url: "/loop/plan", images: [{ url: "/og/yougrow-loop.png", width: 1200, height: 630 }] });
    on("SITE_LANGUAGES_ENABLED");
    const de = siteMetadata("de", { kind: "feature", slug: "brand" });
    expect(de.alternates?.canonical).toBe("/de/features/brand-kit");
    expect(de.alternates?.languages).toMatchObject({ en: "/features/brand-kit", "x-default": "/features/brand-kit", ja: "/ja/features/brand-kit" });
  });
});

describe("routes", () => {
  it("only resolve pages whose switch is on", () => {
    expect(resolveLang(undefined)).toBeNull();
    on("SITE_LOOP_ENABLED");
    expect(resolveLang(undefined)).toBe("en");
    expect(resolveLang("fr")).toBeNull();
    expect(resolveStage(undefined, "plan")).toEqual({ lang: "en", id: "plan" });
    expect(resolveStage(undefined, "nope")).toBeNull();
    expect(resolveFeature(undefined, "brand-kit")).toEqual({ lang: "en", slug: "brand" });
    expect(resolveFeature(undefined, "brand")).toBeNull();
    on("SITE_LANGUAGES_ENABLED");
    expect(resolveLang("fr")).toBe("fr");
    expect(resolveLang("en")).toBeNull();
    expect(resolveLang("xx")).toBeNull();
    expect(resolveFeature("ar", "voice-chat")).toEqual({ lang: "ar", slug: "voice" });
  });
});

describe("llms.txt", () => {
  it("describes the site and keeps the developer index inside it, Optional last", () => {
    on("SITE_LOOP_ENABLED", "DEVELOPERS_DOCS_ENABLED");
    const txt = siteLlmsTxt(ORIGIN);
    expect(txt).toMatch(/^# YouGrow\n\n> YouGrow is an agentic marketing platform\./);
    expect(txt).toContain(`- [Plan](${ORIGIN}/loop/plan): `);
    expect(txt).toContain(`- [Brand kit](${ORIGIN}/features/brand-kit): `);
    expect(txt).toContain("For developers: Lifecycle email driven by what each user does");
    expect(txt).toContain("\n## Docs\n");
    expect(txt).toContain("\n## Machine-readable\n");
    expect(txt.lastIndexOf("## Optional")).toBeGreaterThan(txt.indexOf("## Use of this content"));
    expect(txt.match(/^# /gm)).toHaveLength(1);
  });

  it("links just the homepage while the loop is off", () => {
    const txt = siteLlmsTxt(ORIGIN);
    expect(txt).toContain(`- [Home](${ORIGIN}/): `);
    expect(txt).not.toContain("/loop/");
    expect(txt).not.toContain("## Docs");
  });
});
