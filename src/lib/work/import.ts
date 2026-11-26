import { readStage, type CompanyStage } from "./stages";
import { isDay, MAX_WORK_REF, WORK_LIMITS, type WorkLink, type WorkStatus } from "./types";
import type { ImportField } from "./inputs";
import type { ImportRowProblem } from "./words";

/**
 * Reading a Backlog tab (ADR-0018): a CSV file, or rows pasted from Google Sheets (tab
 * separated), up to 1,000 rows. No dependency: quoted fields, doubled quotes, commas and line
 * breaks inside quotes, CRLF and a byte order mark are handled here.
 *
 * - Headers are matched by name, ignoring case and punctuation: MVP, Ref, Backlog item,
 *   Description, Notes, Status, Clippings, Stage, Brand and Check, and a few common others. The
 *   person can change what a column fills (`mapping`), or skip it.
 * - A status Work doesn't know (Idea, Someday) comes in as To do, and the preview names it.
 * - A row's number is its record in the sheet, the header being row 1, as the task's origin keeps it.
 *
 * Pure: the service checks brands, refs and caps, and writes (src/lib/work/service.ts). What the
 * sheet says is data, never instructions.
 */

export interface Sheet {
  delimiter: "," | "\t";
  headers: string[];
  /** Each data row's cells and its record number in the sheet (the header is 1). */
  rows: Array<{ row: number; cells: string[] }>;
}

/** Split CSV or tab separated text into records of cells. */
export function parseRecords(text: string, delimiter: "," | "\t"): string[][] {
  const s = text.replace(/^﻿/, "");
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
      i += ch === "\r" && s[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

/** Tabs in the first line mean a paste from a spreadsheet; otherwise commas. */
export function delimiterOf(text: string): "," | "\t" {
  const first = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  return first.includes("\t") ? "\t" : ",";
}

/** The sheet's header row and its data rows, with fully blank rows left out. */
export function parseSheet(text: string): Sheet {
  const delimiter = delimiterOf(text);
  const records = parseRecords(text, delimiter);
  const headerAt = records.findIndex((r) => r.some((c) => c.trim() !== ""));
  if (headerAt < 0) return { delimiter, headers: [], rows: [] };
  const headers = records[headerAt]!.map((h) => h.trim());
  const rows: Sheet["rows"] = [];
  records.slice(headerAt + 1).forEach((cells, i) => {
    if (cells.some((c) => c.trim() !== "")) rows.push({ row: headerAt + i + 2, cells });
  });
  return { delimiter, headers, rows };
}

const HEADER_WORDS: Record<Exclude<ImportField, "skip">, string[]> = {
  mustHave: ["mvp", "must have", "must", "musthave"],
  ref: ["ref", "#", "no", "number", "id", "ref no"],
  title: ["backlog item", "task", "title", "item", "name", "backlog"],
  description: ["description", "desc", "details", "detail"],
  notes: ["notes", "note", "comments", "comment"],
  status: ["status", "state"],
  clipping: ["clippings", "clipping", "clip"],
  stage: ["stage", "path stage"],
  brand: ["brand"],
  check: ["check", "check on", "next check", "look again"],
};

const normalHeader = (h: string) =>
  h
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, " ")
    .trim();

export interface ImportColumn {
  /** The header as the sheet has it. */
  head: string;
  /** The field it fills: what Work matched, or what the person picked; skip for neither. */
  field: ImportField;
}

/** What each column fills: the person's pick, else Work's match by name, else skip. A field is filled by its first column only. */
export function matchColumns(headers: readonly string[], mapping: Readonly<Record<string, ImportField>> = {}): ImportColumn[] {
  const taken = new Set<ImportField>();
  return headers.map((head) => {
    const picked = Object.hasOwn(mapping, head) ? mapping[head]! : undefined;
    const n = normalHeader(head);
    const matched = (Object.entries(HEADER_WORDS) as Array<[ImportField, string[]]>).find(([, words]) => words.includes(n))?.[0];
    let field: ImportField = picked ?? matched ?? "skip";
    if (field !== "skip" && taken.has(field)) field = "skip";
    if (field !== "skip") taken.add(field);
    return { head, field };
  });
}

const STATUS_WORDS: Record<string, WorkStatus> = {
  "": "todo",
  "to do": "todo",
  todo: "todo",
  "not started": "todo",
  open: "todo",
  new: "todo",
  "in progress": "in_progress",
  doing: "in_progress",
  wip: "in_progress",
  started: "in_progress",
  underway: "in_progress",
  waiting: "waiting",
  blocked: "waiting",
  "on hold": "waiting",
  done: "done",
  complete: "done",
  completed: "done",
  finished: "done",
  dropped: "dropped",
  cancelled: "dropped",
  canceled: "dropped",
  "won't do": "dropped",
  "wont do": "dropped",
};

/** A sheet's status word as Work's: unknown words come in as To do, and say so. */
export function readStatus(word: string): { status: WorkStatus; known: boolean } {
  const w = word.trim().toLowerCase().replace(/\s+/g, " ");
  const s = Object.hasOwn(STATUS_WORDS, w) ? STATUS_WORDS[w] : undefined;
  return s ? { status: s, known: true } : { status: "todo", known: false };
}

const YES = new Set(["yes", "y", "true", "x", "1", "✓", "✔", "mvp", "must", "must have"]);

/** A row's check: a day (YYYY-MM-DD), or the ref of a task to wait for ("#75", "when #75 is done", "after 75"). */
export type ImportCheck = { kind: "date"; day: string } | { kind: "after_task"; ref: number };

export function readCheck(text: string): ImportCheck | null | "bad" {
  const t = text.trim();
  if (!t) return null;
  if (isDay(t)) return { kind: "date", day: t };
  const m = /^(?:when|after|once)?\s*#?\s*(\d{1,6})(?:\s+is\s+done)?\.?$/i.exec(t);
  if (m) return { kind: "after_task", ref: Number(m[1]) };
  return "bad";
}

export interface ImportRow {
  row: number;
  title: string;
  ref: number | null;
  mustHave: boolean;
  description: string;
  notes: string;
  status: WorkStatus;
  /** The sheet's own status word, when Work doesn't know it. */
  unknownStatus: string | null;
  stage: CompanyStage | null;
  /** The Brand column as typed; the service matches it to a brand. */
  brand: string | null;
  check: ImportCheck | null;
  /** A clipping that is a link. */
  links: WorkLink[];
}

export type ImportRead = { ok: true; value: ImportRow } | { ok: false; row: number; problem: ImportRowProblem };

const isWeb = (v: string) => /^https?:\/\/\S+$/i.test(v);

/** One data row as a task's fields, or why it can't be one. */
export function readRow(columns: readonly ImportColumn[], r: Sheet["rows"][number]): ImportRead {
  const cell = (f: ImportField) => {
    const at = columns.findIndex((c) => c.field === f);
    return at < 0 ? "" : (r.cells[at] ?? "").trim();
  };
  const title = cell("title").replace(/\s+/g, " ");
  if (!title) return { ok: false, row: r.row, problem: "no_title" };
  const refText = cell("ref").replace(/^#/, "").trim();
  let ref: number | null = null;
  if (refText) {
    if (!/^\d{1,6}$/.test(refText) || Number(refText) < 1 || Number(refText) > MAX_WORK_REF) return { ok: false, row: r.row, problem: "ref_bad" };
    ref = Number(refText);
  }
  const check = readCheck(cell("check"));
  if (check === "bad") return { ok: false, row: r.row, problem: "check_bad" };
  const clip = cell("clipping");
  const links: WorkLink[] = clip && isWeb(clip) && clip.length <= WORK_LIMITS.linkUrl ? [{ url: clip }] : [];
  let notes = cell("notes");
  if (clip && !links.length) notes = notes ? `${notes}\nClipping: ${clip}` : `Clipping: ${clip}`;
  const description = cell("description");
  if (title.length > WORK_LIMITS.title || description.length > WORK_LIMITS.description || notes.length > WORK_LIMITS.notes) return { ok: false, row: r.row, problem: "too_long" };
  const statusWord = cell("status");
  const { status, known } = readStatus(statusWord);
  const brand = cell("brand");
  return {
    ok: true,
    value: {
      row: r.row,
      title,
      ref,
      mustHave: YES.has(cell("mustHave").toLowerCase()),
      description,
      notes,
      status,
      unknownStatus: known ? null : statusWord,
      stage: readStage(cell("stage")),
      brand: brand || null,
      check,
      links,
    },
  };
}

/** Every row read, the refusals by row, and the statuses Work didn't know (each once, as the sheet spells it). */
export function readSheet(sheet: Sheet, columns: readonly ImportColumn[]): { rows: ImportRow[]; problems: Array<{ row: number; problem: ImportRowProblem }>; unknownStatuses: string[] } {
  const rows: ImportRow[] = [];
  const problems: Array<{ row: number; problem: ImportRowProblem }> = [];
  const seen = new Map<number, number>();
  for (const r of sheet.rows) {
    const read = readRow(columns, r);
    if (!read.ok) {
      problems.push({ row: read.row, problem: read.problem });
      continue;
    }
    if (read.value.ref !== null) {
      if (seen.has(read.value.ref)) {
        problems.push({ row: r.row, problem: "ref_twice" });
        continue;
      }
      seen.set(read.value.ref, r.row);
    }
    rows.push(read.value);
  }
  const unknown: string[] = [];
  for (const r of rows) if (r.unknownStatus && !unknown.some((u) => u.toLowerCase() === r.unknownStatus!.toLowerCase())) unknown.push(r.unknownStatus);
  return { rows, problems, unknownStatuses: unknown };
}

/** The file's base name as an import keeps it: no folders, one line, up to 120 characters; null for none. */
export function importFileName(file: string | undefined): string | null {
  if (!file) return null;
  const base = file.split(/[\\/]/).pop()!.replace(/[\r\n\t]+/g, " ").trim();
  return base ? base.slice(0, WORK_LIMITS.importFile) : null;
}
