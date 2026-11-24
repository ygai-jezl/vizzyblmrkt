import type { JSONContent } from "@tiptap/core";
import { Fragment, type ReactNode } from "react";
import { markdownToDoc } from "@/lib/content/editor/markdownDoc";

/** A legal page's Markdown as plain, server rendered HTML (headings, paragraphs, lists, tables, links). */
export function LegalDoc({ markdown }: { markdown: string }) {
  const doc = markdownToDoc(markdown, "blog");
  return <div className="legal-doc">{renderNodes(doc.content)}</div>;
}

function safeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  return /^(https?:|mailto:|\/|#)/i.test(href) ? href : null;
}

function renderInline(node: JSONContent, key: number): ReactNode {
  if (node.type === "hardBreak") return <br key={key} />;
  if (node.type !== "text" || !node.text) return null;
  let out: ReactNode = node.text;
  for (const mark of node.marks ?? []) {
    if (mark.type === "bold") out = <strong>{out}</strong>;
    else if (mark.type === "italic") out = <em>{out}</em>;
    else if (mark.type === "code") out = <code>{out}</code>;
    else if (mark.type === "link") {
      const href = safeHref(mark.attrs?.href);
      if (href) out = <a href={href}>{out}</a>;
    }
  }
  return <Fragment key={key}>{out}</Fragment>;
}

function inline(nodes: JSONContent[] | undefined): ReactNode[] {
  return (nodes ?? []).map((n, i) => renderInline(n, i));
}

function renderNodes(nodes: JSONContent[] | undefined): ReactNode[] {
  return (nodes ?? []).map((n, i) => renderNode(n, i));
}

function renderNode(node: JSONContent, key: number): ReactNode {
  switch (node.type) {
    case "heading": {
      const level = Number(node.attrs?.level) || 2;
      const kids = inline(node.content);
      if (level <= 1) return <h1 key={key}>{kids}</h1>;
      if (level === 2) return <h2 key={key}>{kids}</h2>;
      return <h3 key={key}>{kids}</h3>;
    }
    case "paragraph":
      return <p key={key}>{inline(node.content)}</p>;
    case "bulletList":
      return <ul key={key}>{renderNodes(node.content)}</ul>;
    case "orderedList":
      return <ol key={key}>{renderNodes(node.content)}</ol>;
    case "listItem":
      return <li key={key}>{renderNodes(node.content)}</li>;
    case "blockquote":
      return <blockquote key={key}>{renderNodes(node.content)}</blockquote>;
    case "horizontalRule":
      return <hr key={key} />;
    case "codeBlock":
      return (
        <pre key={key}>
          <code>{(node.content ?? []).map((c) => c.text ?? "").join("")}</code>
        </pre>
      );
    case "table": {
      const rows = node.content ?? [];
      const head = rows[0]?.content?.every((c) => c.type === "tableHeader") ? rows[0] : null;
      const body = head ? rows.slice(1) : rows;
      const row = (r: JSONContent, i: number, cell: "th" | "td") => (
        <tr key={i}>
          {(r.content ?? []).map((c, j) =>
            cell === "th" ? <th key={j}>{renderNodes(c.content)}</th> : <td key={j}>{renderNodes(c.content)}</td>,
          )}
        </tr>
      );
      return (
        <div key={key} className="legal-table">
          <table>
            {head ? <thead>{row(head, 0, "th")}</thead> : null}
            <tbody>{body.map((r, i) => row(r, i, "td"))}</tbody>
          </table>
        </div>
      );
    }
    default:
      return node.content ? <div key={key}>{renderNodes(node.content)}</div> : null;
  }
}
