/**
 * The Markdown a blog article is written in, parsed into blocks — headings, paragraphs,
 * lists, pipe tables, boxes (a blockquote with a bold label: "Key facts", "TL;DR",
 * "Answer"), quotations (a blockquote without one), fenced code (code, schema markup, a
 * text diagram) and rules. One parse feeds everything that reads an article: the preview, the HTML export,
 * the CITABLE checklist and the suggested schema markup, so they can never disagree
 * about what the article says. Dependency-free, pure and client-safe.
 *
 * Raw HTML in the source is never passed through: text is escaped on the way out, and a
 * link is only a link when it is http(s), site-relative or an in-page anchor.
 */

export type ArticleBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  /** A blockquote. `label` is its leading bold text ("Key facts", "Answer") — a box;
   *  "" = a quotation. */
  | { kind: "callout"; label: string; blocks: ArticleBlock[] }
  /** A fenced block, kept exactly as written. `lang` is the fence's label ("json"), or "". */
  | { kind: "code"; text: string; lang: string }
  | { kind: "rule" };

const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
const UL_ITEM = /^\s*[-*+]\s+(.*)$/;
const OL_ITEM = /^\s*\d{1,3}[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*(?:```|~~~)/;
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** Split one pipe-table row into its cells (`\|` is a literal pipe). */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i += 1;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i] ?? "";
  const delim = lines[i + 1] ?? "";
  if (!head.includes("|") || !delim.includes("-") || !TABLE_DELIM.test(delim)) return false;
  // The delimiter row must describe the same columns as the header (so a lone "---"
  // rule under a line that happens to hold a pipe is not read as a table).
  return splitRow(delim).length === splitRow(head).length && splitRow(head).length >= 2;
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i] ?? "";
  return (
    HEADING.test(line) ||
    UL_ITEM.test(line) ||
    OL_ITEM.test(line) ||
    QUOTE.test(line) ||
    RULE.test(line) ||
    FENCE.test(line) ||
    isTableStart(lines, i)
  );
}

/** A blockquote whose first line is a bold label ("**Key facts**") is a named box. */
function toCallout(inner: ArticleBlock[]): ArticleBlock {
  const first = inner[0];
  if (first?.kind === "paragraph") {
    const whole = /^\*\*([^*]+?)\*\*:?$/.exec(first.text.trim());
    if (whole?.[1]) return { kind: "callout", label: whole[1].replace(/:$/, "").trim(), blocks: inner.slice(1) };
    const lead = /^\*\*([^*]+?)\*\*:?\s+(.+)$/.exec(first.text.trim());
    if (lead?.[1] && lead[2]) {
      return {
        kind: "callout",
        label: lead[1].replace(/:$/, "").trim(),
        blocks: [{ kind: "paragraph", text: lead[2].trim() }, ...inner.slice(1)],
      };
    }
  }
  return { kind: "callout", label: "", blocks: inner };
}

/** Parse article Markdown into blocks. Never throws; unknown syntax falls out as a paragraph. */
export function parseArticle(markdown: string): ArticleBlock[] {
  const lines = (markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const at = (k: number): string => lines[k] ?? "";
  const blocks: ArticleBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = at(i);
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    if (FENCE.test(line)) {
      const lang = /^\s*(?:```|~~~)\s*([\w+#.-]*)/.exec(line)?.[1] ?? "";
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(at(i))) {
        code.push(at(i));
        i += 1;
      }
      i += 1; // the closing fence
      blocks.push({ kind: "code", text: code.join("\n").replace(/\n+$/, ""), lang: lang.toLowerCase() });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: Math.min((heading[1] ?? "#").length, 4) as 1 | 2 | 3 | 4,
        text: (heading[2] ?? "").trim(),
      });
      i += 1;
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && at(i).trim() !== "" && at(i).includes("|")) {
        const cells = splitRow(at(i));
        // Keep every row the header's width, so a short or long row can't skew the table.
        rows.push(header.map((_, c) => cells[c] ?? ""));
        i += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(at(i))) {
        inner.push(QUOTE.exec(at(i))?.[1] ?? "");
        i += 1;
      }
      blocks.push(toCallout(parseArticle(inner.join("\n"))));
      continue;
    }

    const ordered = OL_ITEM.test(line);
    if (ordered || UL_ITEM.test(line)) {
      const item = ordered ? OL_ITEM : UL_ITEM;
      const items: string[] = [];
      while (i < lines.length) {
        const cur = at(i);
        const m = item.exec(cur);
        if (m) {
          items.push((m[1] ?? "").trim());
          i += 1;
        } else if (cur.trim() === "") {
          // A blank line between items keeps the list going; anything else ends it.
          let j = i;
          while (j < lines.length && at(j).trim() === "") j += 1;
          if (j < lines.length && item.test(at(j))) i = j;
          else break;
        } else if (/^\s{2,}\S/.test(cur) && !startsBlock(lines, i) && items.length) {
          items[items.length - 1] = `${items[items.length - 1]} ${cur.trim()}`; // a wrapped line
          i += 1;
        } else {
          break;
        }
      }
      blocks.push({ kind: "list", ordered, items: items.filter(Boolean) });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && at(i).trim() !== "" && !startsBlock(lines, i)) {
      para.push(at(i).trim());
      i += 1;
    }
    blocks.push({ kind: "paragraph", text: para.join(" ") });
  }
  return blocks;
}

// ── Inline ──────────────────────────────────────────────────────────────────

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] };

/** `lead` = how many characters at the start of the match belong to the text before it
 *  (the italic rules match one character of context instead of using a lookbehind, which
 *  older Safari cannot parse). */
const INLINE_RULES: { re: RegExp; lead?: boolean; make: (m: RegExpExecArray) => Inline }[] = [
  {
    // [text](url) — the url may hold one level of (brackets), as Wikipedia's do; an
    // optional "title" after it is dropped.
    re: /\[((?:[^\]\\]|\\.)+)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/,
    make: (m) => {
      const href = safeHref(m[2] ?? "");
      const inner = parseInline(m[1] ?? "");
      // Not a link we will follow → keep the words, drop the target.
      return href ? { t: "link", href, c: inner } : { t: "text", v: plainOf(inner) };
    },
  },
  { re: /`([^`]+)`/, make: (m) => ({ t: "code", v: m[1] ?? "" }) },
  { re: /\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*/, make: (m) => ({ t: "strong", c: parseInline(m[1] ?? "") }) },
  {
    re: /(^|[^\w*])\*([^\s*](?:[^*]*?[^\s*])?)\*(?![\w*])/,
    lead: true,
    make: (m) => ({ t: "em", c: parseInline(m[2] ?? "") }),
  },
  {
    re: /(^|[^\w_])_([^\s_](?:[^_]*?[^\s_])?)_(?![\w_])/,
    lead: true,
    make: (m) => ({ t: "em", c: parseInline(m[2] ?? "") }),
  },
];

/** A link target an article may carry: http(s), site-relative, or an in-page anchor. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\/[^\s<>"']+$/i.test(href)) return href;
  if (/^\/(?!\/)[^\s<>"']*$/.test(href)) return href;
  if (/^#[\w-]+$/.test(href)) return href;
  return null;
}

/** Parse inline Markdown (bold, italic, code, links) into a small tree. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text ?? "";
  while (rest) {
    let best: { index: number; length: number; node: Inline } | null = null;
    for (const rule of INLINE_RULES) {
      const m = rule.re.exec(rest);
      if (!m) continue;
      const lead = rule.lead ? (m[1] ?? "").length : 0;
      if (best === null || m.index + lead < best.index) {
        best = { index: m.index + lead, length: m[0].length - lead, node: rule.make(m) };
      }
    }
    if (!best) break;
    if (best.index > 0) out.push({ t: "text", v: rest.slice(0, best.index) });
    out.push(best.node);
    rest = rest.slice(best.index + best.length);
  }
  if (rest) out.push({ t: "text", v: rest });
  return out;
}

/** A backslash before Markdown punctuation is an escape, not text ("2 \* 3" reads "2 * 3"). */
export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, "$1");
}

function plainOf(nodes: Inline[]): string {
  return unescapeMarkdown(nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : plainOf(n.c))).join(""));
}

/** Inline Markdown as plain words (links keep their text, not their target). */
export function plainInline(text: string): string {
  return plainOf(parseInline(text)).replace(/\s+/g, " ").trim();
}

export interface ArticleLink {
  href: string;
  text: string;
}

function collectLinks(nodes: Inline[], out: ArticleLink[]): void {
  for (const n of nodes) {
    if (n.t === "link") {
      out.push({ href: n.href, text: plainOf(n.c).trim() });
      collectLinks(n.c, out);
    } else if (n.t === "strong" || n.t === "em") {
      collectLinks(n.c, out);
    }
  }
}

/** Every link in a run of inline Markdown, in order. */
export function inlineLinks(text: string): ArticleLink[] {
  const out: ArticleLink[] = [];
  collectLinks(parseInline(text), out);
  return out;
}

/** The inline-Markdown strings a block holds (its own, and its children's). */
export function blockTexts(block: ArticleBlock): string[] {
  switch (block.kind) {
    case "heading":
    case "paragraph":
      return [block.text];
    case "list":
      return block.items;
    case "table":
      return [...block.header, ...block.rows.flat()];
    case "callout":
      return [block.label, ...block.blocks.flatMap(blockTexts)];
    case "code":
      return [];
    default:
      return [];
  }
}

/** A block as plain words. */
export function blockPlain(block: ArticleBlock): string {
  if (block.kind === "code") return block.text;
  return blockTexts(block).map(plainInline).filter(Boolean).join(" ");
}

export function countWords(text: string): number {
  const m = (text ?? "").trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’%.,/-]*/gu);
  return m ? m.length : 0;
}

/** Every link in the article, in reading order. */
export function articleLinks(blocks: ArticleBlock[]): ArticleLink[] {
  return blocks.flatMap((b) => blockTexts(b).flatMap(inlineLinks));
}

/** A URL-safe id for a heading ("What does it cost?" → "what-does-it-cost"). */
export function slugify(text: string): string {
  return (text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// ── HTML ────────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineHtml(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text":
          return escapeHtml(unescapeMarkdown(n.v));
        case "code":
          return `<code>${escapeHtml(n.v)}</code>`;
        case "strong":
          return `<strong>${inlineHtml(n.c)}</strong>`;
        case "em":
          return `<em>${inlineHtml(n.c)}</em>`;
        default:
          return `<a href="${escapeHtml(n.href)}">${inlineHtml(n.c)}</a>`;
      }
    })
    .join("");
}

/** Inline Markdown as HTML (escaped). */
export function renderInlineHtml(text: string): string {
  return inlineHtml(parseInline(text));
}

/** The date in a "Last updated: 2026-10-07" line, or null when the line is something else. */
export function lastUpdatedOf(text: string): string | null {
  const m = /^last\s+updated\s*[:\-–]\s*(\d{4}-\d{2}-\d{2})\b/i.exec(plainInline(text));
  return m?.[1] ?? null;
}

function blockHtml(block: ArticleBlock, ids: Map<string, number>): string {
  switch (block.kind) {
    case "heading": {
      if (block.level === 1) return `<h1>${renderInlineHtml(block.text)}</h1>`;
      // Headings carry an id so a table of contents (or an answer engine) can point at one.
      const base = slugify(plainInline(block.text)) || "section";
      const seen = ids.get(base) ?? 0;
      ids.set(base, seen + 1);
      const id = seen ? `${base}-${seen + 1}` : base;
      return `<h${block.level} id="${id}">${renderInlineHtml(block.text)}</h${block.level}>`;
    }
    case "paragraph": {
      const date = lastUpdatedOf(block.text);
      if (date) return `<p class="last-updated">Last updated: <time datetime="${date}">${date}</time></p>`;
      return `<p>${renderInlineHtml(block.text)}</p>`;
    }
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      return `<${tag}>\n${block.items.map((it) => `  <li>${renderInlineHtml(it)}</li>`).join("\n")}\n</${tag}>`;
    }
    case "table": {
      const head = block.header.map((h) => `<th scope="col">${renderInlineHtml(h)}</th>`).join("");
      const body = block.rows
        .map((r) => `    <tr>${r.map((c) => `<td>${renderInlineHtml(c)}</td>`).join("")}</tr>`)
        .join("\n");
      return `<table>\n  <thead>\n    <tr>${head}</tr>\n  </thead>\n  <tbody>\n${body}\n  </tbody>\n</table>`;
    }
    case "callout": {
      const inner = block.blocks.map((b) => blockHtml(b, ids)).join("\n");
      // No label = somebody's words; a label = a box that is part of the article.
      if (!block.label) return `<blockquote>\n${inner}\n</blockquote>`;
      // A short label names the kind of box ("key-facts", "answer"); a sentence in bold
      // (a call to action's opening line) is not a kind, so that box is a plain note.
      const short = plainInline(block.label).split(/\s+/).length <= 4;
      const cls = (short && slugify(block.label)) || "note";
      return `<div class="callout ${cls}">\n<p class="callout-label"><strong>${renderInlineHtml(block.label)}</strong></p>\n${inner}\n</div>`;
    }
    case "code": {
      const cls = block.lang ? ` class="language-${escapeHtml(block.lang)}"` : "";
      return `<pre><code${cls}>${escapeHtml(block.text)}</code></pre>`;
    }
    default:
      return "<hr>";
  }
}

/** The article as clean, semantic HTML to paste into a CMS. Everything is escaped. */
export function renderArticleHtml(markdown: string): string {
  const ids = new Map<string, number>();
  const body = parseArticle(markdown)
    .map((b) => blockHtml(b, ids))
    .join("\n");
  return `<article>\n${body}\n</article>`;
}
