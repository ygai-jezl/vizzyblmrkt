import type { PasteBatchView, Skipped } from "@/lib/crm/paste/batch";
import {
  addedWords,
  alreadyAtAdd,
  COMPANY_REMOVE,
  PASTE_MESSAGES,
  PASTE_NOTES,
  PASTE_WORDS,
  pasteErrorText,
  readSummary,
  rowReasonLine,
} from "@/lib/crm/paste/words";
import { api, type ApiResponse } from "../connect/api";

/**
 * Paste a list's calls (RAISE_PASTE_ENABLED) and the pure helpers the sheet shows them with. Every
 * word comes from src/lib/crm/paste/words.ts, which the help page (paste-a-list) quotes. Nothing
 * here keeps the pasted text: it goes to the server once, and only the rows the card adds come back.
 */

export type { PasteBatchView, Skipped };

/** What reading a list answers: a card waiting in Review, or nothing to add. */
export interface ReadAnswer {
  batch: PasteBatchView | null;
  skipped: Skipped[];
  warning: string | null;
  error?: string;
}

/** What adding a list answers. */
export interface AddAnswer {
  added: { people: number; companies: number };
  already: { people: number; companies: number };
  fieldsNotSaved: number;
  error?: string;
}

const listPath = (id: string) => `/api/admin/audience/paste/${encodeURIComponent(id)}`;

/** Read the pasted rows into one card waiting in Review. */
export function readList(text: string, source: string): Promise<ApiResponse<ReadAnswer>> {
  return api<ReadAnswer>("/api/admin/audience/paste", { method: "POST", body: JSON.stringify({ text, source }) });
}

/** A waiting list, as Review's link and Vizzy's card open it. */
export function openList(id: string): Promise<ApiResponse<{ batch?: PasteBatchView; warning?: string | null; error?: string }>> {
  return api(listPath(id));
}

/** Add everyone on a waiting list. `rev`: the list as the sheet shows it. */
export function addList(id: string, rev: number): Promise<ApiResponse<AddAnswer>> {
  return api<AddAnswer>(listPath(id), { method: "POST", body: JSON.stringify({ action: "add", rev }) });
}

/** Dismiss a waiting list: nobody is added and its rows are cleared. */
export function dismissList(id: string, rev: number): Promise<ApiResponse<{ dismissed?: boolean; error?: string }>> {
  return api(listPath(id), { method: "POST", body: JSON.stringify({ action: "dismiss", rev }) });
}

/** Remove a company with no people (an admin, while paste is on). */
export function removeCompany(id: string): Promise<ApiResponse<{ removed?: boolean; error?: string }>> {
  return api(`/api/admin/crm/companies/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** The words for a failed call, by its error code; "That didn't work" for anything else. */
export function pasteError(r: Pick<ApiResponse<unknown>, "data">): string {
  return pasteErrorText(r.data);
}

/** What the box says before it sends anything: the rows first, then where they are from. */
export function checkBox(text: string, source: string): "empty" | "source_needed" | null {
  if (!text.trim()) return "empty";
  if (!source.replace(/\s+/g, " ").trim()) return "source_needed";
  return null;
}

/** The box's own message for `checkBox`'s answer. */
export function boxMessage(problem: "empty" | "source_needed"): string {
  return PASTE_MESSAGES[problem];
}

/** Rows read but not on the card: left out, or already in People or Companies. */
export function notAdded(view: Pick<PasteBatchView, "counts">): number {
  return view.counts.left + view.counts.already;
}

/** "Read 13 rows: 10 people and 3 companies to add, 1 left out." */
export function viewSummary(view: Pick<PasteBatchView, "counts">): string {
  const c = view.counts;
  return readSummary(c.read, c.people, c.companies, notAdded(view));
}

/** "Row 7: Needs an email, a phone or a web address", one line per row, in row order. */
export function skippedLines(skipped: readonly Skipped[]): string[] {
  return [...skipped].sort((a, b) => a.row - b.row).map((s) => rowReasonLine(s.row, s.reason));
}

/** "Person" or "Company". */
export function kindWord(kind: "person" | "company"): string {
  return kind === "person" ? PASTE_WORDS.kindPerson : PASTE_WORDS.kindCompany;
}

/** A header and what it was read as: "Website as Web address", or just "Email" when they match. */
export function columnChip(c: { header: string; as: string }): string {
  return c.header.trim().toLowerCase() === c.as.trim().toLowerCase() ? c.header : `${c.header} as ${c.as}`;
}

/** The notes under a read list: what was left out from firms, profile links, values, and Not yet. */
export function noteLines(view: Pick<PasteBatchView, "notes" | "counts">): string[] {
  return [...view.notes.map((n) => PASTE_NOTES[n]), ...(view.counts.people ? [PASTE_NOTES.not_yet] : [])];
}

/** After the add: who was added, who was already here, and values that didn't save. */
export function addedLines(r: Pick<AddAnswer, "added" | "already" | "fieldsNotSaved">): string[] {
  const already = r.already.people + r.already.companies;
  return [addedWords(r.added), ...(already ? [alreadyAtAdd(already)] : []), ...(r.fieldsNotSaved ? [PASTE_NOTES.values_left_out] : [])];
}

/** Remove company's words for a failed call. */
export function removeError(r: Pick<ApiResponse<{ error?: string }>, "data">): string {
  return r.data?.error === "has_people" ? COMPANY_REMOVE.has_people : COMPANY_REMOVE.failed;
}

/** The address without `?paste=`, keeping the tab and anything else, once the sheet closes. */
export function withoutPaste(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete("paste");
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}
