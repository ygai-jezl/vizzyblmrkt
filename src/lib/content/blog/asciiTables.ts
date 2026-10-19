/**
 * Tables a writer drew out of characters (+-----+, | cell |), inside a code block or not, turned
 * into Markdown: a pipe table when the box has a header row, else (two columns, no header) a list
 * of "**label**: text". A one-cell row at the top of the box is its title, kept as a bold line.
 * Anything else in a code block is left exactly as written. Pure + client-safe.
 */

const BORDER = /^\s*\+[-=+\s]*[-=][-=+\s]*\+?\s*$/;
const ROW = /^\s*\|.*\|\s*$/;
const FENCE = /^\s*(```|~~~)/;

const isBoxLine = (line: string) => BORDER.test(line) || ROW.test(line);
const cellsOf = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
const escapeCell = (s: string) => s.replace(/\|/g, "\\|");

/** One box (its lines, borders included) as Markdown; null when it isn't a table after all. */
function boxToMarkdown(lines: string[]): string | null {
  if (!lines.some((l) => BORDER.test(l)) || !lines.some((l) => ROW.test(l))) return null;
  let title = "";
  const rows: string[][] = [];
  let headerAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (BORDER.test(line)) {
      // A border straight after the first real row closes the header.
      if (rows.length === 1 && headerAt === -1) headerAt = 0;
      continue;
    }
    const cells = cellsOf(line);
    if (cells.length === 1) {
      if (!rows.length && !title) title = cells[0]!;
      continue;
    }
    const prev = rows[rows.length - 1];
    // A wrapped cell: the row carries on in the next line with its first cell empty.
    if (prev && cells[0] === "" && cells.length === prev.length) {
      cells.forEach((c, j) => {
        if (c) prev[j] = `${prev[j]} ${c}`.trim();
      });
      continue;
    }
    rows.push(cells);
  }
  if (!rows.length) return null;
  const width = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => [...r, ...Array.from({ length: width - r.length }, () => "")]);
  const out: string[] = [];
  if (title) out.push(`**${title.replace(/\*/g, "")}**`, "");
  const hasHeader = headerAt === 0 && padded.length > 1;
  if (!hasHeader && width === 2) {
    for (const [label, text] of padded) out.push(`- **${label!.replace(/\*/g, "")}**: ${text}`);
    return out.join("\n");
  }
  const [head, ...body] = padded;
  out.push(`| ${head!.map(escapeCell).join(" | ")} |`, `| ${head!.map(() => "---").join(" | ")} |`);
  for (const r of body) out.push(`| ${r.map(escapeCell).join(" | ")} |`);
  return out.join("\n");
}

export function asciiTablesToMarkdown(markdown: string): { body: string; converted: number } {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let converted = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      const fence = line.trim().slice(0, 3);
      let end = i + 1;
      while (end < lines.length && !lines[end]!.trim().startsWith(fence)) end += 1;
      const inner = lines.slice(i + 1, end);
      const filled = inner.filter((l) => l.trim());
      const md = filled.length && filled.every(isBoxLine) ? boxToMarkdown(filled) : null;
      if (md) {
        out.push(md);
        converted += 1;
      } else out.push(...lines.slice(i, Math.min(end + 1, lines.length)));
      i = end;
      continue;
    }
    if (BORDER.test(line)) {
      let end = i;
      while (end < lines.length && isBoxLine(lines[end]!)) end += 1;
      const md = boxToMarkdown(lines.slice(i, end));
      if (md) {
        out.push(md);
        converted += 1;
        i = end - 1;
        continue;
      }
    }
    out.push(line);
  }
  return { body: out.join("\n"), converted };
}

/** Whether some text still holds a table drawn out of characters. */
export function hasAsciiTable(markdown: string): boolean {
  return markdown.split("\n").some((l) => BORDER.test(l) && /[-=]{3,}/.test(l));
}
