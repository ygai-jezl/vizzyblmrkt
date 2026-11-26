import { z } from "zod";
import { isCalendarDay } from "@/lib/types/recordField";

/**
 * A view on People (piece C): which people to show, in which order, with which columns. A view is
 * filters joined by "all of these" or "any of these", up to 10 columns and one sort. The search box
 * is not part of a view: it narrows what a view shows while someone looks, and is never saved.
 *
 * A filter names what it is on (`on`): one of the brand's People fields by its id (`fld_...`), or a
 * built in one read from what the People list reads (its `memberOf` tags, reach, last active,
 * first seen and email domain), so a view rebuilt from a group counts the same as the group.
 *
 * Pure: zod and plain data only, so client components can import it.
 */

export const VIEW_LIMITS = {
  filters: 10,
  /** Values one filter picks (options, ideas, products, team members). */
  values: 20,
  /** Columns, Person included. */
  columns: 10,
  /** Characters of typed words in one filter. */
  wordsChars: 200,
  /** The most days an "in the last" or "in the next" filter counts. */
  days: 3650,
  /** People one run reads: the newest of its starting group. */
  readCap: 5000,
  /** Rows a page shows, and the most the rows route reads at once. */
  page: 50,
} as const;

export const VIEW_MATCHES = ["all", "any"] as const;
export type ViewMatch = (typeof VIEW_MATCHES)[number];

/**
 * The built in filters. `launch` (an idea while the words are on), `via` (how they joined:
 * a launch's form or the brand's own site), `launches_many` (in more than one idea), `product`,
 * `stage` (`<connectionId>:<stage>`) and `quiet` (a product's id) read the People list's tags;
 * `group` (`<connectionId>:<entity id>`) a product group, which starts only from a person's
 * "Everyone in this group"; `can_email` their reach; `last_active` and `first_seen` their times;
 * `email_domain` their address's domain.
 */
export const BUILT_IN_FILTERS = [
  "launch",
  "via",
  "launches_many",
  "product",
  "stage",
  "quiet",
  "group",
  "can_email",
  "last_active",
  "first_seen",
  "email_domain",
] as const;
export type BuiltInFilter = (typeof BUILT_IN_FILTERS)[number];

export function isBuiltInFilter(v: unknown): v is BuiltInFilter {
  return typeof v === "string" && (BUILT_IN_FILTERS as readonly string[]).includes(v);
}

/** Columns that aren't fields. Person is always first. */
export const BUILT_IN_COLUMNS = ["person", "where_from", "stage", "can_email", "last_active", "first_seen"] as const;
export type BuiltInColumn = (typeof BUILT_IN_COLUMNS)[number];

export function isBuiltInColumn(v: unknown): v is BuiltInColumn {
  return typeof v === "string" && (BUILT_IN_COLUMNS as readonly string[]).includes(v);
}

/** The columns a new view starts with: the People list's own. */
export const DEFAULT_COLUMNS: readonly string[] = ["person", "where_from", "stage", "can_email", "last_active"];

/**
 * Every comparison. Which ones a filter offers depends on what it is on (conditions.ts):
 * - options: any_of, all_of (a multi select), none_of;
 * - yes or no: is;
 * - numbers and amounts: eq, ne, gt, gte, lt, lte, between;
 * - days: on, before, after, in_last, in_next, over_ago (more than so many days ago);
 * - typed words: contains, not_contains, equals, not_equals;
 * - empty, not_empty.
 */
export const VIEW_OPS = [
  "any_of",
  "all_of",
  "none_of",
  "is",
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "on",
  "before",
  "after",
  "in_last",
  "in_next",
  "over_ago",
  "contains",
  "not_contains",
  "equals",
  "not_equals",
  "empty",
  "not_empty",
] as const;
export type ViewOp = (typeof VIEW_OPS)[number];

export const OPTION_OPS = ["any_of", "all_of", "none_of"] as const satisfies readonly ViewOp[];
export const NUMBER_OPS = ["eq", "ne", "gt", "gte", "lt", "lte"] as const satisfies readonly ViewOp[];
export const DAY_OPS = ["on", "before", "after"] as const satisfies readonly ViewOp[];
export const DAYS_OPS = ["in_last", "in_next", "over_ago"] as const satisfies readonly ViewOp[];
/** The comparisons that hold typed words: never saved (decision 3). */
export const WORDS_OPS = ["contains", "not_contains", "equals", "not_equals"] as const satisfies readonly ViewOp[];
export const EMPTY_OPS = ["empty", "not_empty"] as const satisfies readonly ViewOp[];

const has = (list: readonly string[], v: string) => list.includes(v);
export const isOptionOp = (op: ViewOp) => has(OPTION_OPS, op);
export const isNumberOp = (op: ViewOp) => has(NUMBER_OPS, op) || op === "between";
export const isDayOp = (op: ViewOp) => has(DAY_OPS, op);
export const isDaysOp = (op: ViewOp) => has(DAYS_OPS, op);
export const isWordsOp = (op: ViewOp) => has(WORDS_OPS, op);
export const isEmptyOp = (op: ViewOp) => has(EMPTY_OPS, op);

/** A filter's value: option ids, yes or no, a number, two numbers, a day, a count of days or typed words. */
export type ViewValue = string[] | boolean | number | [number, number] | string;

export interface ViewFilter {
  /** A People field's id, or a built in filter. */
  on: string;
  op: ViewOp;
  /** Absent for empty and not_empty. */
  value?: ViewValue;
}

export interface ViewSort {
  /** A column: a field's id or a built in column. */
  by: string;
  dir: "asc" | "desc";
}

export interface ViewDefinition {
  match: ViewMatch;
  filters: ViewFilter[];
  /** Person first, then up to 9 more. */
  columns: string[];
  /** Null: the People list's order, most recently active first. */
  sort: ViewSort | null;
}

const FILTER_ON = new RegExp(`^(fld_[a-z0-9]{12}|${BUILT_IN_FILTERS.join("|")})$`);
const COLUMN_ID = new RegExp(`^(fld_[a-z0-9]{12}|${BUILT_IN_COLUMNS.join("|")})$`);
const VALUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,299}$/;

/** Whether a value fits a comparison's shape (what it is on is checked in conditions.ts). Pure. */
export function valueFits(op: ViewOp, value: unknown): boolean {
  if (isEmptyOp(op)) return value === undefined;
  if (isOptionOp(op)) {
    return (
      Array.isArray(value) &&
      value.length >= 1 &&
      value.length <= VIEW_LIMITS.values &&
      value.every((v) => typeof v === "string" && VALUE_ID.test(v)) &&
      new Set(value).size === value.length
    );
  }
  if (op === "is") return typeof value === "boolean";
  if (op === "between") {
    return Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number" && Number.isFinite(v)) && (value[0] as number) <= (value[1] as number);
  }
  if (isNumberOp(op)) return typeof value === "number" && Number.isFinite(value);
  if (isDayOp(op)) return typeof value === "string" && isCalendarDay(value);
  if (isDaysOp(op)) return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= VIEW_LIMITS.days;
  if (isWordsOp(op)) return typeof value === "string" && value.trim().length >= 1 && value.length <= VIEW_LIMITS.wordsChars;
  return false;
}

export const ViewFilterSchema = z
  .object({
    on: z.string().regex(FILTER_ON),
    op: z.enum(VIEW_OPS),
    value: z.union([z.array(z.union([z.string(), z.number()])), z.boolean(), z.number(), z.string()]).optional(),
  })
  .strict()
  .refine((f) => valueFits(f.op, f.value), { message: "value_does_not_fit" }) as unknown as z.ZodType<ViewFilter>;

export const ViewSortSchema = z.object({ by: z.string().regex(COLUMN_ID), dir: z.enum(["asc", "desc"]) }).strict();

/** A view's shape: its caps, Person first among its columns, each column once. Whether its fields exist is checked against the field list (conditions.ts). */
export const ViewDefinitionSchema = z
  .object({
    match: z.enum(VIEW_MATCHES),
    filters: z.array(ViewFilterSchema).max(VIEW_LIMITS.filters),
    columns: z.array(z.string().regex(COLUMN_ID)).min(1).max(VIEW_LIMITS.columns),
    sort: ViewSortSchema.nullable(),
  })
  .strict()
  .superRefine((d, c) => {
    if (d.columns[0] !== "person") c.addIssue({ code: "custom", path: ["columns"], message: "person_first" });
    if (new Set(d.columns).size !== d.columns.length) c.addIssue({ code: "custom", path: ["columns"], message: "column_twice" });
  }) as unknown as z.ZodType<ViewDefinition>;

/** A view with no filters, the list's columns and order. */
export function emptyView(): ViewDefinition {
  return { match: "all", filters: [], columns: [...DEFAULT_COLUMNS], sort: null };
}

/**
 * A copy of a view with its keys in one order. Firestore keeps a map's keys by name, not in the
 * order they were written, so a view read back must not be compared as it was stored. Pure.
 */
export function viewInOrder(d: ViewDefinition): ViewDefinition {
  return {
    match: d.match,
    filters: d.filters.map((f) => (f.value === undefined ? { on: f.on, op: f.op } : { on: f.on, op: f.op, value: f.value })),
    columns: [...d.columns],
    sort: d.sort ? { by: d.sort.by, dir: d.sort.dir } : null,
  };
}

/** Whether two views are the same, whatever order their keys were stored in. Pure. */
export function sameView(a: ViewDefinition, b: ViewDefinition): boolean {
  return JSON.stringify(viewInOrder(a)) === JSON.stringify(viewInOrder(b));
}
