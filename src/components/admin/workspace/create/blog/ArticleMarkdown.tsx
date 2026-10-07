"use client";

import React, { useMemo } from "react";
import {
  lastUpdatedOf,
  parseArticle,
  parseInline,
  unescapeMarkdown,
  type ArticleBlock,
  type Inline,
} from "@/lib/content/blog/markdown";

/**
 * A blog article's Markdown as the reader will see it. It draws the SAME parse the HTML
 * export, the CITABLE check and the schema markup read (parseArticle / parseInline), so
 * the preview can't disagree with what is handed over — tables, boxes, quotations and
 * code included, none of which the chat renderer (MarkdownMessage) knows. Built as React
 * elements (never dangerouslySetInnerHTML): raw HTML in the copy stays inert text, and a
 * link is only a link when the parser accepted its target.
 */

const LINK =
  "text-blue-600 underline underline-offset-2 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300";
const INLINE_CODE = "rounded bg-neutral-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-neutral-800";
const CELL = "border border-neutral-300 px-3 py-2 align-top dark:border-neutral-700";

// Every block carries its own top margin and the first one drops it, so the article sits
// flush under whatever frames it and a box's contents sit flush under its label.
const HEADING = {
  h2: "mt-9 text-[22px] font-bold leading-snug tracking-tight first:mt-0",
  h3: "mt-7 text-lg font-semibold leading-snug first:mt-0",
  h4: "mt-5 text-[15px] font-semibold first:mt-0",
} as const;

function inline(nodes: Inline[], keyPrefix: string): React.ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (n.t) {
      case "text":
        // The HTML export unescapes its text the same way, so the two read alike.
        return unescapeMarkdown(n.v);
      case "code":
        return (
          <code key={key} className={INLINE_CODE}>
            {n.v}
          </code>
        );
      case "strong":
        return (
          <strong key={key} className="font-semibold">
            {inline(n.c, key)}
          </strong>
        );
      case "em":
        return <em key={key}>{inline(n.c, key)}</em>;
      default:
        return (
          <a key={key} href={n.href} target="_blank" rel="noopener noreferrer" className={LINK}>
            {inline(n.c, key)}
          </a>
        );
    }
  });
}

const text = (markdown: string, key: string) => inline(parseInline(markdown), key);

function block(b: ArticleBlock, key: string): React.ReactElement | null {
  switch (b.kind) {
    case "heading": {
      // The frame prints the article's title itself, so an H1 left in the body is a section.
      const Tag = b.level <= 2 ? "h2" : b.level === 3 ? "h3" : "h4";
      return (
        <Tag key={key} className={HEADING[Tag]}>
          {text(b.text, key)}
        </Tag>
      );
    }
    case "paragraph":
      // The "Last updated" line is a dateline, not body copy.
      return lastUpdatedOf(b.text) ? (
        <p key={key} className="mt-2 text-xs text-neutral-500 first:mt-0 dark:text-neutral-400">
          {text(b.text, key)}
        </p>
      ) : (
        <p key={key} className="mt-4 first:mt-0">
          {text(b.text, key)}
        </p>
      );
    case "list": {
      if (!b.items.length) return null;
      const Tag = b.ordered ? "ol" : "ul";
      return (
        <Tag
          key={key}
          className={`mt-4 space-y-1.5 pl-6 marker:text-neutral-500 first:mt-0 dark:marker:text-neutral-400 ${
            b.ordered ? "list-decimal" : "list-disc"
          }`}
        >
          {b.items.map((item, i) => (
            <li key={i} className="pl-1">
              {text(item, `${key}-${i}`)}
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        // A comparison table can be wider than the column it sits in — it scrolls, the page doesn't.
        <div key={key} className="mt-5 overflow-x-auto first:mt-0">
          <table className="w-full border-collapse text-left text-sm leading-6">
            <thead>
              <tr>
                {b.header.map((cell, c) => (
                  <th key={c} scope="col" className={`${CELL} bg-neutral-100 font-semibold dark:bg-neutral-800`}>
                    {text(cell, `${key}-h${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className={CELL}>
                      {text(cell, `${key}-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "callout": {
      const inner = b.blocks.map((child, i) => block(child, `${key}-${i}`));
      // A label makes it a box that is part of the article ("Key facts", "TL;DR", "Answer").
      if (b.label) {
        return (
          <div
            key={key}
            className="mt-5 rounded-lg border border-neutral-300 bg-neutral-50 px-4 py-3 first:mt-0 dark:border-neutral-700 dark:bg-neutral-900"
          >
            <p className="font-bold">{text(b.label, `${key}-label`)}</p>
            {b.blocks.length ? <div className="mt-2">{inner}</div> : null}
          </div>
        );
      }
      // No label = somebody's exact words.
      if (!b.blocks.length) return null;
      return (
        <blockquote
          key={key}
          className="mt-5 border-l-4 border-neutral-300 pl-4 text-[17px] italic leading-7 text-neutral-700 first:mt-0 dark:border-neutral-600 dark:text-neutral-300"
        >
          {inner}
        </blockquote>
      );
    }
    case "code":
      return (
        <div
          key={key}
          className="mt-5 overflow-hidden rounded-md border border-neutral-200 bg-neutral-50 first:mt-0 dark:border-neutral-800 dark:bg-neutral-900"
        >
          {b.lang ? (
            <div className="flex px-3 pt-2">
              <span className="rounded bg-neutral-200 px-1.5 py-0.5 font-mono text-[10px] uppercase leading-none tracking-wide text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                {b.lang}
              </span>
            </div>
          ) : null}
          {/* Schema markup and text diagrams must read exactly as written: every space and
              line break kept, a long line scrolls instead of wrapping. */}
          <pre className="overflow-x-auto whitespace-pre p-3 font-mono text-xs not-italic leading-snug">
            <code>{b.text}</code>
          </pre>
        </div>
      );
    default:
      return <hr key={key} className="my-8 border-neutral-200 first:mt-0 dark:border-neutral-800" />;
  }
}

export function ArticleMarkdown({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => parseArticle(markdown), [markdown]);
  if (!blocks.length) return null;
  return <div className="break-words text-[15px] leading-7">{blocks.map((b, i) => block(b, `b${i}`))}</div>;
}
