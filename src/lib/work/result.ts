import { WORK_MESSAGES, type WorkRefusal } from "./words";

/**
 * What Work's service answers (ADR-0018): a value, or a refusal with the words a person reads.
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
  import_empty: 400,
  import_too_many: 400,
  import_no_title: 400,
  import_too_big: 400,
  regions_down: 409,
  day_bad: 400,
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
