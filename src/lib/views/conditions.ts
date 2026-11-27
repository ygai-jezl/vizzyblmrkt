import { CHECKED, fieldTag } from "@/lib/audience/fieldTags";
import { MANY_LAUNCHES_TAG } from "@/lib/ideas/list";
import { FIELD_ID, OPTION_ID, type FieldType, type RecordField } from "@/lib/types/recordField";
import {
  isBuiltInColumn,
  isBuiltInFilter,
  isEmptyOp,
  isOptionOp,
  isWordsOp,
  ViewDefinitionSchema,
  type BuiltInFilter,
  type ViewDefinition,
  type ViewFilter,
  type ViewOp,
} from "./types";

/**
 * What each filter is on, which comparisons it offers, and how a filter stands against the brand's
 * People field list now (piece C). Built in filters read what the People list reads: its
 * `memberOf` tags (src/lib/audience/peopleList.ts), reach, last active, first seen and email
 * domain. Field filters read the values under `fields.<fieldId>`. Pure.
 */

/** What a filter is on, by kind. A field's kind is its type. */
export type FilterKind = "tags" | "group" | "flag" | "instant" | "words" | FieldType;

export const BUILT_IN_KIND: Record<BuiltInFilter, FilterKind> = {
  launch: "tags",
  via: "tags",
  launches_many: "flag",
  product: "tags",
  stage: "tags",
  quiet: "tags",
  group: "group",
  can_email: "flag",
  last_active: "instant",
  first_seen: "instant",
  email_domain: "words",
};

const OPS: Record<FilterKind, readonly ViewOp[]> = {
  tags: ["any_of", "none_of"],
  group: ["any_of"],
  flag: ["is"],
  instant: ["in_last", "over_ago", "on", "before", "after", "empty", "not_empty"],
  words: ["equals", "not_equals", "contains", "not_contains", "empty", "not_empty"],
  text: ["contains", "not_contains", "equals", "not_equals", "empty", "not_empty"],
  number: ["eq", "ne", "gt", "gte", "lt", "lte", "between", "empty", "not_empty"],
  currency: ["eq", "ne", "gt", "gte", "lt", "lte", "between", "empty", "not_empty"],
  date: ["in_last", "in_next", "over_ago", "on", "before", "after", "empty", "not_empty"],
  checkbox: ["is"],
  select: ["any_of", "none_of", "empty", "not_empty"],
  status: ["any_of", "none_of", "empty", "not_empty"],
  multi_select: ["any_of", "all_of", "none_of", "empty", "not_empty"],
  // Email, phone and link values can say who someone is: only whether there is one.
  email: ["empty", "not_empty"],
  phone: ["empty", "not_empty"],
  link: ["empty", "not_empty"],
  team_member: ["any_of", "none_of", "empty", "not_empty"],
};

/** The comparisons a kind offers, the first one picked when a filter is added. */
export function opsFor(kind: FilterKind): readonly ViewOp[] {
  return OPS[kind];
}

const ID = "[A-Za-z0-9_-]{1,128}";
const ID_RE = new RegExp(`^${ID}$`);
const STAGE_RE = new RegExp(`^${ID}:(new|onboarding|stuck|activated|member)$`);
const GROUP_RE = new RegExp(`^${ID}:[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`);
const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Whether a value fits a built in tags or group filter. */
function builtInValueOk(on: BuiltInFilter, v: string): boolean {
  switch (on) {
    case "via":
      return v === "form" || v === "site";
    case "stage":
      return STAGE_RE.test(v);
    case "group":
      return GROUP_RE.test(v);
    case "launch":
    case "product":
    case "quiet":
      return ID_RE.test(v);
    default:
      return false;
  }
}

/** The People list's tag a built in filter's value stands for, or null. */
export function builtInTag(on: BuiltInFilter, value: string | null = null): string | null {
  if (on === "launches_many") return MANY_LAUNCHES_TAG;
  if (value === null || !builtInValueOk(on, value)) return null;
  return `${on}:${value}`;
}

/** Whether a filter holds words someone typed (a text field's or the email domain's): never saved (decision 3). */
export function holdsTypedWords(f: Pick<ViewFilter, "op">): boolean {
  return isWordsOp(f.op);
}

/** Why a filter is left out of a view now, and the view says so. */
export type FilterFlag = "archived_field" | "archived_option" | "unknown_field" | "invalid";

export interface CheckedFilter {
  /** The filter as it applies now (archived options left out), or null when it is ignored. */
  use: ViewFilter | null;
  /** The field it is on, for a field filter. */
  field: RecordField | null;
  /** archived_option keeps the filter with its options in use; the rest ignore it. */
  flag: FilterFlag | null;
}

function fieldOf(fields: readonly RecordField[], id: string): RecordField | null {
  return fields.find((f) => f.key === id) ?? null;
}

/**
 * How a filter stands against the field list now: a filter on an archived field is ignored, and an
 * archived option is left out of it (ignored when no option is left); a field the list doesn't have,
 * or a comparison or value that doesn't fit, ignores it too.
 */
export function checkFilter(f: ViewFilter, fields: readonly RecordField[]): CheckedFilter {
  const ignore = (flag: FilterFlag, field: RecordField | null = null): CheckedFilter => ({ use: null, field, flag });
  if (isBuiltInFilter(f.on)) {
    const kind = BUILT_IN_KIND[f.on];
    if (!opsFor(kind).includes(f.op)) return ignore("invalid");
    if (kind === "tags" || kind === "group") {
      const values = f.value as string[];
      if (!values.every((v) => builtInValueOk(f.on as BuiltInFilter, v))) return ignore("invalid");
    }
    return { use: f, field: null, flag: null };
  }
  if (!FIELD_ID.test(f.on)) return ignore("invalid");
  const field = fieldOf(fields, f.on);
  if (!field || field.object !== "person") return ignore("unknown_field");
  if (field.archivedAt) return ignore("archived_field", field);
  if (!opsFor(field.type).includes(f.op)) return ignore("invalid", field);
  if (isOptionOp(f.op) && (field.type === "select" || field.type === "status" || field.type === "multi_select")) {
    const values = f.value as string[];
    const live = new Set((field.options ?? []).filter((o) => !o.archivedAt).map((o) => o.id));
    const kept = values.filter((v) => live.has(v));
    if (!kept.length) return ignore("archived_option", field);
    if (kept.length < values.length) return { use: { ...f, value: kept }, field, flag: "archived_option" };
    return { use: f, field, flag: null };
  }
  if (isOptionOp(f.op) && field.type === "team_member" && !(f.value as string[]).every((v) => USER_ID.test(v))) return ignore("invalid", field);
  return { use: f, field, flag: null };
}

/**
 * The People list groups a filter keeps everyone inside, each one `memberOf` tag the list reads
 * with its index: a "match all" view may start from the smallest. One value of an idea, how they
 * joined, a product, a stage, quiet or a product group; more than one idea; one option of a select,
 * status or multi select (each of an "all of"); a ticked box. None for anything else.
 */
export function startTags(f: ViewFilter, field: RecordField | null): string[] {
  if (isBuiltInFilter(f.on)) {
    const kind = BUILT_IN_KIND[f.on];
    if (f.on === "launches_many") return f.op === "is" && f.value === true ? [MANY_LAUNCHES_TAG] : [];
    if ((kind === "tags" || kind === "group") && f.op === "any_of" && Array.isArray(f.value) && f.value.length === 1) {
      const tag = builtInTag(f.on, String(f.value[0]));
      return tag ? [tag] : [];
    }
    return [];
  }
  if (!field) return [];
  if (field.type === "checkbox") return f.op === "is" && f.value === true ? [fieldTag(field.key, CHECKED)] : [];
  if (field.type === "select" || field.type === "status" || field.type === "multi_select") {
    const values = Array.isArray(f.value) ? (f.value as string[]) : [];
    if (f.op === "any_of" && values.length === 1) return [fieldTag(field.key, values[0]!)];
    if (f.op === "all_of" && field.type === "multi_select") return values.map((v) => fieldTag(field.key, v));
  }
  return [];
}

/** What a column shows, or null for a column the view can't show now (a field archived or not in the list). */
export type ColumnKind = "person" | "where_from" | "stage" | "can_email" | "last_active" | "first_seen" | FieldType;

export function columnKind(id: string, fields: readonly RecordField[]): ColumnKind | null {
  if (isBuiltInColumn(id)) return id;
  const field = fieldOf(fields, id);
  return field && field.object === "person" && !field.archivedAt ? field.type : null;
}

/** Whether a view can sort by a column: one with an order. Where from, stage, multi select, team member, email, phone and link have none. */
export function isSortable(kind: ColumnKind | null): boolean {
  return kind !== null && ["person", "can_email", "last_active", "first_seen", "text", "number", "currency", "date", "checkbox", "select", "status"].includes(kind);
}

export type DefinitionCheck =
  | { ok: true; definition: ViewDefinition }
  | { ok: false; error: "invalid_view"; reason: string }
  | { ok: false; error: "typed_words"; filters: number[] };

/**
 * Whether a view may be saved: its shape, every filter, column and sort against the field list
 * (archived fields and options may stay, so a view keeps working once they are brought back; a
 * field or option the list never had may not), and no typed words (decision 3), naming the filters
 * that hold them. Pure.
 */
export function checkForSave(raw: unknown, fields: readonly RecordField[]): DefinitionCheck {
  const parsed = ViewDefinitionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid_view", reason: parsed.error.issues[0]?.message ?? "shape" };
  const def = parsed.data;
  const bad = (reason: string): DefinitionCheck => ({ ok: false, error: "invalid_view", reason });
  for (const f of def.filters) {
    if (isBuiltInFilter(f.on)) {
      if (checkFilter(f, fields).flag === "invalid") return bad(`filter:${f.on}`);
      continue;
    }
    const field = fieldOf(fields, f.on);
    if (!field || field.object !== "person") return bad("unknown_field");
    if (!opsFor(field.type).includes(f.op)) return bad(`op:${f.op}`);
    if (isOptionOp(f.op)) {
      const values = f.value as string[];
      if (field.type === "team_member") {
        if (!values.every((v) => USER_ID.test(v))) return bad("team_member");
      } else {
        const known = new Set((field.options ?? []).map((o) => o.id));
        if (!values.every((v) => OPTION_ID.test(v) && known.has(v))) return bad("unknown_option");
      }
    }
  }
  for (const c of def.columns) {
    if (isBuiltInColumn(c)) continue;
    const field = fieldOf(fields, c);
    if (!field || field.object !== "person") return bad("unknown_column");
  }
  if (def.sort) {
    const field = isBuiltInColumn(def.sort.by) ? null : fieldOf(fields, def.sort.by);
    const kind = isBuiltInColumn(def.sort.by) ? def.sort.by : field && field.object === "person" ? field.type : null;
    if (!isSortable(kind)) return bad("sort");
  }
  const typed = def.filters.flatMap((f, i) => (holdsTypedWords(f) ? [i] : []));
  if (typed.length) return { ok: false, error: "typed_words", filters: typed };
  return { ok: true, definition: def };
}

/** Whether a filter is complete enough to apply: its comparison and a value that fits it. */
export function isComplete(f: Partial<ViewFilter>): f is ViewFilter {
  if (!f.on || !f.op) return false;
  if (isEmptyOp(f.op)) return f.value === undefined;
  return f.value !== undefined && f.value !== null && (!Array.isArray(f.value) || f.value.length > 0) && f.value !== "";
}

/**
 * The filters for what the People list was showing when someone pressed Add filter: its group (a
 * `memberOf` tag, as listPeople reads it) and Only people we can email. A view rebuilt from a group
 * this way counts the same as the group.
 */
export function filtersFromGroup(tag: string, canEmail: boolean): ViewFilter[] {
  const out: ViewFilter[] = [];
  const [kind, ...rest] = tag.split(":");
  const value = rest.join(":");
  if (tag === MANY_LAUNCHES_TAG) out.push({ on: "launches_many", op: "is", value: true });
  else if (kind === "launch" || kind === "via" || kind === "product" || kind === "stage" || kind === "quiet" || kind === "group") {
    if (value && builtInValueOk(kind, value)) out.push({ on: kind, op: "any_of", value: [value] });
  } else if (kind === "field") {
    const [fieldId, option] = rest;
    if (fieldId && FIELD_ID.test(fieldId) && option) out.push(option === CHECKED ? { on: fieldId, op: "is", value: true } : { on: fieldId, op: "any_of", value: [option] });
  }
  if (canEmail) out.push({ on: "can_email", op: "is", value: true });
  return out;
}
