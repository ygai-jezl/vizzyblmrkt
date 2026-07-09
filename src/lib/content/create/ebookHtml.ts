/**
 * eBook chapter HTML — allowlist sanitizer + image-anchor helpers. Pure + client-safe.
 *
 * Chapters are long-form rich text (Tiptap-authored or AI-generated) with inline image
 * PLACEHOLDERS anchored as `<div data-ebook-image="slotId"></div>`. The email sanitizer
 * can't be reused: it drops <div> and strips data-* attributes, which would delete every
 * anchor. So this mirrors its tokenize→allowlist→escape approach with an eBook allowlist
 * and a single special case — the image anchor div keeps ONLY a validated slot id.
 */
import { isSafeHref } from "@/lib/email/emailRender";

/** Marker the model emits where an illustration belongs: `[[image: <brief>]]`. */
export const EBOOK_IMAGE_MARKER_RE = /\[\[\s*image\s*:\s*([^\]]*?)\s*\]\]/gi;

/** Slot ids are our own (`img_<uuid>`) — restrict the anchor attribute to this shape. */
const SLOT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Chapters start at <h2> (the reader chrome owns <h1> = the book title). <div> is allowed
// ONLY as the image anchor (attrs stripped to a valid data-ebook-image id below).
const EBOOK_ALLOWED_TAGS = new Set([
  "p",
  "br",
  "hr",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "a",
  "ul",
  "ol",
  "li",
  "h2",
  "h3",
  "h4",
  "blockquote",
  "div",
  // Tables (attributes are stripped by cleanEbookAttrs → no colspan/rowspan, but structure + prose
  // table styling render fine).
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);

/** The anchor a placeholder/generated image renders into, keyed by its slot id. */
export function buildImageAnchor(slotId: string): string {
  return `<div data-ebook-image="${slotId}"></div>`;
}

/** Read the slot id from a `<div data-ebook-image="...">` open tag's attrs, or null. */
export function imageAnchorId(attrs: string): string | null {
  const m = attrs.match(/\bdata-ebook-image\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const id = (m?.[2] ?? m?.[3] ?? m?.[4] ?? "").trim();
  return SLOT_ID_RE.test(id) ? id : null;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeTextBrackets(s: string): string {
  return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cleanEbookAttrs(tag: string, attrs: string): string {
  if (tag === "a") {
    const m = attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const href = (m?.[2] ?? m?.[3] ?? m?.[4] ?? "").trim();
    if (href && isSafeHref(href)) {
      return ` href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer"`;
    }
    return "";
  }
  if (tag === "div") {
    const id = imageAnchorId(attrs);
    return id ? ` data-ebook-image="${id}"` : "";
  }
  return "";
}

/**
 * Allowlist-sanitize a chapter HTML fragment: drop dangerous elements + their content,
 * keep only allowlisted tags (links cleaned to a safe href; image-anchor divs cleaned to
 * a valid slot id, all other attrs dropped), and escape angle brackets in text nodes.
 */
export function sanitizeEbookHtml(html: string): string {
  if (!html) return "";
  let out = html.replace(
    /<(script|style|iframe|object|embed|noscript|template|head|title|link|meta)\b[\s\S]*?<\/\1>/gi,
    "",
  );
  out = out.replace(/<(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, "");
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let result = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    result += escapeTextBrackets(out.slice(last, m.index));
    const t = m[2]!.toLowerCase();
    if (EBOOK_ALLOWED_TAGS.has(t)) {
      result += m[1] === "/" ? `</${t}>` : `<${t}${cleanEbookAttrs(t, m[3] ?? "")}>`;
    }
    last = re.lastIndex;
  }
  result += escapeTextBrackets(out.slice(last));
  return result;
}

/**
 * Sanitize chapter HTML and GUARANTEE the result is at most `max` chars. Naively slicing
 * then re-sanitizing can re-grow the output (escaping a boundary-truncated `<tag` into
 * `&lt;tag` adds chars), so shrink the RAW input until the sanitized output fits, with a
 * final hard slice as a backstop. Prevents an oversized bodyHtml from throwing on
 * EbookDocSchema.parse (a 500 / silent drop) downstream.
 */
export function sanitizeEbookHtmlCapped(html: string, max: number): string {
  let out = sanitizeEbookHtml(html);
  if (out.length <= max) return out;
  let cut = max;
  for (let i = 0; i < 8 && out.length > max; i++) {
    cut = Math.max(0, cut - (out.length - max) - 16);
    out = sanitizeEbookHtml(html.slice(0, cut));
  }
  return out.length > max ? out.slice(0, max) : out;
}

/** Remove one image anchor `<div data-ebook-image="slotId"></div>` from chapter HTML. */
export function stripImageAnchor(html: string, slotId: string): string {
  if (!SLOT_ID_RE.test(slotId)) return html;
  const re = new RegExp(`<div\\b[^>]*\\bdata-ebook-image\\s*=\\s*["']?${slotId}["']?[^>]*>\\s*</div>`, "gi");
  return html.replace(re, "");
}

/** Matches a `<div data-ebook-image="ID"></div>` anchor, capturing the slot id. */
const IMAGE_ANCHOR_RE = /<div\b[^>]*\bdata-ebook-image\s*=\s*["']?([A-Za-z0-9_-]{1,64})["']?[^>]*>\s*<\/div>/gi;

export type ChapterSegment = { type: "html"; html: string } | { type: "image"; slotId: string };

/**
 * Split chapter HTML into ordered HTML segments and image-anchor markers, so the reading
 * pane can render prose (dangerouslySetInnerHTML of the already-sanitized HTML) interleaved
 * with slot cards. Pure — no allocation of new ids.
 */
export function splitChapterByImages(bodyHtml: string): ChapterSegment[] {
  const out: ChapterSegment[] = [];
  const re = new RegExp(IMAGE_ANCHOR_RE);
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyHtml)) !== null) {
    if (m.index > last) out.push({ type: "html", html: bodyHtml.slice(last, m.index) });
    out.push({ type: "image", slotId: m[1]! });
    last = re.lastIndex;
  }
  if (last < bodyHtml.length) out.push({ type: "html", html: bodyHtml.slice(last) });
  return out;
}

/** All slot ids anchored in the HTML (order of appearance, de-duplicated). */
export function anchoredSlotIds(bodyHtml: string): string[] {
  const ids: string[] = [];
  const re = new RegExp(IMAGE_ANCHOR_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyHtml)) !== null) if (!ids.includes(m[1]!)) ids.push(m[1]!);
  return ids;
}

/**
 * Drop any image slot whose anchor no longer appears in the body (e.g. the operator deleted
 * the placeholder while editing), so `chapter.images` never orphans. Preserves order.
 */
export function reconcileChapterImages<T extends { id: string }>(bodyHtml: string, images: T[]): T[] {
  const present = new Set(anchoredSlotIds(bodyHtml));
  return images.filter((img) => present.has(img.id));
}
