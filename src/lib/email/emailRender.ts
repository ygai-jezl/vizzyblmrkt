import type { EmailLayout, EmailBlock, EmailBlockKind } from "@/lib/types/emailLayout";
import { EMAIL_HEADER_IMAGE_LIMITS, EMAIL_STYLE_LIMITS } from "@/lib/types/tenant";
import { socialIconDataUri } from "./socialIcons";
import { FONT, WEB_FONT_CLASSES, fontFor, hasWebFonts, webFontHead } from "./emailFonts";
import { themeTokens, type EmailThemeTokens } from "./emailThemes";
import {
  bandInk,
  bandStops,
  isHeaderImageUrlShape,
  isLogoUrlShape,
  readableOn,
  type ResolvedEmailStyle,
} from "./emailStyle";

/**
 * Email HTML assembly — the SINGLE source of email-safe markup, shared by the send
 * compiler (src/lib/agents/compiler.ts) and the visual layout editor's preview so
 * "what you see" is byte-identical to "what is sent".
 *
 *  - wrap()               — the outer email document (centered 560px card + optional hero,
 *                           and the Email style's header band above the card when given one;
 *                           its theme, if any, sets the page colour, card and fonts).
 *  - renderEmailLayout()  — turn a block LAYOUT into email-safe (table + inline-style) inner HTML.
 *  - sanitizeEmailHtml()  — allowlist-sanitize author/AI HTML (defence in depth; the editor
 *                           preview is also sandboxed in an iframe).
 *
 * Pure + client-safe (no server imports, no Tiptap import, no env — the Email style arrives
 * as data, already resolved). {{merge_tokens}} are emitted VERBATIM — substitution happens
 * downstream in the send path (mergeVars.ts).
 */

// ── Moved verbatim from compiler.ts (send path re-imports these) ─────────────

export function looksHtml(body: string): boolean {
  return /<\w+[\s/>]/.test(body);
}

/** Wrap already-escaped plain text into paragraphs (does NOT escape). */
export function paragraphize(escaped: string): string {
  return escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export function bodyToHtml(body: string): string {
  // Broadcast path: MailChimp merge TAGS, no subscriber-controlled values here.
  return looksHtml(body) ? body : paragraphize(escapeHtml(body));
}

/**
 * The outer email document. With no `style` it's today's shell byte for byte, and a
 * `preheader` leads the card just as callers used to prepend it. With a style: light-only
 * colour-scheme metas, then the preheader, then the header band (unless the body already
 * shows a brand logo), then the card — so the band's name never becomes the inbox snippet.
 * With a band and no preheader, the card's opening words become a hidden one for the same reason.
 * A style with a theme gets the themed shell (see themedShell); without one it's today's.
 */
export function wrap(
  inner: string,
  heroImageUrl: string | null,
  opts: { style?: ResolvedEmailStyle | null; preheader?: string | null } = {},
): string {
  // Guard + escape the hero URL (author/agent-controlled) so it can't break out of the
  // src attribute or inject markup into every recipient's inbox.
  const hero =
    heroImageUrl && isSafeHref(heroImageUrl)
      ? `<img src="${escapeAttr(heroImageUrl)}" alt="" style="display:block;width:100%;max-width:560px;border-radius:12px;margin:0 0 20px"/>`
      : "";
  const pre = preheaderHtml(opts.preheader);
  const style = opts.style ?? null;
  const head = style ? COLOR_SCHEME_METAS : "";
  const band = style && !hasOwnBrandLogo(inner) ? renderHeaderBand(style) : "";
  const top = style ? `${pre || (band ? hiddenPreheader(openingWords(inner)) : "")}${band}\n  ` : "";
  const theme = themeTokens(style);
  if (style && theme) return themedShell(style, theme, { head, top, hero, inner, band: band !== "" });
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8">${head}</head><body style="margin:0;background:#f6f6f6">
  ${top}<div style="font-family:${FONT};max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
    ${hero}
    ${style ? "" : pre}${inner}
  </div>
</body></html>`;
}

/**
 * A themed email's shell. The page colour sits on a full-width wrapper table (bgcolor and
 * background-color) around the preheader, band and card, and on `<body>` too: Yahoo and AOL
 * drop `<body>` and Gmail and Outlook.com replace it, so a colour only there would vanish.
 * The card takes the theme's top and bottom padding, line height, body font and corners, and
 * keeps 24px each side so it stays 608 wide, like the band. With no band the card has all four
 * corners and page colour above it; under a band (which takes the top corners) it has the
 * bottom two. Page colour shows below it either way. Outlook for Windows draws square corners.
 * A theme with web fonts (and where to load them) adds their `<head>` block and the card's
 * class its rules target (webFontHead in emailFonts.ts); the inline fonts stay safe stacks.
 */
function themedShell(
  style: ResolvedEmailStyle,
  theme: EmailThemeTokens,
  parts: { head: string; top: string; hero: string; inner: string; band: boolean },
): string {
  const page = safeHex(theme.pageColor, "#f6f6f6");
  const r = theme.cardRadius;
  const corners = r ? `;border-radius:${parts.band ? `0 0 ${r}px ${r}px` : `${r}px`}` : "";
  const margin = parts.band ? "0 auto 24px" : "24px auto";
  const cardClass = hasWebFonts(style) ? ` class="${WEB_FONT_CLASSES.card}"` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8">${parts.head}${webFontHead(style)}</head><body style="margin:0;background:${page}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${page}" style="width:100%;background-color:${page}"><tr><td>
  ${parts.top}<div${cardClass} style="font-family:${fontFor(style, "body")};max-width:560px;margin:${margin};padding:${theme.padY}px 24px;line-height:${theme.lineHeight};color:#111;background:#fff${corners}">
    ${parts.hero}
    ${parts.inner}
  </div>
  </td></tr></table>
</body></html>`;
}

// ── Email style header band ──────────────────────────────────────────────────

/** Ask dark-mode clients that honour it to keep a styled email light — the band's colours were picked for light. */
const COLOR_SCHEME_METAS = '<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">';

/** A body that already shows a brand logo (hand-pasted or imported) gets no band, so the logo never appears twice. */
function hasOwnBrandLogo(inner: string): boolean {
  return inner.includes("/api/brand-logo/");
}

/** How much of the card's opening words a derived preheader carries: more than an inbox shows. */
export const OPENING_WORDS_MAX = 150;

/**
 * The card's opening words as an inbox reads them: comments, CSS, tags and link URLs dropped
 * (a block break reads as a space), entities kept as written so it's already HTML-safe, never
 * cut mid-entity.
 */
function openingWords(inner: string): string {
  return inner
    .replace(/<!--[\s\S]*?-->|<(style|script|title)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(p|div|h\d|li|ul|ol|br|table|tr|td|blockquote)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/</g, "&lt;")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, OPENING_WORDS_MAX)
    .replace(/&[#\w]*$/, "")
    .trimEnd();
}

/** Escape a company name, and `|` too, so Mailchimp can't expand a `*|TAG|*` in it. */
function escapeName(s: string): string {
  return escapeHtml(s).replace(/\|/g, "&#124;");
}

/** Whole pixels within 1..max — the resolver already clamps; anything else drops the logo (or the header image). */
const sizeOk = (n: number, max: number) => Number.isInteger(n) && n >= 1 && n <= max;

/** The band's width: the card's 560 + 24px padding each side. */
const BAND_WIDTH = 608;

/**
 * The band's frame around its one cell: a fixed-width MSO wrapper and a full-width table,
 * both on the header colour, so Outlook keeps the colour and the width. `corners` (a themed
 * card's top corners, else "") rounds the table as well as the cell, since both are painted.
 */
function bandFrame(bg: string, cell: string, corners = ""): string {
  return `<!--[if mso]><table role="presentation" width="${BAND_WIDTH}" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" bgcolor="${bg}" style="width:100%;max-width:${BAND_WIDTH}px;margin:0 auto;background-color:${bg}${corners}"><tr>${cell}</tr></table><!--[if mso]></td></tr></table><![endif]-->`;
}

/** The web font block's heading class, as an attribute (" class=…"), when the email carries the block; else "". */
function headingClass(style: ResolvedEmailStyle): string {
  return hasWebFonts(style) ? ` class="${WEB_FONT_CLASSES.heading}"` : "";
}

/** With a theme whose card is rounded, the band takes the card's top corners (";border-radius:…"); else "". */
function bandCorners(style: ResolvedEmailStyle): string {
  const r = themeTokens(style)?.cardRadius ?? 0;
  return r ? `;border-radius:${r}px ${r}px 0 0` : "";
}

/**
 * The header band: the logo and/or company name on the header colour, full width above the
 * card (608px = the card's 560 + 24px padding each side). `bgcolor` sits on the table AND the
 * cell, with a fixed-width MSO wrapper, so Outlook keeps the colour and the width. The logo
 * carries width/height attributes and no link. A logo URL of the wrong shape (repeated here
 * because previews run in the browser) falls back to the name — never a broken image.
 *
 * With a gradient, only the cell (which fills the band) gains a 135deg linear-gradient over
 * its background-color. No VML: every Outlook and Gmail on Android show the header colour
 * as a solid band. The text is the forced colour, else whichever reads better across both.
 *
 * With a header image (checked the same way: shape and size, else the band above), the band
 * is that banner alone, full width with no padding, on the plain header colour — no logo,
 * name, link, gradient or forced text. Its alt is the name, styled in whichever of black or
 * white reads on the header colour, so blocked images still show it. The `height` attribute
 * (the banner's height at 608 wide, from the stored size) is for Outlook for Windows, which
 * sizes by attributes; everyone else follows `height:auto`, so it stays fluid on phones.
 *
 * With a theme, the name and alt text take its heading font, and a rounded card's top corners
 * move up to the band (a full-width banner is rounded to match). With web fonts, the name and
 * the images carry the class the `<head>` block's heading rule targets.
 */
export function renderHeaderBand(style: ResolvedEmailStyle): string {
  const image =
    style.headerImage &&
    isHeaderImageUrlShape(style.headerImage.url) &&
    sizeOk(style.headerImage.width, EMAIL_HEADER_IMAGE_LIMITS.width) &&
    sizeOk(style.headerImage.height, EMAIL_HEADER_IMAGE_LIMITS.height)
      ? style.headerImage
      : null;
  if (image) return renderImageBand(style, image);
  const [bg, bg2] = bandStops(style);
  const ink = bandInk(style);
  // The cell alone: it fills the band, so painting the table too would draw the gradient twice.
  const fill = bg2
    ? `background-color:${bg};background-image:linear-gradient(135deg,${bg},${bg2})`
    : `background-color:${bg}`;
  const logo =
    style.logo &&
    isLogoUrlShape(style.logo.url) &&
    sizeOk(style.logo.width, EMAIL_STYLE_LIMITS.logoWidth) &&
    sizeOk(style.logo.height, EMAIL_STYLE_LIMITS.logoHeight)
      ? style.logo
      : null;
  // Beside a logo, only a set company name shows; without one the band shows altName.
  const text = logo ? style.name : style.altName;
  const textStyle = `font-family:${fontFor(style, "heading")};font-size:18px;line-height:1.3;font-weight:700;color:${ink}`;
  // With the name printed beside it, the logo's alt stays empty so blocked images
  // don't show the name twice.
  const alt = text ? "" : escapeName(style.altName);
  const cls = headingClass(style);
  const img = logo
    ? `<img${cls} src="${escapeAttr(logo.url)}" width="${logo.width}" height="${logo.height}" alt="${alt}" style="display:block;width:${logo.width}px;height:${logo.height}px;border:0;outline:none;text-decoration:none;${textStyle}" />`
    : "";
  const name = text ? `<span${cls} style="${textStyle}">${escapeName(text)}</span>` : "";
  const content =
    img && name
      ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle">${img}</td><td style="vertical-align:middle;padding-left:12px">${name}</td></tr></table>`
      : img || name || "&nbsp;";
  const corners = bandCorners(style);
  return bandFrame(bg, `<td bgcolor="${bg}" align="left" style="padding:16px 24px;${fill}${corners}">${content}</td>`, corners);
}

/** The Image-mode band (see renderHeaderBand): the banner alone, on the plain header colour. */
function renderImageBand(style: ResolvedEmailStyle, image: NonNullable<ResolvedEmailStyle["headerImage"]>): string {
  // The header colour alone: the gradient and a forced text colour belong to the colour band.
  const [bg] = bandStops({ headerColor: style.headerColor });
  const textStyle = `font-family:${fontFor(style, "heading")};font-size:18px;line-height:1.3;font-weight:700;color:${readableOn(bg)}`;
  const fullHeight = Math.max(1, Math.round((BAND_WIDTH * image.height) / image.width));
  // Never taller than the band is wide: a portrait-shaped image shrinks to fit a
  // BAND_WIDTH square (centred on the header colour) instead of filling an inbox.
  const tall = fullHeight > BAND_WIDTH;
  const width = tall ? Math.max(1, Math.round((BAND_WIDTH * BAND_WIDTH) / fullHeight)) : BAND_WIDTH;
  const height = tall ? BAND_WIDTH : fullHeight;
  const size = tall ? `margin:0 auto;width:${width}px;max-width:100%` : `width:100%;max-width:${BAND_WIDTH}px`;
  const corners = bandCorners(style);
  // A full-width banner fills the rounded corners, so it's rounded too; a narrower one sits inside them.
  const img = `<img${headingClass(style)} src="${escapeAttr(image.url)}" width="${width}" height="${height}" alt="${escapeName(style.altName)}" style="display:block;${size};height:auto;border:0;outline:none;text-decoration:none;${textStyle}${tall ? "" : corners}" />`;
  return bandFrame(bg, `<td bgcolor="${bg}" align="center" style="padding:0;background-color:${bg}${corners}">${img}</td>`, corners);
}

export function htmlToText(html: string): string {
  return html
    // Keep an anchor's URL alongside its label so text/plain readers can act on
    // links (notably the footer's Unsubscribe) — "label (https://…)". Skip empty
    // and in-page (#) hrefs, and don't duplicate when label already IS the URL.
    .replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      return href && !href.startsWith("#") && href !== label ? `${label} (${href})` : label;
    })
    .replace(/<\/(p|div|h\d|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    // Decode the handful of entities our own markup emits, so text/plain never
    // shows literal "&nbsp;"/"&amp;" codes (the footer uses &nbsp; separators).
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape a value for use inside a double-quoted HTML attribute (leaves {{tokens}} intact). */
function escapeAttr(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── HTML sanitization (allowlist) ────────────────────────────────────────────

const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "a",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "span",
]);

/** A link target is safe if http(s)/mailto, a root-relative path, or a pure {{token}}. */
export function isSafeHref(href: string): boolean {
  const h = href.trim();
  if (!h) return false;
  if (/^\s*(javascript|data|vbscript):/i.test(h)) return false;
  if (/^(https?:|mailto:)/i.test(h)) return true;
  // Root-relative ONLY. Reject a leading "/" followed by "/" OR "\" — browsers normalize
  // "/\evil.com" (and "//evil.com") to a protocol-relative external URL (open redirect).
  if (/^\/[^/\\]/.test(h)) return true;
  if (/^\{\{[\w.]+\}\}$/.test(h)) return true; // pure merge token
  return false;
}

function cleanAttrs(tag: string, attrs: string): string {
  const out: string[] = [];
  if (tag === "a") {
    const m = attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const href = (m?.[2] ?? m?.[3] ?? m?.[4] ?? "").trim();
    if (href && isSafeHref(href)) {
      out.push(`href="${escapeAttr(href)}"`, 'target="_blank"', 'rel="noopener noreferrer"');
    }
  }
  // Allow ONLY a text-align style on block tags (safe; enables Tiptap alignment).
  const s = attrs.match(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i);
  const align = (s?.[2] ?? s?.[3] ?? "").match(/text-align\s*:\s*(left|right|center)/i);
  if (align?.[1]) out.push(`style="text-align:${align[1].toLowerCase()}"`);
  return out.length ? ` ${out.join(" ")}` : "";
}

/** Escape stray angle brackets in a TEXT segment (not &, to avoid double-escaping). */
function escapeTextBrackets(s: string): string {
  return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Allowlist-sanitize a fragment of author/AI HTML: drop dangerous elements + their
 * content, keep only allowlisted tags (cleaned to a safe `href` + `text-align` style),
 * and ESCAPE angle brackets in text nodes (incl. any trailing unterminated "<tag…").
 * {{merge_tokens}} pass through untouched.
 */
export function sanitizeEmailHtml(html: string): string {
  if (!html) return "";
  // Remove dangerous elements WITH their content, then any self-closing dangerous tags.
  let out = html.replace(
    /<(script|style|iframe|object|embed|noscript|template|head|title|link|meta)\b[\s\S]*?<\/\1>/gi,
    "",
  );
  out = out.replace(/<(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, "");
  // Tokenize into complete tags vs text: allowlist each tag, escape everything else so a
  // disallowed/malformed/unterminated bracket can never re-open a tag downstream.
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let result = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    result += escapeTextBrackets(out.slice(last, m.index));
    const t = m[2]!.toLowerCase();
    if (ALLOWED_TAGS.has(t)) result += m[1] === "/" ? `</${t}>` : `<${t}${cleanAttrs(t, m[3] ?? "")}>`;
    last = re.lastIndex;
  }
  result += escapeTextBrackets(out.slice(last));
  return result;
}

// ── Block layout → email-safe HTML ───────────────────────────────────────────

const HEADING_SIZE: Record<1 | 2 | 3, number> = { 1: 28, 2: 22, 3: 18 };

function socialLabel(platform: string): string {
  return platform === "x" ? "X" : platform.charAt(0).toUpperCase() + platform.slice(1);
}

/** Only emit a colour we can trust into an inline style (defence in depth vs. Zod). */
export function safeHex(c: string | null | undefined, fallback: string): string {
  return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback;
}

/** Wrap a block in its per-section BACKGROUND band when set (margins show the bg). */
function withSection(inner: string, sectionBg: string | null | undefined): string {
  const bg = safeHex(sectionBg, "");
  return bg ? `<div style="background:${bg};padding:16px 16px 1px">${inner}</div>` : inner;
}

/**
 * The MANDATORY email footer — one consistent, non-removable footer on every
 * marketing send (journey + broadcast). Its identity + link tokens are emitted
 * VERBATIM and resolved downstream per-recipient (mergeVars.ts renderMergeVars)
 * or per-campaign (mergeVars.ts toMailchimpMergeTags → MailChimp native tags):
 *   {{sender_brand}} · {{manage_preferences_url}} · {{unsubscribe_url}} · {{privacy_url}}
 *
 * The `data-vzb-footer` marker lets the compilers detect an already-present
 * footer (from the editor's locked Footer block) and skip the safety-net append,
 * guaranteeing EXACTLY ONE footer whether or not the email was authored in the
 * layout editor. See FOOTER_MARKER + compileJourneyEmail/compileBroadcast.
 */
export const FOOTER_MARKER = "data-vzb-footer";

/** Footer inner HTML (no section band — renderBlock adds it from block.sectionBg).
 *  `withAddress` adds a `{{postal_address}}` line (lifecycle emails); a `style` with a
 *  theme sets it in the theme's body font (none = today's). */
function renderFooterInner(opts: { withAddress?: boolean; style?: ResolvedEmailStyle | null } = {}): string {
  // `mc:disable-tracking` keeps Mandrill from rewriting these to click-tracking
  // redirects: the unsubscribe/preferences/privacy controls must be DIRECT links
  // (bulk-sender guidance), and tracking them would inflate journey click metrics.
  const link = (token: string, label: string) =>
    `<a href="${token}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">${label}</a>`;
  const address = opts.withAddress ? "<br />{{postal_address}}" : "";
  return `<div ${FOOTER_MARKER}="1" style="text-align:center;margin:28px 0 0;padding-top:20px;border-top:1px solid #ededed;font-family:${fontFor(opts.style, "body")};font-size:12px;line-height:1.7;color:#999999">This email was sent by {{sender_brand}}.${address}<br />${link(
    "{{manage_preferences_url}}",
    "Manage preferences",
  )} &nbsp;|&nbsp; ${link("{{unsubscribe_url}}", "Unsubscribe")} &nbsp;|&nbsp; ${link(
    "{{privacy_url}}",
    "Privacy Policy",
  )}</div>`;
}

/** Full footer including its optional per-section background band. Used by the
 *  send-path safety net (compiler.ts) when a body lacks a footer block; pass the email's
 *  `style` so a theme's body font reaches it. */
export function renderFooter(
  sectionBg?: string | null,
  opts: { withAddress?: boolean; style?: ResolvedEmailStyle | null } = {},
): string {
  return withSection(renderFooterInner(opts), sectionBg ?? null);
}

/**
 * A plain, founder-style shell for `letter` lifecycle emails: no card, no hero and
 * no Email style band — it should read like a personal note, not a newsletter.
 */
export function wrapLetter(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="margin:0;background:#ffffff">
  <div style="font-family:${FONT};font-size:15px;line-height:1.6;max-width:560px;margin:0 auto;padding:24px;color:#111">
    ${inner}
  </div>
</body></html>`;
}

/** A hidden inbox preheader (the preview line after the subject). */
export function preheaderHtml(text: string | null | undefined): string {
  return text ? hiddenPreheader(escapeHtml(text)) : "";
}

function hiddenPreheader(html: string): string {
  if (!html) return "";
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff">${html}</div>`;
}

/**
 * Whether a RAW (pre-merge) body already carries a footer, so the compiler's
 * safety net doesn't append a duplicate. Matches the current marker AND the
 * legacy `{{unsubscribe_url}}` token (older footer blocks predate the marker),
 * so content authored before the mandatory footer never double-renders one.
 * `{{unsubscribe_url}}` is footer-only — it's not an author-insertable token.
 */
export function hasFooter(rawBody: string): boolean {
  return rawBody.includes(FOOTER_MARKER) || rawBody.includes("{{unsubscribe_url}}");
}

function renderInner(block: EmailBlock, style: ResolvedEmailStyle | null): string {
  switch (block.kind) {
    case "text":
      return `<div style="font-family:${fontFor(style, "body")};font-size:16px;line-height:1.6;color:${safeHex(block.color, "#111111")};margin:0 0 16px">${sanitizeEmailHtml(
        block.html,
      )}</div>`;
    case "heading": {
      const size = HEADING_SIZE[block.level];
      return `<h${block.level} style="margin:0 0 12px;font-family:${fontFor(style, "heading")};font-size:${size}px;line-height:1.3;font-weight:700;color:${safeHex(block.color, "#111111")};text-align:${block.align}">${escapeHtml(
        block.html,
      )}</h${block.level}>`;
    }
    case "image": {
      if (!block.src) return "";
      // width:<w>px sets the actual size (the slider controls it); max-width:100% keeps
      // it inside the content column; the wrapper's text-align handles alignment.
      const img = `<img src="${escapeAttr(block.src)}" alt="${escapeAttr(block.alt)}" width="${block.width}" style="display:inline-block;width:${block.width}px;max-width:100%;height:auto;border:0;border-radius:8px" />`;
      const linked =
        block.href && isSafeHref(block.href)
          ? `<a href="${escapeAttr(block.href)}" target="_blank" rel="noopener noreferrer">${img}</a>`
          : img;
      return `<div style="text-align:${block.align};margin:0 0 16px">${linked}</div>`;
    }
    case "button": {
      const href = isSafeHref(block.href) ? block.href : "#";
      return `<div style="text-align:${block.align};margin:0 0 16px"><table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-block;border-collapse:separate"><tr><td style="background:${safeHex(
        block.bg,
        "#111111",
      )};border-radius:${block.radius}px"><a href="${escapeAttr(
        href,
      )}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-family:${fontFor(style, "body")};font-size:15px;font-weight:600;color:${safeHex(
        block.color,
        "#ffffff",
      )};text-decoration:none">${escapeHtml(block.label)}</a></td></tr></table></div>`;
    }
    case "divider":
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border-collapse:collapse"><tr><td style="border-top:${block.thickness}px solid ${safeHex(
        block.color,
        "#e5e5e5",
      )};font-size:0;line-height:0">&nbsp;</td></tr></table>`;
    case "spacer":
      return `<div style="height:${block.height}px;line-height:${block.height}px;font-size:0">&nbsp;</div>`;
    case "social": {
      if (!block.links.length) return "";
      const items = block.links
        .map((l) => {
          const href = isSafeHref(l.url) ? l.url : "#";
          return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin:0 6px"><img src="${escapeAttr(
            socialIconDataUri(l.platform),
          )}" alt="${escapeAttr(socialLabel(l.platform))}" width="24" height="24" style="display:inline-block;border:0" /></a>`;
        })
        .join("");
      return `<div style="text-align:${block.align};margin:8px 0 16px">${items}</div>`;
    }
    case "footer":
      // The footer's content is FIXED (sent-by brand + Manage preferences /
      // Unsubscribe / Privacy Policy). Only its section background is editable —
      // block.text is ignored (kept on the type for back-compat). renderBlock
      // adds the section band from block.sectionBg.
      return renderFooterInner({ style });
  }
}

function renderBlock(block: EmailBlock, style: ResolvedEmailStyle | null): string {
  const inner = renderInner(block, style);
  if (!inner) return ""; // e.g. an image with no src, or empty social — no section band
  return withSection(inner, block.sectionBg);
}

/**
 * Render a block layout to email-safe INNER HTML (no <html>/<body> — pass through
 * wrap() to get the full document / preview). Blocks stack full-width inside wrap()'s
 * centered 560px card. With a `style` that has a theme, text, buttons and the footer take
 * its body font and headings its heading font; without one it's today's HTML. Saved
 * snapshots (the editor's Save, the template thumbnail) render with no style, so they
 * never bake a theme in.
 */
export function renderEmailLayout(layout: EmailLayout, opts: { style?: ResolvedEmailStyle | null } = {}): string {
  const style = opts.style ?? null;
  return (layout.blocks ?? []).map((block) => renderBlock(block, style)).join("\n");
}

/** Kinds are re-exported here only for callers that render a single block if ever needed. */
export type { EmailBlockKind };
