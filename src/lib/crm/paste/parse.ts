/**
 * Paste a list (RAISE_PASTE_ENABLED): pasted text into a header and rows. Pure, with no AI: the
 * app's own code reads every row the same way for every brand.
 *
 * - Tab separated when the header has a tab (a copy from a sheet), a Markdown table when the
 *   header starts with `|` (its `|---|` rule line skipped), otherwise comma or semicolon
 *   separated, whichever the header has more of.
 * - Quotes as RFC 4180 has them for every delimiter: a quoted cell may hold the delimiter, a new
 *   line or a doubled quote.
 * - A byte order mark and Windows line ends are taken off, blank lines are skipped, and every
 *   cell is trimmed.
 * - The first line with something on it is the header. Rows are numbered as the sheet numbers
 *   them, the header being row 1, so "Row 7" is the founder's own row 7.
 * - Caps: 200,000 characters, 50 rows (blank ones not counted), 40 columns, and a cell over 2,000
 *   characters is left out of its row (null).
 *
 * The text is read here and never kept: callers store only what the rows become.
 */

export const PASTE_LIMITS = {
  /** Characters of pasted text read at once. */
  textChars: 200_000,
  /** Data rows, blank ones not counted. */
  rows: 50,
  /** Columns in the header. */
  columns: 40,
  /** A longer cell is left out of its row. */
  cellChars: 2_000,
  /** A longer text value is left out (values_left_out). */
  keptTextChars: 500,
  /** Where the list is from, after trimming. */
  sourceChars: 80,
  /** A header name as kept to show how it was read. */
  headerChars: 60,
} as const;

export type ParseError = "empty" | "too_many_rows" | "too_many_columns" | "too_long";

export type Delimiter = "\t" | "," | ";" | "|";

export interface SheetRow {
  /** The row's number in the sheet, the header being row 1. */
  row: number;
  /** Trimmed cells; null for one over 2,000 characters, left out of the row. */
  cells: Array<string | null>;
}

export interface Sheet {
  delimiter: Delimiter;
  /** Trimmed header names, trailing blank ones dropped. */
  header: string[];
  /** Rows with something in them, in order. */
  rows: SheetRow[];
}

const BLANK = /^\s*$/;
const RULE_CELL = /^:?-+:?$/;

/** The delimiter the header line uses (see the module note). */
export function delimiterOf(headerLine: string): Delimiter {
  if (headerLine.includes("\t")) return "\t";
  if (headerLine.trimStart().startsWith("|")) return "|";
  let commas = 0;
  let semis = 0;
  let quoted = false;
  for (const ch of headerLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ",") commas += 1;
    else if (!quoted && ch === ";") semis += 1;
  }
  return semis > commas ? ";" : ",";
}

/** Records from `start`, split by RFC 4180's rules for this delimiter. Line ends are already "\n". */
function records(text: string, start: number, delim: Delimiter): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let any = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && BLANK.test(cell)) {
      // A quote opens a cell only at its start (spaces before it are dropped).
      quoted = true;
      cell = "";
      any = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = "";
      any = true;
    } else if (ch === "\n") {
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
      any = false;
    } else {
      cell += ch;
      any = true;
    }
  }
  if (any || cell !== "" || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

/** A Markdown table's row without the empty cells its outer pipes make. */
function markdownCells(cells: string[]): string[] {
  let out = cells;
  if (out.length && BLANK.test(out[0]!)) out = out.slice(1);
  if (out.length && BLANK.test(out[out.length - 1]!)) out = out.slice(0, -1);
  return out;
}

/**
 * Read pasted text as a header and rows, or say why it can't be read. `empty`: nothing but a
 * header (or nothing at all).
 */
export function parseSheet(text: string): { ok: true; sheet: Sheet } | { ok: false; error: ParseError } {
  if (typeof text !== "string") return { ok: false, error: "empty" };
  if (text.length > PASTE_LIMITS.textChars) return { ok: false, error: "too_long" };
  const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

  // The header is the first line with something on it.
  let start = 0;
  for (;;) {
    const end = clean.indexOf("\n", start);
    const line = end < 0 ? clean.slice(start) : clean.slice(start, end);
    if (!BLANK.test(line)) break;
    if (end < 0) return { ok: false, error: "empty" };
    start = end + 1;
  }
  const lineEnd = clean.indexOf("\n", start);
  const delimiter = delimiterOf(lineEnd < 0 ? clean.slice(start) : clean.slice(start, lineEnd));

  let all = records(clean, start, delimiter).map((r) => r.map((c) => c.trim()));
  if (delimiter === "|") all = all.map(markdownCells).filter((r, i) => i === 0 || !(r.length > 0 && r.every((c) => RULE_CELL.test(c))));

  const header = [...(all[0] ?? [])];
  while (header.length && header[header.length - 1] === "") header.pop();
  if (header.length === 0) return { ok: false, error: "empty" };
  if (header.length > PASTE_LIMITS.columns) return { ok: false, error: "too_many_columns" };

  const rows: SheetRow[] = [];
  for (let i = 1; i < all.length; i += 1) {
    const cells = all[i]!.slice(0, header.length);
    if (cells.every((c) => c === "")) continue;
    if (rows.length >= PASTE_LIMITS.rows) return { ok: false, error: "too_many_rows" };
    rows.push({ row: i + 1, cells: header.map((_, c) => (c < cells.length ? (cells[c]!.length > PASTE_LIMITS.cellChars ? null : cells[c]!) : "")) });
  }
  if (rows.length === 0) return { ok: false, error: "empty" };
  return { ok: true, sheet: { delimiter, header, rows } };
}
