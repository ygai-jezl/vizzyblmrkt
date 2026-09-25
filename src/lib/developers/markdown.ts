import { Fragment, type ReactNode } from "react";
import { C, Code, Fields, H1, H2, H3, Lead, Note, OL, P, UL } from "@/components/developers/Doc";

/**
 * The developer docs as Markdown, for coding agents. It walks the SAME element
 * tree a /developers page renders — so there's one source and nothing to drift —
 * and maps the Doc building blocks to Markdown. Links become absolute, and links
 * between docs pages point at their .md versions.
 *
 * Only a small, known set of elements appears in the docs (Doc.tsx, strong, em,
 * a, Link); anything else falls back to its children.
 */

interface Element {
  type: unknown;
  props: Record<string, unknown> & { children?: ReactNode };
}

interface Ctx {
  origin: string;
}

const BLOCKS = new Set<unknown>([H1, H2, H3, P, Lead, Code, UL, OL, Note, Fields]);
const HOST_BLOCKS = new Set(["article", "section", "div", "p", "ul", "ol", "pre", "blockquote", "h1", "h2", "h3"]);

export function docToMarkdown(tree: ReactNode, origin: string): string {
  const ctx: Ctx = { origin: origin.replace(/\/+$/, "") };
  return `${blocks(tree, ctx).join("\n\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function isElement(n: unknown): n is Element {
  return typeof n === "object" && n !== null && "type" in n && "props" in n;
}

/** Children as a flat list: arrays and fragments opened, empty values dropped, plain components rendered. */
function flat(node: ReactNode): ReactNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap((n) => flat(n as ReactNode));
  if (isElement(node)) {
    if (node.type === Fragment) return flat(node.props.children);
    // A plain component we don't map (e.g. a helper inside a page): render it and walk the result.
    // Links are never called — they're read from their props.
    if (typeof node.type === "function" && !BLOCKS.has(node.type) && node.type !== C && typeof node.props.href !== "string") {
      return flat((node.type as (p: unknown) => ReactNode)(node.props));
    }
  }
  return [node];
}

function isBlock(n: ReactNode): n is ReactNode & Element {
  return isElement(n) && (BLOCKS.has(n.type) || (typeof n.type === "string" && HOST_BLOCKS.has(n.type)));
}

/** Block-level Markdown for a subtree; runs of inline content become paragraphs. */
function blocks(node: ReactNode, ctx: Ctx): string[] {
  const out: string[] = [];
  let run: ReactNode[] = [];
  const endRun = () => {
    const text = inline(run, ctx).trim();
    if (text) out.push(text);
    run = [];
  };
  for (const n of flat(node)) {
    if (isBlock(n)) {
      endRun();
      out.push(...block(n, ctx));
    } else {
      run.push(n);
    }
  }
  endRun();
  return out;
}

function block(el: Element, ctx: Ctx): string[] {
  const kids = el.props.children;
  switch (el.type) {
    case H1:
    case "h1":
      return [`# ${inline(kids, ctx).trim()}`];
    case H2:
    case "h2":
      return [`## ${inline(kids, ctx).trim()}`];
    case H3:
    case "h3":
      return [`### ${inline(kids, ctx).trim()}`];
    case P:
    case Lead:
    case "p":
      return [inline(kids, ctx).trim()].filter(Boolean);
    case Code:
    case "pre": {
      const title = typeof el.props.title === "string" ? el.props.title : "";
      const code = textOf(kids).replace(/\n+$/, "");
      const fence = "`".repeat(Math.max(3, longestRun(code, "`") + 1));
      return [`${title ? `**${title}**\n` : ""}${fence}\n${code}\n${fence}`];
    }
    case UL:
    case OL:
    case "ul":
    case "ol":
      return [list(kids, el.type === OL || el.type === "ol", ctx)];
    case Note:
    case "blockquote": {
      const parts = blocks(kids, ctx);
      if (el.props.tone === "warn" && parts[0]) parts[0] = `**Important:** ${parts[0]}`;
      return [quote(parts.join("\n\n"))];
    }
    case Fields:
      return [table(el.props.rows as Array<[string, string, ReactNode]>, ctx)];
    default:
      return blocks(kids, ctx); // article, section, div
  }
}

function inline(node: ReactNode, ctx: Ctx): string {
  return flat(node)
    .map((n) => {
      if (typeof n === "string" || typeof n === "number") return String(n);
      if (!isElement(n)) return "";
      const kids = n.props.children;
      if (typeof n.props.href === "string") return link(inline(kids, ctx).trim(), n.props.href, ctx);
      if (n.type === C || n.type === "code") return codeSpan(textOf(kids));
      if (n.type === "strong" || n.type === "b") return `**${inline(kids, ctx).trim()}**`;
      if (n.type === "em" || n.type === "i") return `*${inline(kids, ctx).trim()}*`;
      if (n.type === "br") return "\n";
      if (isBlock(n)) return blocks(n, ctx).join(" ");
      return inline(kids, ctx);
    })
    .join("");
}

function list(items: ReactNode, ordered: boolean, ctx: Ctx): string {
  return flat(items)
    .filter((n): n is ReactNode & Element => isElement(n))
    .map((li, i) => {
      const marker = ordered ? `${i + 1}. ` : "- ";
      const [first = "", ...rest] = blocks(li.props.children, ctx);
      const pad = " ".repeat(marker.length);
      const body = [first, ...rest].map((part, j) => indent(part, pad, j === 0)).join("\n\n");
      return `${marker}${body}`;
    })
    .join("\n");
}

function table(rows: Array<[string, string, ReactNode]>, ctx: Ctx): string {
  const withType = rows.some(([, type]) => type);
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
  const head = withType ? "| Field | Type | Notes |\n| --- | --- | --- |" : "| Field | Notes |\n| --- | --- |";
  const body = rows.map(([name, type, notes]) => {
    const cells = [codeSpan(name), ...(withType ? [type ? codeSpan(type) : ""] : []), inline(notes, ctx)];
    return `| ${cells.map(cell).join(" | ")} |`;
  });
  return [head, ...body].join("\n");
}

function link(text: string, href: string, ctx: Ctx): string {
  if (href.startsWith("#")) return text; // in-page anchors don't survive the move to Markdown
  const url = absolute(href, ctx);
  return !text || text === url ? `<${url}>` : `[${text}](${url})`;
}

function absolute(href: string, ctx: Ctx): string {
  if (!href.startsWith("/")) return href;
  const path = href.split("#")[0]!;
  // Another docs page → its Markdown twin (files like llms-full.txt or schema/*.json stay as they are).
  const isPage = (path === "/developers" || path.startsWith("/developers/")) && !/\.[a-z]+$/i.test(path);
  return isPage ? `${ctx.origin}${path}.md` : `${ctx.origin}${href}`;
}

function codeSpan(s: string): string {
  const ticks = "`".repeat(longestRun(s, "`") + 1);
  const pad = ticks.length > 1 || s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${ticks}${pad}${s}${pad}${ticks}`;
}

function textOf(node: ReactNode): string {
  return flat(node)
    .map((n) => (typeof n === "string" || typeof n === "number" ? String(n) : isElement(n) ? textOf(n.props.children) : ""))
    .join("");
}

function longestRun(s: string, ch: string): number {
  let best = 0;
  let cur = 0;
  for (const c of s) {
    cur = c === ch ? cur + 1 : 0;
    best = Math.max(best, cur);
  }
  return best;
}

function indent(s: string, pad: string, skipFirst: boolean): string {
  return s
    .split("\n")
    .map((line, i) => (i === 0 && skipFirst) || !line ? line : `${pad}${line}`)
    .join("\n");
}

function quote(s: string): string {
  return s
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}
