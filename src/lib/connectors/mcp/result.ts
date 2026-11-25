import type { LiveRow } from "../handlers/types";
import type { McpFill, McpStream } from "../manifest";
import type { McpToolResult } from "./client";

/**
 * Reading a tool's result as data (ADR-0019), the same way for every MCP connector: where its
 * rows are, what each key and number is, and the arguments filled on each read. Pure.
 */

/**
 * A tool result's data: its structured content when it has some, else the JSON in its first text
 * block. A server may wrap that JSON in words (a note that the content is untrusted), so the first
 * JSON object or list in the text is taken when the whole text isn't JSON. Undefined when there is
 * none.
 */
export function resultData(result: McpToolResult): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null && typeof result.structuredContent === "object") return result.structuredContent;
  const block = result.content.find((c): c is { type: "text"; text: string } => !!c && typeof c === "object" && (c as { type?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string");
  if (!block) return undefined;
  return jsonIn(block.text);
}

/** The JSON a text holds: all of it, or the first object or list inside it. */
export function jsonIn(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* words around it: look inside */
  }
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const from = text.indexOf(open);
    const to = text.lastIndexOf(close);
    if (from < 0 || to <= from) continue;
    try {
      return JSON.parse(text.slice(from, to + 1));
    } catch {
      /* not this one */
    }
  }
  return undefined;
}

/** The value at a path (`$` is the value itself), or undefined when the path isn't there. */
export function valueAt(value: unknown, path: string): unknown {
  if (path === "$") return value;
  let cur: unknown = value;
  for (const name of path.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, name)) return undefined;
    cur = (cur as Record<string, unknown>)[name];
  }
  return cur;
}

/** Longest key value kept: a monitored prompt or a page address is never longer than this. */
const MAX_KEY = 500;

/** A key's value as text: a string, a number written out, or a list of them joined ("chatgpt, claude"). */
export function keyText(v: unknown): string | null {
  const one = (x: unknown) => (typeof x === "string" ? x : typeof x === "number" && Number.isFinite(x) ? String(x) : null);
  const text = Array.isArray(v) ? v.map(one).filter((x): x is string => x !== null).join(", ") : one(v);
  if (text === null) return null;
  // One line, no control characters: these are a provider's words.
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean ? clean.slice(0, MAX_KEY) : null;
}

/** A number as a number, or null: never a string that looks like one. */
export const numberAt = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * A stream's rows from a tool's data: each row's keys and numbers from their paths. Null when the
 * rows aren't where the manifest says (the provider changed its answer), so nothing is read as zero.
 */
export function streamRows(data: unknown, block: Pick<McpStream, "rows" | "more" | "keys" | "measures">): { rows: LiveRow[]; more: boolean } | null {
  const list = valueAt(data, block.rows);
  if (!Array.isArray(list)) return null;
  const rows = list.map((item) => {
    const row: LiveRow = {};
    for (const [key, path] of Object.entries(block.keys)) row[key] = keyText(valueAt(item, path));
    for (const [measure, path] of Object.entries(block.measures)) row[measure] = numberAt(valueAt(item, path));
    return row;
  });
  return { rows, more: block.more ? valueAt(data, block.more) === true : false };
}

/** What a read fills its arguments from. */
export type FillValues = Partial<Record<McpFill, string | number>>;

/**
 * A call's arguments: the fixed ones, then the filled ones. Null when a fill has nothing to fill it
 * (a stream read for one page, asked without one).
 */
export function callArgs(block: Pick<McpStream, "args" | "fill">, values: FillValues): Record<string, unknown> | null {
  const out: Record<string, unknown> = { ...(block.args ?? {}) };
  for (const [name, fill] of Object.entries(block.fill ?? {})) {
    const v = values[fill];
    if (v === undefined || v === "") return null;
    out[name] = v;
  }
  return out;
}

/** True when a stream's call needs a page: it is read for one page only. */
export const needsPage = (block: Pick<McpStream, "fill"> | undefined): boolean => Object.values(block?.fill ?? {}).some((f) => f === "page" || f === "pageUrl");

/** A page on the account's host, when the account is a bare host: https://example.com/pricing. */
export function pageUrlOf(account: string, page: string | undefined): string | undefined {
  if (!page || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(account)) return undefined;
  return `https://${account}${page}`;
}
