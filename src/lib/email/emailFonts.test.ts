import { readFileSync, readdirSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { EMAIL_FONT_IDS, type EmailFontId } from "@/lib/types/tenant";
import nextConfig from "../../../next.config";
import {
  EMAIL_FONT_LIST,
  EMAIL_FONT_WEIGHTS,
  EMAIL_FONTS,
  FONT,
  carriesWebFonts,
  emailFontFileUrl,
  fontFor,
  hasWebFonts,
  isEmailFontId,
  isWebFont,
  webFontHead,
} from "./emailFonts";
import type { ResolvedEmailStyle } from "./emailStyle";

const WEB_FAMILIES = ["Inter", "Poppins", "Nunito", "Montserrat", "Lora", "Playfair Display"];

describe("the font table", () => {
  it("FONT is today's stack, byte for byte", () => {
    expect(FONT).toBe("system-ui,-apple-system,Segoe UI,Roboto,sans-serif");
    expect(EMAIL_FONTS.system.safeStack).toBe(FONT);
  });

  it("has every id, in order, each under its own key", () => {
    expect(Object.keys(EMAIL_FONTS).sort()).toEqual([...EMAIL_FONT_IDS].sort());
    expect(EMAIL_FONT_LIST.map((f) => f.id)).toEqual([...EMAIL_FONT_IDS]);
    for (const [key, font] of Object.entries(EMAIL_FONTS)) expect(font.id).toBe(key);
  });

  it("ships six web families, and five safe fonts", () => {
    expect(EMAIL_FONT_LIST.flatMap((f) => (f.web ? [f.web.family] : []))).toEqual(WEB_FAMILIES);
    expect(EMAIL_FONT_LIST.filter((f) => !f.web).map((f) => f.label)).toEqual([
      "System",
      "Arial",
      "Georgia",
      "Verdana",
      "Trebuchet MS",
    ]);
  });

  it("every safe stack ends in a generic family and never names a web family", () => {
    for (const font of EMAIL_FONT_LIST) {
      expect(font.safeStack).toMatch(/,(sans-serif|serif)$/);
      for (const family of WEB_FAMILIES) expect(font.safeStack).not.toContain(family);
      // Inline in style="…", so no double quotes.
      expect(font.safeStack).not.toContain('"');
    }
  });

  it("a web font's safe stack is the one its fallback names", () => {
    expect(EMAIL_FONTS.inter.safeStack).toBe("'Segoe UI',Helvetica,Arial,sans-serif");
    expect(EMAIL_FONTS.inter.web?.fallback).toBe("Segoe UI or Helvetica");
    expect(EMAIL_FONTS.lora.safeStack).toBe("Georgia,'Times New Roman',Times,serif");
    for (const font of EMAIL_FONT_LIST) {
      if (!font.web) continue;
      // The fonts it names are the ones the stack leads with, so the page never names one an inbox skips.
      const named = font.web.fallback.split(" or ").map((name) => (name.includes(" ") ? `'${name}'` : name));
      expect(font.safeStack.startsWith(`${named.join(",")},`)).toBe(true);
      expect(font.safeStack).toBe(font.web.fallback === "Georgia" ? EMAIL_FONTS.georgia.safeStack : EMAIL_FONTS.inter.safeStack);
    }
  });

  it("isEmailFontId takes ids only, never CSS or inherited keys", () => {
    expect(isEmailFontId("playfair-display")).toBe(true);
    for (const id of ["Inter", "'Inter',sans-serif", "toString", "__proto__", "", null, 1]) expect(isEmailFontId(id)).toBe(false);
    expect(isWebFont("inter")).toBe(true);
    expect(isWebFont("georgia")).toBe(false);
  });
});

describe("fontFor", () => {
  it("no style or no theme → today's FONT for both", () => {
    expect(fontFor(null, "body")).toBe(FONT);
    expect(fontFor(undefined, "heading")).toBe(FONT);
    expect(fontFor({}, "heading")).toBe(FONT);
  });

  it("a theme → each role's safe stack, never the web family inline", () => {
    const style = { theme: { preset: "editorial", headingFont: "lora", bodyFont: "verdana" } as const };
    expect(fontFor(style, "heading")).toBe("Georgia,'Times New Roman',Times,serif");
    expect(fontFor(style, "body")).toBe("Verdana,Geneva,sans-serif");
  });

  it("an id it doesn't know (a style built by hand) → today's FONT", () => {
    const style = { theme: { preset: "modern", headingFont: "comic-sans", bodyFont: "inter" } } as unknown as Parameters<
      typeof fontFor
    >[0];
    expect(fontFor(style, "heading")).toBe(FONT);
    expect(fontFor(style, "body")).toBe(EMAIL_FONTS.inter.safeStack);
  });
});

describe("the web font block", () => {
  const ORIGIN = "https://app.example.com";
  /** null = no origin, as the resolver leaves it with web fonts off. */
  const theme = (headingFont: EmailFontId, bodyFont: EmailFontId, webFontOrigin: string | null = ORIGIN) => ({
    theme: { preset: "modern" as const, headingFont, bodyFont, ...(webFontOrigin !== null ? { webFontOrigin } : {}) },
  });
  const urls = (head: string) => [...head.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]!);

  it("nothing without a theme, a web font in it, or a usable origin", () => {
    const none: Array<Pick<ResolvedEmailStyle, "theme"> | null | undefined> = [
      null,
      undefined,
      {},
      theme("inter", "inter", null), // web fonts off
      theme("georgia", "verdana"), // safe fonts only
      theme("inter", "inter", ""),
      theme("inter", "inter", "http://app.example.com"),
      theme("inter", "inter", "https://app.example.com/"),
      theme("inter", "inter", "https://app.example.com/x"),
      theme("inter", "inter", "https://app.example.com) format('woff');}x{"),
      theme("inter", "inter", "https://user@app.example.com"),
      // Built by hand: a font it doesn't know, or a look the shell doesn't draw.
      { theme: { preset: "modern", headingFont: "comic-sans", bodyFont: "inter", webFontOrigin: ORIGIN } } as unknown as Pick<
        ResolvedEmailStyle,
        "theme"
      >,
      { theme: { preset: "brutalist", headingFont: "inter", bodyFont: "inter", webFontOrigin: ORIGIN } } as unknown as Pick<
        ResolvedEmailStyle,
        "theme"
      >,
    ];
    for (const style of none) {
      expect(webFontHead(style)).toBe("");
      expect(hasWebFonts(style)).toBe(false);
    }
  });

  it("Modern (Inter for both): one family at 400 and 700, hidden from Outlook for Windows", () => {
    const head = webFontHead(theme("inter", "inter"));
    expect(head).toMatchInlineSnapshot(`
      "<!--[if !mso]><!--><style data-vzb-fonts>
      @font-face{font-family:'Inter';font-style:normal;font-weight:400;src:url(https://app.example.com/email-fonts/inter-400.v1.woff2) format('woff2'),url(https://app.example.com/email-fonts/inter-400.v1.woff) format('woff');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
      @font-face{font-family:'Inter';font-style:normal;font-weight:700;src:url(https://app.example.com/email-fonts/inter-700.v1.woff2) format('woff2'),url(https://app.example.com/email-fonts/inter-700.v1.woff) format('woff');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
      @media screen{.vzb-card,.vzb-card td,.vzb-card p,.vzb-card div,.vzb-card a,.vzb-card span,.vzb-card li{font-family:'Inter','Segoe UI',Helvetica,Arial,sans-serif!important}.vzb-card h1,.vzb-card h1 a,.vzb-card h1 span,.vzb-card h2,.vzb-card h2 a,.vzb-card h2 span,.vzb-card h3,.vzb-card h3 a,.vzb-card h3 span,.vzb-h{font-family:'Inter','Segoe UI',Helvetica,Arial,sans-serif!important}}
      </style><!--<![endif]-->"
    `);
    expect(head.startsWith("<!--[if !mso]><!--><style data-vzb-fonts>")).toBe(true);
    expect(head.endsWith("</style><!--<![endif]-->")).toBe(true);
    expect(carriesWebFonts(head)).toBe(true);
    // Well under Gmail's 102 KB clipping point.
    expect(head.length).toBeLessThan(2048);
  });

  it("two web families: heading first, each at 400 and 700; each rule names its own", () => {
    const head = webFontHead(theme("poppins", "nunito"));
    expect([...head.matchAll(/@font-face\{font-family:'([^']+)';font-style:normal;font-weight:(\d+);/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
      "Poppins 400",
      "Poppins 700",
      "Nunito 400",
      "Nunito 700",
    ]);
    expect(head).toContain(".vzb-card li{font-family:'Nunito','Segoe UI',Helvetica,Arial,sans-serif!important}");
    expect(head).toContain(".vzb-h{font-family:'Poppins','Segoe UI',Helvetica,Arial,sans-serif!important}");
    expect(head.length).toBeLessThan(2048);
  });

  it("a link or span in a heading takes the heading font, not the body font its own tag would match", () => {
    const head = webFontHead(theme("lora", "inter"));
    // The two rules inside @media screen{}: the body font's, then the heading font's.
    const rules = [...head.matchAll(/([^{}]+)\{font-family:([^}]+)!important\}/g)].map((m) => ({
      selectors: m[1]!.split(","),
      stack: m[2]!,
    }));
    expect(rules).toHaveLength(2);
    const [body, heading] = rules;
    expect(body!.stack).toBe(`'Inter',${EMAIL_FONTS.inter.safeStack}`);
    expect(heading!.stack).toBe(`'Lora',${EMAIL_FONTS.lora.safeStack}`);
    for (const h of ["h1", "h2", "h3"]) {
      // `.vzb-card a` (0,1,1) matches the link itself; `.vzb-card h2 a` (0,1,2) wins over it.
      for (const t of ["a", "span"]) {
        expect(body!.selectors).toContain(`.vzb-card ${t}`);
        expect(heading!.selectors).toContain(`.vzb-card ${h} ${t}`);
      }
    }
    expect(heading!.selectors.at(-1)).toBe(".vzb-h");
  });

  it("one web font beside a safe one: only it loads, and the other role keeps its safe stack", () => {
    const editorial = webFontHead(theme("lora", "georgia"));
    expect(editorial.match(/@font-face/g)).toHaveLength(2);
    expect(editorial).toContain("font-family:'Lora';");
    expect(editorial).toContain(`.vzb-card li{font-family:${EMAIL_FONTS.georgia.safeStack}!important}`);
    expect(editorial).toContain(`.vzb-h{font-family:'Lora',${EMAIL_FONTS.georgia.safeStack}!important}`);
    const playfair = webFontHead(theme("system", "playfair-display"));
    expect(playfair).toContain("font-family:'Playfair Display';");
    expect(playfair).toContain(`.vzb-h{font-family:${FONT}!important}`);
  });

  it("every font URL is on the origin, versioned, with no query string (a font load can't track an open)", () => {
    for (const font of EMAIL_FONT_LIST) {
      if (!font.web) continue;
      const found = urls(webFontHead(theme(font.id, font.id)));
      expect(found).toHaveLength(4);
      for (const url of found) {
        expect(url).toMatch(new RegExp(`^https://app\\.example\\.com/email-fonts/${font.id}-(400|700)\\.v1\\.(woff2|woff)$`));
        expect(url).not.toContain("?");
      }
    }
  });

  it("carriesWebFonts finds the block, not the word", () => {
    expect(carriesWebFonts("<p>data-vzb-fonts</p>")).toBe(false);
    expect(carriesWebFonts("<!doctype html><html><head></head><body><p>Hi</p></body></html>")).toBe(false);
  });
});

describe("the web font files", () => {
  const dir = new URL("../../../public/email-fonts/", import.meta.url);

  it("every file the block can name is vendored, a real woff2 or woff, beside its family's OFL licence", () => {
    const expected: string[] = [];
    for (const font of EMAIL_FONT_LIST) {
      if (!font.web) continue;
      for (const weight of EMAIL_FONT_WEIGHTS) {
        for (const format of ["woff2", "woff"] as const) {
          const name = emailFontFileUrl("", font.id, weight, format).replace("/email-fonts/", "");
          const bytes = readFileSync(new URL(name, dir));
          expect(bytes.subarray(0, 4).toString("latin1")).toBe(format === "woff2" ? "wOF2" : "wOFF");
          expected.push(name);
        }
      }
      const licence = readFileSync(new URL(`${font.id}-OFL.txt`, dir), "utf8");
      expect(licence).toContain("SIL Open Font License, Version 1.1");
      expected.push(`${font.id}-OFL.txt`);
    }
    // 6 families × 400/700 × woff2/woff, and nothing else.
    expect(expected.filter((n) => !n.endsWith(".txt"))).toHaveLength(24);
    expect(readdirSync(dir).filter((n) => !n.startsWith(".")).sort()).toEqual(expected.sort());
  });

  it("are served to any origin, cached for a year", async () => {
    const rules = (await nextConfig.headers!()).filter((r) => r.source === "/email-fonts/:path*");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.headers).toEqual([
      { key: "Access-Control-Allow-Origin", value: "*" },
      { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
    ]);
  });
});
