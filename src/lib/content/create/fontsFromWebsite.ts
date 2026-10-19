import { safeFetch, readTextCapped } from "@/lib/security/ssrf";
import { fetchHomepage } from "./homepage";
import { sanitizeFontFamily } from "@/lib/content/fonts";
import type { SiteFont, SiteFonts } from "@/lib/types/imageStyle";

/**
 * Best estimate of a brand's fonts from its WEBSITE, for images when no font was uploaded.
 * Reads the homepage HTML and up to six linked stylesheets as TEXT, never a font file: Google
 * Fonts links name their families in the address, `@font-face` rules are not followed, and the
 * `font-family` on body and headings (through CSS variables and next/font class names) says
 * which family each role uses. Each family becomes one images can actually use:
 *  - google: the family itself is on Google Fonts;
 *  - match: a paid, custom or system font, so the closest free Google family.
 * Never persists (the Fonts page saves what the person accepts). Null when the site can't be read.
 */

const FETCH_TIMEOUT_MS = 5000;
const MAX_STYLESHEETS = 6;
const MAX_STYLESHEET_BYTES = 512 * 1024;
/** The User-Agent sent to brand websites when BRAND_FONTS_USER_AGENT is unset. Names the product, not a deployment. */
export const DEFAULT_BRAND_FONTS_USER_AGENT = "YouGrow-BrandFonts/1.0";

/**
 * The User-Agent on every homepage and stylesheet this reads. A deployment sets
 * BRAND_FONTS_USER_AGENT to name itself; a value with a line break is ignored.
 */
export function brandFontsUserAgent(env: Record<string, string | undefined> = process.env): string {
  const value = env.BRAND_FONTS_USER_AGENT?.trim();
  return value && !/[\r\n]/.test(value) ? value : DEFAULT_BRAND_FONTS_USER_AGENT;
}

export interface SiteFontDeps {
  homepage: (domain: string) => Promise<{ html: string; baseUrl: string } | null>;
  stylesheet: (url: string) => Promise<string | null>;
  isGoogleFamily: (family: string) => Promise<boolean>;
}

const GENERIC = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif",
  "ui-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong", "inherit", "initial",
  "unset", "revert",
]);
const EMOJI = /emoji|symbol/i;
/** Names that mean "the device's own font". */
const SYSTEM = new Set([
  "-apple-system", "blinkmacsystemfont", "segoe ui", "sf pro", "sf pro text", "sf pro display",
  ".sfnstext-regular", "san francisco",
]);
/** Fonts that follow the system names in a system stack (Android, Linux); fallbacks, not choices. */
const SYSTEM_COMPANIONS = [
  "roboto", "oxygen", "oxygen-sans", "ubuntu", "cantarell", "fira sans", "droid sans",
  "helvetica neue", "helvetica", "arial", "noto sans", "liberation sans",
];
/** Companions that are on Google Fonts, in the case Google spells them. */
const GOOGLE_COMPANION: Record<string, string> = {
  roboto: "Roboto",
  oxygen: "Oxygen",
  ubuntu: "Ubuntu",
  cantarell: "Cantarell",
  "fira sans": "Fira Sans",
  "noto sans": "Noto Sans",
};

/** Popular Google families, so the common case needs no lookup. Lowercase key, Google's case. */
const KNOWN_GOOGLE = new Map(
  [
    "Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Nunito", "Nunito Sans",
    "Work Sans", "Raleway", "Playfair Display", "Merriweather", "Lora", "DM Sans",
    "DM Serif Display", "Manrope", "Plus Jakarta Sans", "Space Grotesk", "IBM Plex Sans",
    "IBM Plex Serif", "IBM Plex Mono", "Source Sans 3", "Source Serif 4", "Noto Sans",
    "Noto Serif", "PT Sans", "PT Serif", "Rubik", "Karla", "Mulish", "Outfit", "Figtree",
    "Urbanist", "Sora", "Jost", "Barlow", "Fira Sans", "Ubuntu", "Oswald", "Archivo",
    "Libre Franklin", "Libre Baskerville", "Crimson Text", "EB Garamond", "Cormorant Garamond",
    "Fraunces", "Bitter", "Josefin Sans", "Quicksand", "Cabin", "Hind", "Arimo", "Tinos",
    "Geist", "Geist Mono", "JetBrains Mono", "Roboto Mono", "Space Mono", "Lexend",
    "Red Hat Display", "Red Hat Text", "Be Vietnam Pro", "Public Sans", "Epilogue", "Syne",
    "Instrument Sans", "Instrument Serif", "Onest", "Albert Sans", "Schibsted Grotesk",
    "Bricolage Grotesque", "Gelasio", "Courier Prime", "Bodoni Moda", "Libre Caslon Text",
    "Oxygen", "Cantarell", "Roboto Flex", "Roboto Slab", "Noto Sans Display", "Mona Sans",
  ].map((f) => [f.toLowerCase(), f] as const),
);

/** Paid or proprietary families and the free Google family closest in feel. */
const PAID_MATCH: Record<string, string> = {
  "helvetica neue": "Inter", helvetica: "Inter", arial: "Arimo", "sf pro": "Inter",
  futura: "Jost", "futura pt": "Jost", avenir: "Nunito Sans", "avenir next": "Nunito Sans",
  "proxima nova": "Montserrat", gotham: "Montserrat", circular: "DM Sans", "gt walsheim": "DM Sans",
  graphik: "Inter", "söhne": "Inter", sohne: "Inter", "gt america": "Inter", "aktiv grotesk": "Inter",
  "neue haas grotesk": "Inter", "neue haas unica": "Inter", "akzidenz-grotesk": "Inter",
  univers: "Inter", "neue montreal": "Inter", matter: "Inter", calibre: "Inter",
  "founders grotesk": "Inter", aeonik: "Manrope", "euclid circular a": "Manrope",
  "euclid circular b": "Manrope", satoshi: "Manrope", "general sans": "Manrope",
  gilroy: "Plus Jakarta Sans", "sofia pro": "Nunito Sans", "museo sans": "Mulish",
  apercu: "Work Sans", "brandon grotesque": "Josefin Sans", "gill sans": "Lato",
  "myriad pro": "PT Sans", frutiger: "Hind", din: "Barlow", "cabinet grotesk": "Space Grotesk",
  "clash display": "Space Grotesk", "times new roman": "Tinos", times: "Tinos", georgia: "Gelasio",
  garamond: "EB Garamond", "adobe garamond": "EB Garamond", baskerville: "Libre Baskerville",
  didot: "Playfair Display", bodoni: "Bodoni Moda", caslon: "Libre Caslon Text",
  tiempos: "Source Serif 4", "tiempos headline": "Source Serif 4", "tiempos text": "Source Serif 4",
  "freight text": "Source Serif 4", "freight display": "Playfair Display",
  canela: "Cormorant Garamond", "gt sectra": "Fraunces", publico: "Source Serif 4",
  recoleta: "Fraunces", menlo: "JetBrains Mono", monaco: "JetBrains Mono", consolas: "JetBrains Mono",
  "sf mono": "JetBrains Mono", "courier new": "Courier Prime", courier: "Courier Prime",
};

/** Look a family up in a table, also without a trailing Std / Pro / Text / Display / Web / XX. */
function lookup<T>(table: Record<string, T> | Map<string, T>, family: string): T | undefined {
  const key = family.toLowerCase();
  const get = (k: string) => (table instanceof Map ? table.get(k) : table[k]);
  return get(key) ?? get(key.replace(/\s+(std|pro|text|display|web|xx|variable|vf)$/i, ""));
}

/**
 * A family's free Google twin with no lookup: itself when it's a popular Google family, the
 * closest match when it's a known paid one, else null (unknown: may still be on Google Fonts).
 */
export function freeMatchFor(family: string): { family: string; source: "google" | "match" } | null {
  const google = lookup(KNOWN_GOOGLE, family);
  if (google) return { family: google, source: "google" };
  const paid = lookup(PAID_MATCH, family);
  return paid ? { family: paid, source: "match" } : null;
}

/** The family a generic name falls back to when the site's own font can't be identified. */
function genericMatch(generic: "sans" | "serif" | "mono"): string {
  return generic === "serif" ? "Source Serif 4" : generic === "mono" ? "JetBrains Mono" : "Inter";
}

/** next/font hashes its families (`__Inter_d65c78`); its `_Fallback_` twin is skipped. */
function unhash(name: string): string | null {
  const m = /^__(.+?)_(Fallback_)?[0-9a-f]{6,}$/i.exec(name);
  if (!m) return name;
  return m[2] ? null : m[1]!.replace(/_/g, " ");
}

/** Split a font-family value on commas outside quotes and parentheses. */
function splitStack(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let depth = 0;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

interface Rule {
  selectors: string[];
  body: string;
}

function parseRules(css: string): Rule[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    rules.push({ selectors: m[1]!.split(",").map((s) => s.trim()), body: m[2]! });
  }
  return rules;
}

function declaration(body: string, prop: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${prop.replace(/[-]/g, "\\-")}\\s*:\\s*([^;]+)`, "gi");
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) last = m[1]!.replace(/!important/i, "").trim();
  return last;
}

/** The family list of a rule: `font-family`, else the family part of a `font` shorthand. */
function familyValue(body: string): string | null {
  const ff = declaration(body, "font-family");
  if (ff) return ff;
  const font = declaration(body, "font");
  if (!font || /^var\(/i.test(font)) return null;
  const m = /(?:^|\s)[\d.]+(?:px|r?em|pt|%)(?:\s*\/\s*[\d.]+[a-z%]*)?\s+(.+)$/i.exec(font);
  return m ? m[1]! : null;
}

interface CssFacts {
  body: string[] | null;
  heading: string[] | null;
}

/**
 * Which family stack body text and headings use, from the page's CSS. Body: a rule on `body`
 * beats `html` beats `:root`, then a class on the <body> or <html> tag (next/font, Tailwind's
 * font-sans); the last such rule wins, as in the cascade. Headings: a rule on h1, else h2.
 * CSS variables are followed (up to four deep).
 */
export function familyStacks(html: string, css: string): CssFacts {
  const rules = parseRules(css);
  const vars = new Map<string, string>();
  const rootish = (s: string) => s === ":root" || s === "html" || s === "body" || s.startsWith(":root");
  for (const preferRoot of [true, false]) {
    for (const r of rules) {
      if (preferRoot !== r.selectors.some(rootish)) continue;
      const re = /(?:^|;)\s*(--[\w-]+)\s*:\s*([^;]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(r.body)) !== null) {
        if (preferRoot || !vars.has(m[1]!)) vars.set(m[1]!, m[2]!.trim());
      }
    }
  }
  const resolve = (value: string, depth = 0): string[] => {
    const out: string[] = [];
    for (const part of splitStack(value)) {
      const v = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/i.exec(part);
      if (v) {
        const target = vars.get(v[1]!);
        if (target && depth < 4) out.push(...resolve(target, depth + 1));
        else if (v[2]) out.push(...resolve(v[2], depth + 1));
      } else {
        const name = unhash(part);
        if (name) out.push(name);
      }
    }
    return out;
  };

  const tagClasses = (tag: "body" | "html") =>
    (new RegExp(`<${tag}\\b[^>]*\\bclass=["']([^"']+)["']`, "i").exec(html)?.[1] ?? "").split(/\s+/).filter(Boolean);
  const classes = new Set([...tagClasses("body"), ...tagClasses("html")].map((c) => `.${c}`));

  const pick = (match: (s: string) => boolean): string[] | null => {
    let found: string[] | null = null;
    for (const r of rules) {
      if (!r.selectors.some(match)) continue;
      const value = familyValue(r.body);
      if (!value || /^(inherit|initial|unset|revert)$/i.test(value)) continue;
      const stack = resolve(value);
      if (stack.length) found = stack;
    }
    return found;
  };
  const body =
    pick((s) => s === "body") ??
    pick((s) => s === "html") ??
    pick((s) => s === ":root") ??
    pick((s) => classes.has(s));
  const heading = pick((s) => s === "h1") ?? pick((s) => s === "h2");
  return { body, heading };
}

/** Families named in Google Fonts links and @imports: `?family=Inter:wght@400;700&family=Lora`. */
export function googleFamiliesIn(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /fonts\.googleapis\.com\/css2?\?([^"'()\s>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const query = m[1]!.replace(/&amp;/g, "&");
    for (const pair of query.split("&")) {
      const [k, v] = pair.split("=");
      if (k !== "family" || !v) continue;
      for (const fam of decodeURIComponent(v.replace(/\+/g, " ")).split("|")) {
        const name = sanitizeFontFamily(fam.split(":")[0]!);
        if (name) out.set(name.toLowerCase(), name);
      }
    }
  }
  return out;
}

/** Stylesheet addresses from `<link rel="stylesheet">`, https only, never a font file. */
export function stylesheetLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const re = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < MAX_STYLESHEETS) {
    const tag = m[0];
    if (!/\brel=["']?stylesheet\b/i.test(tag)) continue;
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    try {
      const u = new URL(href.replace(/&amp;/g, "&"), baseUrl);
      if (u.protocol !== "https:") continue;
      if (u.hostname === "fonts.googleapis.com") continue; // its families are in the address
      if (/\.(woff2?|ttf|otf|eot)$/i.test(u.pathname)) continue;
      if (!out.includes(u.toString())) out.push(u.toString());
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Turn a stack into the family images use. */
async function chooseFamily(
  stack: string[] | null,
  onPage: Map<string, string>,
  isGoogleFamily: (f: string) => Promise<boolean>,
): Promise<{ font: SiteFont; system: boolean } | null> {
  if (!stack?.length) return null;
  let generic: "sans" | "serif" | "mono" = "sans";
  for (const f of stack) {
    const l = f.toLowerCase();
    if (l === "serif" || l === "ui-serif") generic = "serif";
    if (l === "monospace" || l === "ui-monospace") generic = "mono";
  }
  let sawSystem = false;
  for (const raw of stack) {
    const family = sanitizeFontFamily(raw);
    const l = raw.toLowerCase();
    if (GENERIC.has(l) || EMOJI.test(l)) {
      if (l === "system-ui" || l === "ui-sans-serif") sawSystem = true;
      continue;
    }
    if (SYSTEM.has(l)) {
      sawSystem = true;
      continue;
    }
    if (!family) continue;
    if (sawSystem && SYSTEM_COMPANIONS.includes(l)) continue;
    const google = onPage.get(l) ?? lookup(KNOWN_GOOGLE, family);
    if (google) return { font: { family: google, detected: family, source: "google" }, system: false };
    const paid = lookup(PAID_MATCH, family);
    if (paid) return { font: { family: paid, detected: family, source: "match" }, system: false };
    if (await isGoogleFamily(family).catch(() => false)) {
      return { font: { family, detected: family, source: "google" }, system: false };
    }
    return { font: { family: genericMatch(generic), detected: family, source: "match" }, system: false };
  }
  // Only system fonts: the first Google family the stack itself names (Roboto on most sites).
  const companion = stack.map((f) => GOOGLE_COMPANION[f.toLowerCase()]).find(Boolean);
  const family = generic === "sans" ? (companion ?? "Roboto") : generic === "serif" ? "Noto Serif" : "Roboto Mono";
  return { font: { family, detected: null, source: "match" }, system: true };
}

const defaultDeps: SiteFontDeps = {
  homepage: (domain) => fetchHomepage(domain, { userAgent: brandFontsUserAgent(), timeoutMs: 8000 }),
  async stylesheet(url) {
    try {
      const res = await safeFetch(
        url,
        { headers: { "User-Agent": brandFontsUserAgent(), Accept: "text/css" } },
        { timeoutMs: FETCH_TIMEOUT_MS, maxRedirects: 3 },
      );
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!res.ok || !ct.includes("text/css")) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      return await readTextCapped(res, MAX_STYLESHEET_BYTES);
    } catch {
      return null;
    }
  },
  // Asks Google Fonts for the family's stylesheet (text) and only looks at the status.
  async isGoogleFamily(family) {
    try {
      const res = await safeFetch(
        `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}`,
        { headers: { Accept: "text/css" } },
        { timeoutMs: 4000, maxRedirects: 0 },
      );
      await res.body?.cancel().catch(() => {});
      return res.ok;
    } catch {
      return false;
    }
  },
};

export async function detectSiteFonts(
  domain: string,
  deps: SiteFontDeps = defaultDeps,
  now = new Date(),
): Promise<SiteFonts | null> {
  const host = domain.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  if (!host) return null;
  const page = await deps.homepage(host);
  if (!page) return null;
  const sheets = await Promise.all(stylesheetLinks(page.html, page.baseUrl).map((u) => deps.stylesheet(u)));
  const inline = [...page.html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!);
  const css = [...sheets.filter((s): s is string => !!s), ...inline].join("\n");
  const onPage = googleFamiliesIn(`${page.html}\n${css}`);
  const stacks = familyStacks(page.html, css);

  const body = await chooseFamily(stacks.body, onPage, deps.isGoogleFamily);
  const headingStack = stacks.heading && stacks.heading.join() !== stacks.body?.join() ? stacks.heading : null;
  const heading = (await chooseFamily(headingStack, onPage, deps.isGoogleFamily)) ?? body;
  return {
    heading: heading?.font ?? null,
    body: body?.font ?? null,
    domain: host.slice(0, 253),
    detectedAt: now.toISOString(),
    ...(body?.system && (heading?.system ?? true) ? { systemOnly: true } : {}),
  };
}
