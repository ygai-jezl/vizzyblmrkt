import type { LiveRow } from "../handlers/types";
import type { McpFill, McpStream } from "../manifest";
import { todayIn } from "../period";
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

/** Openings tried in a text wrapped in words before giving up. */
const MAX_OPENINGS = 20;

/**
 * The JSON a text holds: all of it, else the first object or list inside it, whichever starts
 * first, read to its own balanced end (strings and escapes respected), so a list in words is read
 * as the list and braces in the words after it don't matter.
 */
export function jsonIn(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* words around it: look inside */
  }
  let tried = 0;
  for (let i = 0; i < text.length && tried < MAX_OPENINGS; i++) {
    if (text[i] !== "{" && text[i] !== "[") continue;
    tried += 1;
    const end = balancedEnd(text, i);
    if (end < 0) continue;
    try {
      return JSON.parse(text.slice(i, end + 1));
    } catch {
      /* balanced but not JSON (a brace in the words): the next opening */
    }
  }
  return undefined;
}

/** Where the object or list opening at `start` closes, or -1 when it never does or closes wrongly. */
function balancedEnd(text: string, start: number): number {
  const want: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") want.push("}");
    else if (c === "[") want.push("]");
    else if (c === "}" || c === "]") {
      if (want.pop() !== c) return -1;
      if (!want.length) return i;
    }
  }
  return -1;
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

/**
 * A number as a number, or null: never a string that looks like one. A path that names a list
 * counts its items, so a manifest can say how many engines or competitors a row lists.
 */
export const numberAt = (v: unknown): number | null => (Array.isArray(v) ? v.length : typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * What a key's place in the stream means for its value: a key that joins on page is one of the
 * brand's own pages, and one that joins on day is a day in the stream's zone.
 */
export interface RowRules {
  /** Keys that join on page: an address on another site is never one of the brand's pages, so it is left empty. */
  pageKeys?: ReadonlySet<string>;
  /** Keys that join on day: a date or a timestamp, written as the day in `timeZone`. */
  dayKeys?: ReadonlySet<string>;
  /** The connection's account, a bare host for an MCP connector: the brand's own site. */
  account?: string;
  timeZone?: string;
}

/**
 * A page as one of the brand's own: a path as given, or an address on the account's host or one
 * of its subdomains. Another site's address is null, so its path never joins the brand's page.
 */
export function ownPage(value: string, account: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  const site = account.toLowerCase().replace(/^www\./, "");
  const host = url.hostname.toLowerCase();
  return /^https?:$/.test(url.protocol) && site && (host === site || host.endsWith(`.${site}`)) ? value : null;
}

/** A day as YYYY-MM-DD in a zone: a plain day as given, a timestamp as its day there; null for anything else. */
export function dayOf(value: string, timeZone = "UTC"): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (!/^\d{4}-\d{2}-\d{2}[T ]/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : todayIn(new Date(ms), timeZone);
}

/**
 * A stream's rows from a tool's data: each row's keys and numbers from their paths, a page key
 * kept only for the brand's own pages and a day key written as a day. Null when the rows aren't
 * where the manifest says (the provider changed its answer), so nothing is read as zero.
 */
export function streamRows(data: unknown, block: Pick<McpStream, "rows" | "more" | "keys" | "measures">, rules: RowRules = {}): { rows: LiveRow[]; more: boolean } | null {
  const list = valueAt(data, block.rows);
  if (!Array.isArray(list)) return null;
  const rows = list.map((item) => {
    const row: LiveRow = {};
    for (const [key, path] of Object.entries(block.keys)) {
      const text = keyText(valueAt(item, path));
      row[key] = text === null ? null : rules.pageKeys?.has(key) ? ownPage(text, rules.account ?? "") : rules.dayKeys?.has(key) ? dayOf(text, rules.timeZone) : text;
    }
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
