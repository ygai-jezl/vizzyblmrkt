/**
 * Pipe tables, read the same way by every Markdown parser in the app: the blog's article parser
 * (src/lib/content/blog/markdown.ts) and Vizzy's chat renderer
 * (src/components/admin/chat/MarkdownMessage.tsx). Pure, dependency free and client safe.
 *
 * As GitHub Flavored Markdown's table extension (github.github.com/gfm/#tables-extension-):
 * - a table is a header row, then a separator row of hyphens (a colon at either end sets the
 *   column's alignment) with the same number of cells, at least 2;
 * - its rows run to the first blank line or line with no pipe, and each is cut or padded to the
 *   header's width, so a short or long row can't skew the table;
 * - `\|` in a cell is a literal pipe.
 * A header row whose separator hasn't arrived yet (a reply still streaming) is not a table.
 */

export const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** How a column's cells line up, from its separator cell (":--", ":-:", "--:"); null = not set. */
export type TableAlign = "left" | "center" | "right" | null;

export interface MarkdownTable {
  header: string[];
  /** One per header cell. */
  align: TableAlign[];
  /** Every row has the header's width. */
  rows: string[][];
  /** The index of the first line after the table. */
  next: number;
}

/** Split one pipe-table row into its cells (`\|` is a literal pipe). */
export function splitRow(line: string): string[] {
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

/** True when lines[i] is a table's header row and lines[i + 1] its separator. */
export function isTableStart(lines: readonly string[], i: number): boolean {
  const head = lines[i] ?? "";
  const delim = lines[i + 1] ?? "";
  if (!head.includes("|") || !delim.includes("-") || !TABLE_DELIM.test(delim)) return false;
  // The delimiter row must describe the same columns as the header (so a lone "---"
  // rule under a line that happens to hold a pipe is not read as a table).
  return splitRow(delim).length === splitRow(head).length && splitRow(head).length >= 2;
}

function alignOf(cell: string): TableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

/** The table starting at lines[i], or null when no table starts there. */
export function readTable(lines: readonly string[], i: number): MarkdownTable | null {
  if (!isTableStart(lines, i)) return null;
  const at = (k: number): string => lines[k] ?? "";
  const header = splitRow(at(i));
  const align = splitRow(at(i + 1)).map(alignOf);
  const rows: string[][] = [];
  let j = i + 2;
  while (j < lines.length && at(j).trim() !== "" && at(j).includes("|")) {
    const cells = splitRow(at(j));
    rows.push(header.map((_, c) => cells[c] ?? ""));
    j += 1;
  }
  return { header, align, rows, next: j };
}
