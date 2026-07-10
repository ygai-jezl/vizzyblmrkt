import type { EmailLayout, EmailBlock, EmailBlockKind } from "@/lib/types/emailLayout";
import { socialIconDataUri } from "./socialIcons";

/**
 * Email HTML assembly — the SINGLE source of email-safe markup, shared by the send
 * compiler (src/lib/agents/compiler.ts) and the visual layout editor's preview so
 * "what you see" is byte-identical to "what is sent".
 *
 *  - wrap()               — the outer email document (centered 560px card + optional hero).
 *  - renderEmailLayout()  — turn a block LAYOUT into email-safe (table + inline-style) inner HTML.
 *  - sanitizeEmailHtml()  — allowlist-sanitize author/AI HTML (defence in depth; the editor
 *                           preview is also sandboxed in an iframe).
 *
 * Pure + client-safe (no server imports, no Tiptap import). {{merge_tokens}} are emitted
 * VERBATIM — substitution happens downstream in the send path (mergeVars.ts).
 */

const FONT = "system-ui,-apple-system,Segoe UI,Roboto,sans-serif";

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

export function wrap(inner: string, heroImageUrl: string | null): string {
  // Guard + escape the hero URL (author/agent-controlled) so it can't break out of the
  // src attribute or inject markup into every recipient's inbox.
  const hero =
    heroImageUrl && isSafeHref(heroImageUrl)
      ? `<img src="${escapeAttr(heroImageUrl)}" alt="" style="display:block;width:100%;max-width:560px;border-radius:12px;margin:0 0 20px"/>`
      : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="margin:0;background:#f6f6f6">
  <div style="font-family:${FONT};max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
    ${hero}
    ${inner}
  </div>
</body></html>`;
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
function safeHex(c: string | null | undefined, fallback: string): string {
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

/** Footer inner HTML (no section band — renderBlock adds it from block.sectionBg). */
function renderFooterInner(): string {
  // `mc:disable-tracking` keeps Mandrill from rewriting these to click-tracking
  // redirects: the unsubscribe/preferences/privacy controls must be DIRECT links
  // (bulk-sender guidance), and tracking them would inflate journey click metrics.
  const link = (token: string, label: string) =>
    `<a href="${token}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">${label}</a>`;
  return `<div ${FOOTER_MARKER}="1" style="text-align:center;margin:28px 0 0;padding-top:20px;border-top:1px solid #ededed;font-family:${FONT};font-size:12px;line-height:1.7;color:#999999">This email was sent by {{sender_brand}}.<br />${link(
    "{{manage_preferences_url}}",
    "Manage preferences",
  )} &nbsp;|&nbsp; ${link("{{unsubscribe_url}}", "Unsubscribe")} &nbsp;|&nbsp; ${link(
    "{{privacy_url}}",
    "Privacy Policy",
  )}</div>`;
}

/** Full footer including its optional per-section background band. Used by the
 *  send-path safety net (compiler.ts) when a body lacks a footer block. */
export function renderFooter(sectionBg?: string | null): string {
  return withSection(renderFooterInner(), sectionBg ?? null);
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

function renderInner(block: EmailBlock): string {
  switch (block.kind) {
    case "text":
      return `<div style="font-family:${FONT};font-size:16px;line-height:1.6;color:${safeHex(block.color, "#111111")};margin:0 0 16px">${sanitizeEmailHtml(
        block.html,
      )}</div>`;
    case "heading": {
      const size = HEADING_SIZE[block.level];
      return `<h${block.level} style="margin:0 0 12px;font-family:${FONT};font-size:${size}px;line-height:1.3;font-weight:700;color:${safeHex(block.color, "#111111")};text-align:${block.align}">${escapeHtml(
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
      )}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;font-weight:600;color:${safeHex(
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
      return renderFooterInner();
  }
}

function renderBlock(block: EmailBlock): string {
  const inner = renderInner(block);
  if (!inner) return ""; // e.g. an image with no src, or empty social — no section band
  return withSection(inner, block.sectionBg);
}

/**
 * Render a block layout to email-safe INNER HTML (no <html>/<body> — pass through
 * wrap() to get the full document / preview). Blocks stack full-width inside wrap()'s
 * centered 560px card.
 */
export function renderEmailLayout(layout: EmailLayout): string {
  return (layout.blocks ?? []).map(renderBlock).join("\n");
}

/** Kinds are re-exported here only for callers that render a single block if ever needed. */
export type { EmailBlockKind };
