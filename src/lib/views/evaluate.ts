import { addDaysToKey, isValidTimezone, localDateKey } from "@/lib/lifecycle/sendWindow";
import type { FieldValue, RecordField } from "@/lib/types/recordField";
import { builtInTag, checkFilter, columnKind, isSortable, type FilterFlag } from "./conditions";
import { isBuiltInFilter, type ViewDefinition, type ViewFilter } from "./types";

/**
 * A view, in memory (piece C): filter the people read for it, sort them stably and count them.
 * Only people in Everyone (tagged `all`) are ever in a view, as only they are in the People list.
 * Day filters use the brand's time zone (UTC when unset or not a real zone). A filter on an
 * archived field is flagged and ignored; an archived option is left out of its filter. Pure.
 */

/** What a run reads of each person: only the fields its filters and sort use are filled. */
export interface ViewPerson {
  id: string;
  sortKey?: string;
  memberOf?: string[];
  reach?: "yes" | "limited" | "no";
  activeAt?: string;
  firstSeenAt?: string;
  emailDomain?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  fields?: Record<string, FieldValue>;
}

export interface EvaluateContext {
  /** The brand's People field list, archived fields included. */
  fields: readonly RecordField[];
  /** IANA zone; anything else reads as UTC. */
  timeZone?: string | null;
  now: Date;
}

export interface Evaluation {
  /** The people who match, in the view's order. */
  ids: string[];
  count: number;
  /** Per filter, in order: why it is ignored or narrowed now, or null. */
  flags: Array<FilterFlag | null>;
  /** The sort names a column it can't sort by now (an archived field): the list's order is used. */
  sortIgnored: boolean;
}

/** The filters that apply now, and why each other one doesn't. */
export function applicableFilters(def: Pick<ViewDefinition, "filters">, fields: readonly RecordField[]) {
  const checked = def.filters.map((f) => checkFilter(f, fields));
  return {
    active: checked.flatMap((c) => (c.use ? [{ filter: c.use, field: c.field }] : [])),
    flags: checked.map((c) => c.flag),
  };
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** The day of an instant in the zone, or of a stored day as it is. */
function dayOf(at: string | null | undefined, tz: string): string | null {
  if (!at) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return at;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : localDateKey(ms, tz);
}

function dayMatch(day: string | null, f: ViewFilter, today: string): boolean {
  if (f.op === "empty") return day === null;
  if (f.op === "not_empty") return day !== null;
  if (day === null) return false;
  switch (f.op) {
    case "on":
      return day === f.value;
    case "before":
      return day < (f.value as string);
    case "after":
      return day > (f.value as string);
    case "in_last":
      return day <= today && day >= addDaysToKey(today, -(f.value as number));
    case "in_next":
      return day >= today && day <= addDaysToKey(today, f.value as number);
    case "over_ago":
      return day < addDaysToKey(today, -(f.value as number));
    default:
      return false;
  }
}

const norm = (s: string) => s.trim().toLowerCase();

/** Typed words against a value; a negative comparison keeps people with no value. */
function wordsMatch(value: unknown, f: ViewFilter, strip?: (s: string) => string): boolean {
  const text = typeof value === "string" ? value : "";
  if (f.op === "empty") return !text.trim();
  if (f.op === "not_empty") return !!text.trim();
  const clean = strip ?? ((s: string) => s);
  const v = norm(clean(text));
  const w = norm(clean(String(f.value ?? "")));
  switch (f.op) {
    case "contains":
      return !!v && v.includes(w);
    case "not_contains":
      return !v || !v.includes(w);
    case "equals":
      return !!v && v === w;
    case "not_equals":
      return v !== w;
    default:
      return false;
  }
}

function numberMatch(value: unknown, f: ViewFilter): boolean {
  if (f.op === "empty") return isEmpty(value);
  if (f.op === "not_empty") return !isEmpty(value);
  const n = typeof value === "number" && Number.isFinite(value) ? value : null;
  if (f.op === "ne") return n === null || n !== f.value;
  if (n === null) return false;
  switch (f.op) {
    case "eq":
      return n === f.value;
    case "gt":
      return n > (f.value as number);
    case "gte":
      return n >= (f.value as number);
    case "lt":
      return n < (f.value as number);
    case "lte":
      return n <= (f.value as number);
    case "between": {
      const [a, b] = f.value as [number, number];
      return n >= a && n <= b;
    }
    default:
      return false;
  }
}

/** Options (or user ids) a person's value holds against an "any of", "all of" or "none of". */
function optionsMatch(value: unknown, f: ViewFilter): boolean {
  if (f.op === "empty") return isEmpty(value);
  if (f.op === "not_empty") return !isEmpty(value);
  const held = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? [value] : [];
  const want = (f.value as string[]) ?? [];
  if (f.op === "any_of") return want.some((w) => held.includes(w));
  if (f.op === "all_of") return want.every((w) => held.includes(w));
  if (f.op === "none_of") return !want.some((w) => held.includes(w));
  return false;
}

function builtInMatch(p: ViewPerson, f: ViewFilter, today: string, tz: string): boolean {
  const tags = p.memberOf ?? [];
  switch (f.on) {
    case "launch":
    case "via":
    case "product":
    case "stage":
    case "quiet":
    case "group": {
      const wanted = ((f.value as string[]) ?? []).map((v) => builtInTag(f.on as "launch", v)).filter((t): t is string => !!t);
      const any = wanted.some((t) => tags.includes(t));
      return f.op === "none_of" ? !any : any;
    }
    case "launches_many":
      return tags.includes(builtInTag("launches_many")!) === (f.value === true);
    case "can_email":
      return (p.reach === "yes") === (f.value === true);
    case "last_active":
      return dayMatch(dayOf(p.activeAt, tz), f, today);
    case "first_seen":
      return dayMatch(dayOf(p.firstSeenAt, tz), f, today);
    case "email_domain":
      return wordsMatch(p.emailDomain, f, (s) => s.replace(/^@+/, ""));
    default:
      return false;
  }
}

function fieldMatch(p: ViewPerson, f: ViewFilter, field: RecordField, today: string): boolean {
  const value = p.fields?.[field.key];
  switch (field.type) {
    case "text":
      return wordsMatch(value, f);
    case "number":
    case "currency":
      return numberMatch(value, f);
    case "date":
      return dayMatch(typeof value === "string" ? value : null, f, today);
    case "checkbox":
      return (value === true) === (f.value === true);
    case "select":
    case "status":
    case "multi_select":
    case "team_member":
      return optionsMatch(value, f);
    case "email":
    case "phone":
    case "link":
      return f.op === "empty" ? isEmpty(value) : f.op === "not_empty" ? !isEmpty(value) : false;
  }
}

/** Whether one person passes one filter that applies now. */
export function matchesFilter(p: ViewPerson, f: ViewFilter, field: RecordField | null, today: string, tz: string): boolean {
  if (isBuiltInFilter(f.on)) return builtInMatch(p, f, today, tz);
  return field ? fieldMatch(p, f, field, today) : false;
}

const REACH_ORDER = { yes: 2, limited: 1, no: 0 } as const;

/** A person's sort value for a column, or null for none (always last). */
function sortValue(p: ViewPerson, by: string, field: RecordField | null): string | number | null {
  switch (by) {
    case "person": {
      const name = [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || p.email || "";
      return name ? name.toLowerCase() : null;
    }
    case "last_active":
      return p.activeAt ?? null;
    case "first_seen":
      return p.firstSeenAt ?? null;
    case "can_email":
      return REACH_ORDER[p.reach ?? "no"];
  }
  if (!field) return null;
  const v = p.fields?.[field.key];
  if (isEmpty(v)) return null;
  switch (field.type) {
    case "number":
    case "currency":
      return typeof v === "number" ? v : null;
    case "date":
      return typeof v === "string" ? v : null;
    case "text":
      return typeof v === "string" ? v.toLowerCase() : null;
    case "checkbox":
      return v === true ? 1 : 0;
    case "select":
    case "status": {
      const i = (field.options ?? []).findIndex((o) => o.id === v);
      return i < 0 ? null : i;
    }
    default:
      return null;
  }
}

/** The zone a brand's days are counted in: its own when it is a real one, else UTC. */
export function zoneOf(tz: string | null | undefined): string {
  return isValidTimezone(tz) ? tz : "UTC";
}

/**
 * Filter, sort and count people for a view. `people` come in the list's order (most recently
 * active first); ties in the sort keep that order, and people with no value sort last either way.
 */
export function evaluateView(people: readonly ViewPerson[], def: ViewDefinition, ctx: EvaluateContext): Evaluation {
  const tz = zoneOf(ctx.timeZone);
  const today = localDateKey(ctx.now.getTime(), tz);
  const { active, flags } = applicableFilters(def, ctx.fields);
  const passes = (p: ViewPerson) => {
    if (!(p.memberOf ?? []).includes("all")) return false;
    if (!active.length) return true;
    const test = (a: (typeof active)[number]) => matchesFilter(p, a.filter, a.field, today, tz);
    return def.match === "any" ? active.some(test) : active.every(test);
  };
  const matched = people.filter(passes);

  let sortIgnored = false;
  let ordered = matched;
  if (def.sort) {
    const field = ctx.fields.find((f) => f.key === def.sort!.by) ?? null;
    if (!isSortable(columnKind(def.sort.by, ctx.fields))) {
      sortIgnored = true;
    } else {
      const dir = def.sort.dir === "asc" ? 1 : -1;
      ordered = matched
        .map((p, i) => ({ p, i, v: sortValue(p, def.sort!.by, field) }))
        .sort((a, b) => {
          if (a.v === null || b.v === null) return a.v === null && b.v === null ? a.i - b.i : a.v === null ? 1 : -1;
          const c = typeof a.v === "string" && typeof b.v === "string" ? a.v.localeCompare(b.v, "en") : a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
          return c !== 0 ? c * dir : a.i - b.i;
        })
        .map((x) => x.p);
    }
  }
  return { ids: ordered.map((p) => p.id), count: ordered.length, flags, sortIgnored };
}
