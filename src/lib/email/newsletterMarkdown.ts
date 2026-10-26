import { parseArticle, parseInline, unescapeMarkdown, type ArticleBlock, type Inline } from "@/lib/content/blog/markdown";
import { escapeHtml, isSafeHref } from "./emailRender";

/**
 * A newsletter hub's Markdown as email HTML (NEWSLETTER_MARKDOWN_EMAIL_ENABLED): headings, bold,
 * lists, links, boxes, quotations, tables, code and rules, styled inline because most inboxes
 * ignore a style block. Read through the article parser, so it reads the Markdown exactly as the
 * preview and Edit mode do. All text is escaped; a link is kept when sanitizeEmailHtml would keep it
 * (http(s), mailto:, a site path, or a merge value such as {{hub_url}}). Colours are left to the
 * email's own style, apart from the faint lines and fills that mark boxes and tables; paragraphs,
 * list items and links keep the inbox's own spacing and colour, which keeps the HTML small. Pure.
 */

/** The longest body a broadcast takes (the broadcasts API's limit). */
export const MAX_BROADCAST_BODY_CHARS = 50_000;

const linkTarget = (raw: string): string | null => {
  const href = raw.trim();
  return isSafeHref(href) ? href : null;
};

const S = {
  h1: "margin:0 0 16px;font-size:26px;line-height:1.25;font-weight:700",
  h2: "margin:28px 0 12px;font-size:21px;line-height:1.3;font-weight:700",
  h3: "margin:22px 0 8px;font-size:18px;line-height:1.35;font-weight:700",
  h4: "margin:18px 0 8px;font-size:16px;line-height:1.4;font-weight:700",
  code: "font-family:Menlo,Consolas,monospace;font-size:0.9em;background:#f4f4f5;padding:0 3px;border-radius:3px",
  pre: "margin:0 0 16px;padding:12px;background:#f4f4f5;border-radius:6px;font-family:Menlo,Consolas,monospace;font-size:13px;line-height:1.5;white-space:pre-wrap",
  quote: "margin:0 0 16px;padding:0 0 0 14px;border-left:4px solid #d4d4d8;font-style:italic",
  box: "border:1px solid #d4d4d8;background:#fafafa;border-radius:8px;padding:14px 18px",
  boxLabel: "margin:0 0 8px;font-weight:700",
  table: "width:100%;border-collapse:collapse;margin:0 0 16px;font-size:14px;line-height:1.5",
  th: "border:1px solid #d4d4d8;padding:8px 10px;text-align:left;vertical-align:top;background:#f4f4f5;font-weight:700",
  td: "border:1px solid #d4d4d8;padding:8px 10px;text-align:left;vertical-align:top",
  hr: "border:0;border-top:1px solid #e4e4e7;margin:24px 0",
} as const;

function inline(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text":
          return escapeHtml(unescapeMarkdown(n.v));
        case "code":
          return `<code style="${S.code}">${escapeHtml(n.v)}</code>`;
        case "strong":
          return `<strong>${inline(n.c)}</strong>`;
        case "em":
          return `<em>${inline(n.c)}</em>`;
        default:
          return `<a href="${escapeHtml(n.href)}">${inline(n.c)}</a>`;
      }
    })
    .join("");
}

const text = (md: string) => inline(parseInline(md, linkTarget));

function block(b: ArticleBlock, styled: boolean): string {
  const st = (style: string) => (styled ? ` style="${style}"` : "");
  switch (b.kind) {
    case "heading": {
      const tag = `h${b.level}` as const;
      return `<${tag}${st(S[tag])}>${text(b.text)}</${tag}>`;
    }
    case "paragraph":
      return `<p>${text(b.text)}</p>`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      return `<${tag}>${b.items.map((i) => `<li>${text(i)}</li>`).join("")}</${tag}>`;
    }
    case "table": {
      const head = b.header.map((h) => `<th${st(S.th)}>${text(h)}</th>`).join("");
      const rows = b.rows.map((r) => `<tr>${r.map((c) => `<td${st(S.td)}>${text(c)}</td>`).join("")}</tr>`).join("");
      return `<table role="presentation"${st(S.table)}><tr>${head}</tr>${rows}</table>`;
    }
    case "callout": {
      const inner = b.blocks.map((x) => block(x, styled)).join("");
      if (!b.label) return `<blockquote${st(S.quote)}>${inner}</blockquote>`;
      // A box is a one-cell table: the border and fill hold in every inbox.
      return `<table role="presentation" width="100%"${st("border-collapse:collapse;margin:0 0 16px")}><tr><td${st(S.box)}><p${st(S.boxLabel)}><strong>${text(b.label)}</strong></p>${inner}</td></tr></table>`;
    }
    case "code":
      return `<pre${st(S.pre)}>${escapeHtml(b.text)}</pre>`;
    default:
      return `<hr${st(S.hr)}>`;
  }
}

/**
 * A newsletter hub's Markdown as the inner HTML of an email. A body whose styled HTML wouldn't
 * fit a broadcast is drawn without the inline styles (the structure stays); a caller that must
 * fit one checks the length still (a body of nothing but tiny table cells can outgrow it).
 */
export function renderNewsletterHtml(markdown: string): string {
  const blocks = parseArticle(markdown);
  const styled = blocks.map((b) => block(b, true)).join("\n");
  return styled.length <= MAX_BROADCAST_BODY_CHARS ? styled : blocks.map((b) => block(b, false)).join("\n");
}
