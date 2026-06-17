"use client";

import React from "react";

/**
 * Minimal, dependency-free markdown renderer for agent responses. Handles the
 * common subset the agent emits — headings, paragraphs, fenced + inline code,
 * bullet/numbered lists, bold, and links — without pulling in react-markdown.
 * Output is built as React elements (never dangerouslySetInnerHTML), so raw
 * HTML in the model output is rendered as inert text. Revisit react-markdown
 * only if rich tables/GFM become necessary (see plan §Phase 1 / R4).
 */

const INLINE_PATTERN =
  /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/|\/)[^)\s]+\))/g;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE_PATTERN.lastIndex = 0;
  let i = 0;
  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0] ?? "";
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-neutral-800"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch) {
        nodes.push(
          <a
            key={key}
            href={linkMatch[2] ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 underline underline-offset-2 hover:text-blue-500 dark:text-blue-400"
          >
            {linkMatch[1] ?? token}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

type Block =
  | { kind: "code"; lines: string[] }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "p"; text: string };

function parseBlocks(content: string): Block[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const at = (k: number): string => lines[k] ?? "";
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = at(i);

    // Fenced code block
    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !at(i).trimStart().startsWith("```")) {
        code.push(at(i));
        i++;
      }
      i++; // skip closing fence
      blocks.push({ kind: "code", lines: code });
      continue;
    }

    // Headings
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "#").length,
        text: heading[2] ?? "",
      });
      i++;
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(at(i))) {
        items.push(at(i).replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(at(i))) {
        items.push(at(i).replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-special lines
    const para: string[] = [];
    while (
      i < lines.length &&
      at(i).trim() !== "" &&
      !at(i).trimStart().startsWith("```") &&
      !/^(#{1,3})\s+/.test(at(i)) &&
      !/^\s*[-*]\s+/.test(at(i)) &&
      !/^\s*\d+\.\s+/.test(at(i))
    ) {
      para.push(at(i));
      i++;
    }
    blocks.push({ kind: "p", text: para.join(" ") });
  }
  return blocks;
}

export function MarkdownMessage({ content }: { content: string }) {
  const blocks = parseBlocks(content);
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {blocks.map((block, idx) => {
        switch (block.kind) {
          case "code":
            return (
              <pre
                key={idx}
                className="overflow-x-auto rounded-md bg-neutral-100 p-3 font-mono text-xs dark:bg-neutral-900"
              >
                <code>{block.lines.join("\n")}</code>
              </pre>
            );
          case "heading": {
            const cls =
              block.level === 1
                ? "text-base font-semibold"
                : block.level === 2
                  ? "text-sm font-semibold"
                  : "text-sm font-medium";
            return (
              <p key={idx} className={cls}>
                {renderInline(block.text, `h${idx}`)}
              </p>
            );
          }
          case "ul":
            return (
              <ul key={idx} className="list-disc space-y-1 pl-5">
                {block.items.map((item, j) => (
                  <li key={j}>{renderInline(item, `ul${idx}-${j}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={idx} className="list-decimal space-y-1 pl-5">
                {block.items.map((item, j) => (
                  <li key={j}>{renderInline(item, `ol${idx}-${j}`)}</li>
                ))}
              </ol>
            );
          default:
            return <p key={idx}>{renderInline(block.text, `p${idx}`)}</p>;
        }
      })}
    </div>
  );
}
