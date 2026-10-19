import { describe, expect, it, vi } from "vitest";
import {
  brandFontsUserAgent,
  DEFAULT_BRAND_FONTS_USER_AGENT,
  detectSiteFonts,
  familyStacks,
  googleFamiliesIn,
  stylesheetLinks,
  type SiteFontDeps,
} from "./fontsFromWebsite";

const NOW = new Date("2026-10-19T12:00:00Z");

/** A site made of a homepage and stylesheets by address; records every address asked for. */
function site(html: string, sheets: Record<string, string> = {}, google: string[] = []) {
  const asked: string[] = [];
  const deps: SiteFontDeps = {
    homepage: vi.fn(async () => ({ html, baseUrl: "https://example.com/" })),
    stylesheet: vi.fn(async (url: string) => {
      asked.push(url);
      return sheets[url] ?? null;
    }),
    isGoogleFamily: vi.fn(async (f: string) => google.includes(f)),
  };
  return { deps, asked };
}

describe("detectSiteFonts", () => {
  it("a system font stack (as many sites use) resolves to Roboto, the Google family it names", async () => {
    const { deps } = site(
      `<html lang="en"><head><link rel="stylesheet" href="/_next/static/css/a.css"/></head><body></body></html>`,
      {
        "https://example.com/_next/static/css/a.css":
          `html,:host{font-family:ui-sans-serif,system-ui,sans-serif,"Apple Color Emoji"}` +
          `:root{--bg:#0a0a0f;--font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI","Roboto",sans-serif}` +
          `body,html{max-width:100vw;font-family:var(--font-sans)}h1{font-family:inherit}`,
      },
    );
    expect(await detectSiteFonts("acme.test", deps, NOW)).toEqual({
      heading: { family: "Roboto", detected: null, source: "match" },
      body: { family: "Roboto", detected: null, source: "match" },
      domain: "acme.test",
      detectedAt: "2026-10-19T12:00:00.000Z",
      systemOnly: true,
    });
    expect(deps.isGoogleFamily).not.toHaveBeenCalled();
  });

  it("Google Fonts links name the families; headings and body are told apart", async () => {
    const { deps } = site(
      `<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&amp;family=Work+Sans:wght@400;600&display=swap" rel="stylesheet">` +
        `<style>body{font:16px/1.5 "Work Sans",sans-serif}h1,h2{font-family:'Playfair Display',serif}</style>`,
    );
    const fonts = await detectSiteFonts("https://www.example.com/about", deps, NOW);
    expect(fonts).toMatchObject({
      heading: { family: "Playfair Display", detected: "Playfair Display", source: "google" },
      body: { family: "Work Sans", detected: "Work Sans", source: "google" },
      domain: "www.example.com",
    });
    expect(fonts).not.toHaveProperty("systemOnly");
  });

  it("paid fonts get a free match; an unknown brand font is looked up, then matched by kind", async () => {
    const paid = site(`<style>body{font-family:"Proxima Nova",Helvetica,sans-serif}h1{font-family:"Tiempos Headline",Georgia,serif}</style>`);
    expect(await detectSiteFonts("example.com", paid.deps, NOW)).toMatchObject({
      heading: { family: "Source Serif 4", detected: "Tiempos Headline", source: "match" },
      body: { family: "Montserrat", detected: "Proxima Nova", source: "match" },
    });

    const lookedUp = site(`<style>body{font-family:"Anek Latin",sans-serif}h1{font-family:AcmeBrandSerif,serif}</style>`, {}, ["Anek Latin"]);
    expect(await detectSiteFonts("example.com", lookedUp.deps, NOW)).toMatchObject({
      heading: { family: "Source Serif 4", detected: "AcmeBrandSerif", source: "match" },
      body: { family: "Anek Latin", detected: "Anek Latin", source: "google" },
    });
  });

  it("follows next/font class names on <body> to the family", async () => {
    const { deps } = site(
      `<html class="__variable_8b3a0b"><body class="__className_d65c78 antialiased"></body></html>`,
      {},
    );
    deps.homepage = vi.fn(async () => ({
      html: `<html class="__variable_8b3a0b"><head><style>.__className_d65c78{font-family:'__Inter_d65c78', '__Inter_Fallback_d65c78';font-style:normal}</style></head><body class="__className_d65c78 antialiased"></body></html>`,
      baseUrl: "https://example.com/",
    }));
    expect(await detectSiteFonts("example.com", deps, NOW)).toMatchObject({
      body: { family: "Inter", detected: "Inter", source: "google" },
      heading: { family: "Inter" },
    });
  });

  it("never asks for a font file, and reads at most six stylesheets", async () => {
    const links = Array.from({ length: 9 }, (_, i) => `<link rel="stylesheet" href="/s${i}.css">`).join("");
    const { deps, asked } = site(
      `<link rel="preload" as="font" href="/f/inter.woff2" crossorigin>` +
        `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">` +
        `<link rel="stylesheet" href="http://insecure.example.com/x.css">${links}` +
        `<style>@font-face{font-family:Brand;src:url(/f/brand.woff2) format("woff2")}body{font-family:Brand,sans-serif}</style>`,
    );
    await detectSiteFonts("example.com", deps, NOW);
    expect(asked).toHaveLength(6);
    expect(asked.every((u) => /^https:\/\/example\.com\/s\d\.css$/.test(u))).toBe(true);
  });

  it("null when the site can't be read; empty roles when it names no font", async () => {
    const down: SiteFontDeps = { homepage: async () => null, stylesheet: async () => null, isGoogleFamily: async () => false };
    expect(await detectSiteFonts("example.com", down, NOW)).toBeNull();
    const plain = site(`<p>hello</p>`);
    expect(await detectSiteFonts("example.com", plain.deps, NOW)).toMatchObject({ heading: null, body: null });
  });
});

describe("the CSS readers", () => {
  it("a body rule beats html, and the last one wins", () => {
    expect(familyStacks("", "html{font-family:Lato}body{font-family:Inter}body{font-family:Karla,serif}").body).toEqual(["Karla", "serif"]);
    expect(familyStacks("", "@media (min-width:1px){body{font-family:Rubik}}").body).toEqual(["Rubik"]);
  });

  it("reads Google Fonts addresses, old and new", () => {
    expect([...googleFamiliesIn("https://fonts.googleapis.com/css?family=Open+Sans|Roboto+Slab:400,700").values()]).toEqual(["Open Sans", "Roboto Slab"]);
    expect(stylesheetLinks(`<link rel=stylesheet href="/a.css">`, "https://example.com/")).toEqual(["https://example.com/a.css"]);
  });
});

describe("brandFontsUserAgent", () => {
  it("is BRAND_FONTS_USER_AGENT when set, else a neutral default that names no deployment", () => {
    expect(brandFontsUserAgent({})).toBe(DEFAULT_BRAND_FONTS_USER_AGENT);
    expect(brandFontsUserAgent({ BRAND_FONTS_USER_AGENT: "  " })).toBe(DEFAULT_BRAND_FONTS_USER_AGENT);
    expect(brandFontsUserAgent({ BRAND_FONTS_USER_AGENT: " AcmeFonts/2.0 " })).toBe("AcmeFonts/2.0");
    expect(brandFontsUserAgent({ BRAND_FONTS_USER_AGENT: "Acme/1.0\nX-Evil: 1" })).toBe(DEFAULT_BRAND_FONTS_USER_AGENT);
    expect(DEFAULT_BRAND_FONTS_USER_AGENT).toBe("YouGrow-BrandFonts/1.0");
  });
});
