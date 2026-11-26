import type { DraftAccept, DraftedRowResult } from "@/lib/tenant";
import { WORK_MESSAGES, type WorkRefusal } from "./words";

/**
 * What Work's service answers (ADR-0020): a value, or a refusal with the words a person reads.
 * The routes turn it into a response (src/lib/work/http.ts). Pure.
 */

export type WorkStatusCode = 400 | 403 | 404 | 409;

export interface WorkIssue {
  path: string;
  message: string;
}

export type WorkResult<T> =
  | { ok: true; status: 200 | 201; value: T }
  | { ok: false; status: WorkStatusCode; error: WorkRefusal | "invalid_input"; message: string; issues?: WorkIssue[] };

export type WorkRefused = Extract<WorkResult<never>, { ok: false }>;

/** The status each refusal answers with. */
const STATUS: Record<WorkRefusal, WorkStatusCode> = {
  no_organisation: 409,
  not_found: 404,
  forbidden_delete: 403,
  forbidden_import: 403,
  whole_business_owners: 403,
  brand_not_yours: 403,
  brand_unknown: 400,
  other_region: 409,
  changed: 409,
  tasks_full: 409,
  entries_full: 409,
  decisions_full: 409,
  no_repo: 400,
  repo_not_selected: 400,
  loop_line_operators: 403,
  loop_line_repo: 400,
  idea_missing: 400,
  measure_operators: 403,
  type_not_built: 400,
  product_missing: 400,
  product_look: 400,
  product_whole_business: 400,
  blocker_missing: 400,
  blocker_self: 400,
  no_check: 409,
  measure_check_read: 409,
  read_not_measure: 409,
  measure_check_kept: 409,
  check_task_missing: 400,
  plan_link_missing: 400,
  plan_recommended: 400,
  plan_choice: 400,
  plan_question: 400,
  replaces_missing: 400,
  replaces_other: 400,
  import_empty: 400,
  import_too_many: 400,
  import_no_title: 400,
  import_too_big: 400,
  regions_down: 409,
  day_bad: 400,
  suggestion_missing: 404,
  suggestion_decided: 409,
  suggestion_changed: 409,
  suggestion_other_region: 409,
  suggestion_must_have: 400,
  suggestion_reason: 400,
  draft_missing: 404,
  draft_decided: 409,
  draft_changed: 409,
  plan_drafted: 400,
  pick_unknown: 400,
  draft_choice: 400,
};

export function ok<T>(value: T, status: 200 | 201 = 200): WorkResult<T> {
  return { ok: true, status, value };
}

export function refuse(error: WorkRefusal, message: string = WORK_MESSAGES[error]): WorkRefused {
  return { ok: false, status: STATUS[error], error, message };
}

/** A request whose shape is wrong: the first few issues, by path. */
export function invalidInput(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): WorkRefused {
  return {
    ok: false,
    status: 400,
    error: "invalid_input",
    message: WORK_MESSAGES.invalid_input,
    issues: issues.slice(0, 10).map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  };
}

/** A row saved from a draft of Vizzy's: it takes the draft's target id, and the draft moves with it (src/lib/work/drafts.ts). */
export interface DraftedSave {
  rowId: string;
  accept: DraftAccept;
  /** The tool the row says wrote it: draft_work_log or draft_work_decision. */
  tool: string;
}

/** A draft that couldn't move, as the refusal a person reads. */
export function draftRefusal(error: Extract<DraftedRowResult, { ok: false }>["error"]): WorkRefused {
  return refuse(error === "changed" ? "draft_changed" : error === "not_found" ? "draft_missing" : "draft_decided");
}
