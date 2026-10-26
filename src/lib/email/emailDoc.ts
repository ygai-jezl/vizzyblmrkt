import { FOOTER_MARKER, escapeHtml, looksHtml, paragraphize, sanitizeEmailHtml } from "./emailRender";

/**
 * An email body (HTML or plain text) in and out of Edit mode. The editor holds exactly what
 * sanitizeEmailHtml keeps, so an email written with more than that (an image, a table, styles)
 * is refused by name rather than quietly losing it. Pure, client-safe.
 */

// A lifecycle block token ({{block.checklist}}) between blocks, on a line of its own: run
// together into one paragraph, they would put a table inside a <p>.
const BLOCK_TOKEN = /\{\{\s*block\.[a-z_]+\s*\}\}/g;
const LOOSE_BLOCK_TOKENS =
  /(^|<\/(?:p|ul|ol|h[1-6])>)(\s*(?:\{\{\s*block\.[a-z_]+\s*\}\}\s*)+)(?=<(?:p|ul|ol|h[1-6])\b|$)/g;

/** Each block token that stands between blocks in a paragraph of its own, the shape the
 *  lifecycle renderer draws as the block itself. */
function ownParagraphs(html: string): string {
  return html.replace(LOOSE_BLOCK_TOKENS, (_m, before: string, tokens: string) => {
    const each = tokens.match(BLOCK_TOKEN) ?? [];
    return `${before}\n${each.map((t) => `<p>${t}</p>`).join("\n")}\n`;
  });
}

/** The HTML Edit mode starts from: plain text as the paragraphs it is sent as (a blank line
 *  starts one, a single line break stays a break), HTML as sanitizeEmailHtml keeps it, with
 *  any block token between blocks in a paragraph of its own. */
export function emailToEditorHtml(body: string): string {
  if (!body.trim()) return "";
  return looksHtml(body) ? ownParagraphs(sanitizeEmailHtml(body)) : paragraphize(escapeHtml(body));
}

/** What Edit mode saves: the editor's HTML, sanitized; "" when nothing was written. */
export function editorHtmlToEmail(html: string): string {
  const clean = sanitizeEmailHtml(html).trim();
  return /^(?:<p>\s*(?:<br>)?\s*<\/p>\s*)*$/.test(clean) ? "" : clean;
}

const KEPT_TAGS = new Set(["p", "br", "strong", "b", "em", "i", "u", "a", "ul", "ol", "li", "h1", "h2", "h3", "span"]);

const TAG_NAMES: Record<string, string> = {
  img: "an image",
  picture: "an image",
  table: "a table",
  thead: "a table",
  tbody: "a table",
  tr: "a table",
  td: "a table",
  th: "a table",
  div: "a layout block",
  section: "a layout block",
  center: "a layout block",
  style: "a style block",
  script: "a script",
  font: "font settings",
  hr: "a line",
  blockquote: "a quotation",
  h4: "a small heading",
  h5: "a small heading",
  h6: "a small heading",
  pre: "a code block",
  code: "code",
  button: "a button",
  form: "a form",
  iframe: "an embedded page",
  video: "a video",
};

/** Attributes the sanitizer drops that change nothing in an inbox without a style block. */
const HARMLESS_ATTRS = new Set(["class", "id", "dir", "lang", "title"]);

/**
 * What in this email Edit mode can't keep ("an image", "a table", "styles"), in the order they
 * first appear, or null when it can keep all of it.
 */
export function emailEditProblem(body: string): string[] | null {
  if (!looksHtml(body)) return null;
  const found: string[] = [];
  const add = (what: string) => {
    if (!found.includes(what)) found.push(what);
  };
  if (body.includes(FOOTER_MARKER)) add("the footer block");
  if (body.includes("<!--")) add("HTML comments");
  const tags = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tags.exec(body)) !== null) {
    const tag = (m[1] ?? "").toLowerCase();
    if (!KEPT_TAGS.has(tag)) {
      add(TAG_NAMES[tag] ?? `<${tag}>`);
      continue;
    }
    const attrs = /([a-zA-Z_:][\w:.-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|[^\s>]+))?/g;
    let a: RegExpExecArray | null;
    while ((a = attrs.exec(m[2] ?? "")) !== null) {
      const name = (a[1] ?? "").toLowerCase();
      const value = (a[3] ?? a[4] ?? a[2] ?? "").trim();
      if (HARMLESS_ATTRS.has(name)) continue;
      if (tag === "a" && (name === "href" || name === "target" || name === "rel")) continue;
      if (name === "style" && /^text-align\s*:\s*(left|right|center)\s*;?$/i.test(value)) continue;
      add(name === "style" ? "styles" : "HTML settings");
    }
  }
  return found.length ? found : null;
}
