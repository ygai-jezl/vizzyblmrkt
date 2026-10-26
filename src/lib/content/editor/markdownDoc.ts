import type { JSONContent } from "@tiptap/core";
import {
  parseArticle,
  parseInline,
  unescapeMarkdown,
  type ArticleBlock,
  type Inline,
} from "@/lib/content/blog/markdown";
import { linkCheck, type EditFormat } from "./extensions";

/**
 * An article's Markdown as an editor document (Tiptap JSON) and back. The Markdown stays what
 * is saved: every check, the preview, the export and Vizzy read it, so Edit mode reads it
 * through the same parser (`parseArticle`) and writes back the same shapes the writer uses.
 *
 * `docLoss` says when a round trip would change what the article says (formatting the
 * Markdown can't hold), so Edit mode refuses to open on it, or warns before saving it,
 * rather than quietly dropping it. Pure, client-safe, no DOM.
 */

type MarkJson = { type: "bold" | "italic" | "code" } | { type: "link"; attrs: { href: string } };

// ── Markdown → document ─────────────────────────────────────────────────────────────

function textNode(text: string, marks: MarkJson[]): JSONContent {
  return marks.length ? { type: "text", text, marks } : { type: "text", text };
}

function inlineJson(nodes: Inline[], marks: MarkJson[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const n of nodes) {
    if (n.t === "text") {
      const text = unescapeMarkdown(n.v);
      if (text) out.push(textNode(text, marks));
    } else if (n.t === "code") {
      if (n.v) out.push(textNode(n.v, withMark(marks, { type: "code" })));
    } else if (n.t === "strong") {
      out.push(...inlineJson(n.c, withMark(marks, { type: "bold" })));
    } else if (n.t === "em") {
      out.push(...inlineJson(n.c, withMark(marks, { type: "italic" })));
    } else {
      out.push(...inlineJson(n.c, withMark(marks, { type: "link", attrs: { href: n.href } })));
    }
  }
  return out;
}

function withMark(marks: MarkJson[], mark: MarkJson): MarkJson[] {
  return marks.some((m) => m.type === mark.type) ? marks : [...marks, mark];
}

function paragraph(text: string, format: EditFormat): JSONContent {
  const content = inlineJson(parseInline(text, linkCheck(format)), []);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
}

function blockJson(block: ArticleBlock, format: EditFormat): JSONContent {
  switch (block.kind) {
    case "heading": {
      const content = paragraph(block.text, format).content;
      return { type: "heading", attrs: { level: block.level }, ...(content ? { content } : {}) };
    }
    case "paragraph":
      return paragraph(block.text, format);
    case "list":
      return {
        type: block.ordered ? "orderedList" : "bulletList",
        ...(block.ordered ? { attrs: { start: 1 } } : {}),
        content: block.items.map((item) => ({ type: "listItem", content: [paragraph(item, format)] })),
      };
    case "table":
      return {
        type: "table",
        content: [
          { type: "tableRow", content: block.header.map((c) => ({ type: "tableHeader", content: [paragraph(c, format)] })) },
          ...block.rows.map((row) => ({
            type: "tableRow",
            content: row.map((c) => ({ type: "tableCell", content: [paragraph(c, format)] })),
          })),
        ],
      };
    case "callout": {
      const inner = block.blocks.map((b) => blockJson(b, format));
      const content = inner.length ? inner : [{ type: "paragraph" }];
      return block.label
        ? { type: "articleBox", attrs: { label: block.label }, content }
        : { type: "blockquote", content };
    }
    case "code":
      return {
        type: "codeBlock",
        attrs: { language: block.lang || null },
        ...(block.text ? { content: [{ type: "text", text: block.text }] } : {}),
      };
    default:
      return { type: "horizontalRule" };
  }
}

/** An article's Markdown as an editor document. */
export function markdownToDoc(markdown: string, format: EditFormat): JSONContent {
  const content = parseArticle(markdown).map((b) => blockJson(b, format));
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

// ── document → Markdown ─────────────────────────────────────────────────────────────

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
  href: string | null;
}

function runsOf(nodes: JSONContent[] | undefined): Run[] {
  const runs: Run[] = [];
  for (const n of nodes ?? []) {
    if (n.type !== "text" || !n.text) continue;
    const marks = n.marks ?? [];
    const link = marks.find((m) => m.type === "link");
    runs.push({
      text: n.text,
      bold: marks.some((m) => m.type === "bold"),
      italic: marks.some((m) => m.type === "italic"),
      code: marks.some((m) => m.type === "code"),
      href: typeof link?.attrs?.href === "string" ? link.attrs.href : null,
    });
  }
  return runs;
}

/** Consecutive runs that agree on `key`, in order. */
function groups<K>(runs: Run[], key: (r: Run) => K): { key: K; runs: Run[] }[] {
  const out: { key: K; runs: Run[] }[] = [];
  for (const r of runs) {
    const k = key(r);
    const last = out[out.length - 1];
    if (last && last.key === k) last.runs.push(r);
    else out.push({ key: k, runs: [r] });
  }
  return out;
}

/** Wrap in a delimiter, keeping edge spaces outside it ("** bold **" isn't bold). */
function wrapIn(inner: string, delim: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  const core = m?.[2] ?? "";
  if (!core) return inner;
  return `${m?.[1] ?? ""}${delim}${core}${delim}${m?.[3] ?? ""}`;
}

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|>]/;

/** Plain text made safe to read back as plain text. */
function escapeText(text: string, inLink: boolean, inCell: boolean): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    const prev = text[i - 1] ?? "";
    const next = text[i + 1] ?? "";
    if (ch === "\\") out += next === "" || ESCAPABLE.test(next) ? "\\\\" : "\\";
    else if (ch === "*" || ch === "`") out += `\\${ch}`;
    // "_" only opens or closes emphasis beside a non-word character, so snake_case stays as is.
    else if (ch === "_") out += /\w/.test(prev) && /\w/.test(next) ? "_" : "\\_";
    else if (ch === "]" && (inLink || next === "(")) out += "\\]";
    else if (ch === "[" && inLink) out += "\\[";
    else if (ch === "|" && inCell) out += "\\|";
    else out += ch;
  }
  return out;
}

function codeSpan(text: string, inCell: boolean): string {
  // A code span can't hold a backtick here; it stays as text instead.
  if (text.includes("`")) return escapeText(text, false, inCell);
  return `\`${inCell ? text.replace(/\|/g, "\\|") : text}\``;
}

function inlineMarkdown(nodes: JSONContent[] | undefined, inCell = false): string {
  const runs = runsOf(nodes);
  // Links outermost, then bold, then italic; code is a span on its own.
  return groups(runs, (r) => r.href)
    .map(({ key: href, runs: linked }) => {
      const inLink = href !== null;
      const bolds = groups(linked, (r) => r.bold);
      const body = bolds
        .map(({ key: bold, runs: rs }, b) => {
          // An italic span next to "**" is written with "_" ("**_both_**", "**a**_b_"):
          // a "*" beside another "*" doesn't read back as italic.
          const starLeft = bold || bolds[b - 1]?.key === true;
          const starRight = bold || bolds[b + 1]?.key === true;
          const italics = groups(rs, (r) => r.italic);
          const inner = italics
            .map(({ key: italic, runs: its }, k) => {
              const text = its
                .map((r) => (r.code ? codeSpan(r.text, inCell) : escapeText(r.text, inLink, inCell)))
                .join("");
              if (!italic) return text;
              const nearStar = (k === 0 && starLeft) || (k === italics.length - 1 && starRight);
              return wrapIn(text, nearStar ? "_" : "*");
            })
            .join("");
          return bold ? wrapIn(inner, "**") : inner;
        })
        .join("");
      return inLink ? `[${body}](${href})` : body;
    })
    .join("");
}

/** A paragraph's first characters mustn't read back as a heading, list, quote, rule or fence. */
function guardLineStart(line: string): string {
  if (/^#{1,6}(\s|$)/.test(line) || /^>/.test(line) || /^[-+](\s|$)/.test(line) || /^-{3,}\s*$/.test(line)) {
    return `\\${line}`;
  }
  const ol = /^(\d{1,3})([.)])(\s|$)/.exec(line);
  if (ol) return `${ol[1]}\\${line.slice((ol[1] ?? "").length)}`;
  return line;
}

/** A heading that ends in " #" keeps it ("Rated #" isn't a closing run of #s). */
function guardHeadingEnd(text: string): string {
  return /\s#+$/.test(text) ? text.replace(/#$/, "\\#") : text;
}

const INLINE_HOLDERS = new Set(["paragraph", "heading", "codeBlock"]);

/** A node's words: inline text joined as written, blocks with a space between them. */
function textOf(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(textOf).join(INLINE_HOLDERS.has(node.type ?? "") ? "" : " ");
}

/** A list item's words: its paragraphs on one line (a Markdown item is one line). */
function itemMarkdown(item: JSONContent): string {
  return (item.content ?? [])
    .filter((c) => c.type === "paragraph" || c.type === "heading")
    .map((c) => inlineMarkdown(c.content).trim())
    .filter(Boolean)
    .join(" ");
}

/** A list's items. A list nested in an item (pasted) is flattened into the list after it. */
function listItems(list: JSONContent): string[] {
  const out: string[] = [];
  for (const item of list.content ?? []) {
    const own = itemMarkdown(item);
    if (own) out.push(own);
    for (const child of item.content ?? []) {
      if (child.type === "bulletList" || child.type === "orderedList") out.push(...listItems(child));
    }
  }
  return out;
}

function cellMarkdown(cell: JSONContent): string {
  return (cell.content ?? [])
    .map((c) => inlineMarkdown(c.content, true).trim())
    .filter(Boolean)
    .join(" ");
}

function quoteLines(markdown: string): string {
  return markdown
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

function blockMarkdown(node: JSONContent): string {
  switch (node.type) {
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 2, 1), 4);
      const text = inlineMarkdown(node.content).trim();
      return text ? `${"#".repeat(level)} ${guardHeadingEnd(text)}` : "";
    }
    case "paragraph": {
      const text = inlineMarkdown(node.content).trim();
      return text ? guardLineStart(text) : "";
    }
    case "bulletList":
      return listItems(node)
        .map((t) => `- ${t}`)
        .join("\n");
    case "orderedList":
      return listItems(node)
        .map((t, i) => `${i + 1}. ${t}`)
        .join("\n");
    case "table": {
      const rows = (node.content ?? []).map((row) => (row.content ?? []).map(cellMarkdown));
      const width = Math.max(0, ...rows.map((r) => r.length));
      if (!rows.length || !width) return "";
      const line = (cells: string[]) =>
        `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`.replace(/ {2,}\|/g, " |");
      const [head = [], ...body] = rows;
      return [line(head), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map(line)].join("\n");
    }
    case "blockquote":
      return quoteLines(blocksMarkdown(node.content));
    case "articleBox": {
      const label = String(node.attrs?.label ?? "").replace(/\*/g, "").trim();
      const inner = blocksMarkdown(node.content);
      if (!label) return quoteLines(inner);
      return quoteLines(inner ? `**${label}**\n\n${inner}` : `**${label}**`);
    }
    case "codeBlock": {
      const lang = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      return `\`\`\`${lang}\n${textOf(node)}\n\`\`\``;
    }
    case "horizontalRule":
      return "---";
    default: {
      // Nothing else is in the schema; keep any words rather than lose them.
      const text = textOf(node).trim();
      return text ? escapeText(text, false, false) : "";
    }
  }
}

function blocksMarkdown(nodes: JSONContent[] | undefined): string {
  return (nodes ?? [])
    .map(blockMarkdown)
    .filter(Boolean)
    .join("\n\n");
}

/** An editor document as article Markdown. */
export function docToMarkdown(doc: JSONContent): string {
  return blocksMarkdown(doc.content);
}

// ── what a round trip would change ──────────────────────────────────────────────────

type Canon = string;

/** A run of text with its marks, merged with its neighbours and with spaces folded, so two
 *  spellings of the same thing ("*a*" and "_a_") compare equal. */
function canonInline(nodes: JSONContent[] | undefined): Canon {
  const merged: Run[] = [];
  for (const r of runsOf(nodes)) {
    const last = merged[merged.length - 1];
    if (last && last.bold === r.bold && last.italic === r.italic && last.code === r.code && last.href === r.href) {
      last.text += r.text;
    } else {
      merged.push({ ...r });
    }
  }
  return JSON.stringify(
    merged
      .map((r) => ({ ...r, text: r.text.replace(/\s+/g, " ") }))
      .map((r, i, all) => {
        let text = r.text;
        if (i === 0) text = text.trimStart();
        if (i === all.length - 1) text = text.trimEnd();
        return { ...r, text };
      })
      .filter((r) => r.text),
  );
}

function canonBlock(node: JSONContent): Canon | null {
  switch (node.type) {
    case "heading":
    case "paragraph": {
      const text = canonInline(node.content);
      if (text === "[]") return null;
      return node.type === "heading" ? `h${node.attrs?.level}:${text}` : `p:${text}`;
    }
    case "bulletList":
    case "orderedList": {
      const items = (node.content ?? []).map((item) => (item.content ?? []).map(canonBlock).filter(Boolean).join("+"));
      const kept = items.filter((i) => i && i !== "p:[]");
      return kept.length ? `${node.type}:${JSON.stringify(kept)}` : null;
    }
    case "table":
      return `table:${JSON.stringify(
        (node.content ?? []).map((row) => (row.content ?? []).map((cell) => (cell.content ?? []).map((c) => canonInline(c.content)).join(" "))),
      )}`;
    case "blockquote":
      return `quote:${JSON.stringify(canonBlocks(node.content))}`;
    case "articleBox":
      return `box:${String(node.attrs?.label ?? "").trim()}:${JSON.stringify(canonBlocks(node.content))}`;
    case "codeBlock":
      return `code:${node.attrs?.language ?? ""}:${textOf(node).replace(/\n+$/, "")}`;
    case "horizontalRule":
      return "rule";
    default:
      return `other:${textOf(node)}`;
  }
}

function canonBlocks(nodes: JSONContent[] | undefined): Canon[] {
  return (nodes ?? []).map(canonBlock).filter((c): c is Canon => c !== null);
}

export interface DocLoss {
  /** The kind of block that would change ("table", "box", "paragraph", …). */
  kind: string;
  /** Where it is: the heading it sits under (`under`), or its own opening words. */
  near: string;
  under: boolean;
}

const KIND: Record<string, string> = {
  heading: "heading",
  paragraph: "paragraph",
  bulletList: "list",
  orderedList: "list",
  table: "table",
  blockquote: "quotation",
  articleBox: "box",
  codeBlock: "code block",
  horizontalRule: "line",
};

function words(text: string, max = 8): string {
  const all = text.replace(/\s+/g, " ").trim().split(" ");
  return all.length > max ? `${all.slice(0, max).join(" ")}…` : all.join(" ");
}

/**
 * What saving this document as Markdown would change, or null when it reads back the same.
 * Run on a freshly opened document, it says whether Edit mode can keep the article at all.
 */
export function docLoss(doc: JSONContent, format: EditFormat): DocLoss | null {
  const blocks = (doc.content ?? []).filter((n) => canonBlock(n) !== null);
  const back = canonBlocks(markdownToDoc(docToMarkdown(doc), format).content);
  let heading = "";
  for (let i = 0; i < Math.max(blocks.length, back.length); i += 1) {
    const node = blocks[i];
    if (node && canonBlock(node) === back[i]) {
      if (node.type === "heading") heading = textOf(node);
      continue;
    }
    const at = node ?? blocks[blocks.length - 1];
    const kind = KIND[at?.type ?? ""] ?? "part";
    const own = at ? words(textOf(at)) : "";
    const under = node?.type !== "heading" && Boolean(heading);
    return { kind, near: under ? words(heading) : own, under };
  }
  return null;
}

/** Markdown Edit mode can't keep as it is (null = it can). */
export function markdownEditProblem(markdown: string, format: EditFormat): DocLoss | null {
  return docLoss(markdownToDoc(markdown, format), format);
}

