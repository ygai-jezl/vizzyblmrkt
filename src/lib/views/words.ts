import { ideaWord } from "@/lib/nav/terms";
import { FORMER_TEAM_MEMBER } from "@/lib/team/former";
import { currencyDigits, type RecordField } from "@/lib/types/recordField";
import { BUILT_IN_KIND, type FilterKind } from "./conditions";
import { isBuiltInColumn, isBuiltInFilter, type BuiltInColumn, type BuiltInFilter, type ViewFilter, type ViewOp, type ViewSort } from "./types";

/**
 * Views in words (piece C): what each filter, comparison, column and sort is called, a filter read
 * as a sentence ("Customer type is Wholesale", "Last order in the last 60 days"), and every message
 * the views screens show. The People list, the save dialog, Vizzy's get_view_counts and the help
 * page (your-audience, #views) share them. Plain words, no dashes (writingRules.ts). Pure.
 */

export const VIEW_MESSAGES = {
  capped: "This view checks your 5,000 most recently active people. Older people aren't included.",
  capped_group: "This view checks the 5,000 most recently active people in the group it starts from. Older people in that group aren't included.",
  capped_search: "This view checks the 5,000 most recently active people your search finds. Older people aren't included.",
  typed_words: "A saved view can't keep typed words. Remove the filters marked below to save it.",
  team_views_full: "This brand has kept as many team views as it can. Change a view in use, or bring back an archived one.",
  my_views_full: "You have kept as many of your own views as you can. Delete one you no longer use.",
  views_busy: "Views are busy. Try again in a moment.",
  archived_field: "A field this view uses was archived, so its filter is ignored.",
  archived_option: "An option this view uses was archived, so it is left out of the filter.",
  admins_only: "Only admins save team views.",
  view_too_large: "This view is too big to save. Use fewer filters, or fewer values in them.",
  view_changed: "Someone changed this view since you opened it. Open it again from Views to see their change.",
  views_changed: "Views were being saved at the same moment. Try again.",
  invalid_name: "Give the view a name of up to 60 characters.",
  invalid_view: "This view can't be saved as it is. Check its filters.",
  view_not_found: "That view is no longer there. Open Views to see the ones you can use.",
  rate_limited: "Too many views run or saved just now. Try again in a minute.",
  sort_ignored: "The column this view sorts by was archived, so it shows people in the list's order.",
  archived_view: "This team view is archived. Bring it back to change it or to show it in Views.",
  failed: "That didn't work. Try again.",
} as const;

/** What a view that read only 5,000 people says, by where it started: Everyone, one of its groups, or the search box's people. */
export function cappedText(start: { kind: "everyone" | "group" | "search" }): string {
  return start.kind === "group" ? VIEW_MESSAGES.capped_group : start.kind === "search" ? VIEW_MESSAGES.capped_search : VIEW_MESSAGES.capped;
}

/** The plain word message for an error a views route answered. */
export function viewErrorText(error: unknown): string {
  return (typeof error === "string" && (VIEW_MESSAGES as Record<string, string>)[error]) || VIEW_MESSAGES.failed;
}

/** What a view reads names from: the brand's fields, ideas, products and team, and the group it may start from. */
export interface ViewNames {
  fields: readonly RecordField[];
  launches?: ReadonlyArray<{ id: string; name: string }>;
  products?: ReadonlyArray<{ id: string; name: string }>;
  /** Team members by user id; without it a team member value is named by how many there are. */
  team?: ReadonlyArray<{ id: string; name: string }>;
  /** A product group the list was showing, with its name. */
  group?: { tag: string; label: string } | null;
  /** Product groups saved views filter on, by value (`<connectionId>:<entity id>`), named as a person's page names them. */
  groups?: ReadonlyArray<{ id: string; label: string }>;
  /** Launches are called ideas (useWords().ideas, isIdeaWordsEnabled()). */
  ideas?: boolean;
}

export function builtInFilterLabel(on: BuiltInFilter, ideas = false): string {
  const w = ideaWord(ideas);
  const labels: Record<BuiltInFilter, string> = {
    launch: w.One,
    via: "How they joined",
    launches_many: `In more than one ${w.one}`,
    product: "Product",
    stage: "Stage",
    quiet: "Quiet",
    group: "Product group",
    can_email: "Can email",
    last_active: "Last active",
    first_seen: "First seen",
    email_domain: "Email domain",
  };
  return labels[on];
}

const COLUMN_LABEL: Record<BuiltInColumn, string> = {
  person: "Person",
  where_from: "Where from",
  stage: "Stage",
  can_email: "Can email",
  last_active: "Last active",
  first_seen: "First seen",
};

const fieldOf = (names: ViewNames, id: string) => names.fields.find((f) => f.key === id) ?? null;

/** What a filter is on, by kind, or null for a field the list doesn't have. */
export function kindOf(on: string, fields: readonly RecordField[]): FilterKind | null {
  if (isBuiltInFilter(on)) return BUILT_IN_KIND[on];
  return fields.find((f) => f.key === on)?.type ?? null;
}

/** A filter's name: the field's label or the built in filter's. */
export function filterName(on: string, names: ViewNames): string {
  if (isBuiltInFilter(on)) return builtInFilterLabel(on, names.ideas);
  return fieldOf(names, on)?.label ?? "A field";
}

/** A column's name. */
export function columnName(id: string, names: ViewNames): string {
  if (isBuiltInColumn(id)) return COLUMN_LABEL[id];
  return fieldOf(names, id)?.label ?? "A field";
}

/** The comparisons as a filter row's menu shows them. */
export const OP_LABEL: Record<ViewOp, string> = {
  any_of: "is any of",
  all_of: "has all of",
  none_of: "is none of",
  is: "is",
  eq: "is",
  ne: "isn't",
  gt: "more than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  between: "between",
  on: "on",
  before: "before",
  after: "after",
  in_last: "in the last",
  in_next: "in the next",
  over_ago: "more than",
  contains: "contains",
  not_contains: "doesn't contain",
  equals: "is",
  not_equals: "isn't",
  empty: "is empty",
  not_empty: "isn't empty",
};

const STAGE_WORD: Record<string, string> = { new: "New", onboarding: "Onboarding", stuck: "Stuck", activated: "Activated", member: "Member" };

/** The options a filter picks from, each with its id and name. Archived options are named, marked. */
export function optionsFor(on: string, names: ViewNames): Array<{ id: string; label: string; archived?: boolean }> {
  const products = names.products ?? [];
  switch (on) {
    case "launch":
      return (names.launches ?? []).map((l) => ({ id: l.id, label: l.name }));
    case "via":
      return [
        { id: "form", label: "A sign up page or form" },
        { id: "site", label: "From your site" },
      ];
    case "product":
    case "quiet":
      return products.map((p) => ({ id: p.id, label: p.name }));
    case "stage":
      return products.flatMap((p) =>
        (["new", "onboarding", "stuck", "activated"] as const).map((s) => ({ id: `${p.id}:${s}`, label: products.length > 1 ? `${p.name}: ${STAGE_WORD[s]}` : STAGE_WORD[s]! })),
      );
    case "group": {
      const named = new Map((names.groups ?? []).map((g) => [g.id, g.label]));
      if (names.group) named.set(names.group.tag.replace(/^group:/, ""), names.group.label);
      return [...named].map(([id, label]) => ({ id, label }));
    }
  }
  const field = fieldOf(names, on);
  if (!field) return [];
  if (field.type === "team_member") return (names.team ?? []).map((m) => ({ id: m.id, label: m.name }));
  return (field.options ?? []).map((o) => ({ id: o.id, label: o.label, ...(o.archivedAt ? { archived: true } : {}) }));
}

/** One option's name, or a plain fallback when the brand no longer has it (or its name isn't known here). */
export function optionName(on: string, id: string, names: ViewNames): string {
  const found = optionsFor(on, names).find((o) => o.id === id);
  if (found) return found.label;
  if (on === "stage") {
    const [conn, stage] = id.split(":");
    const product = (names.products ?? []).find((p) => p.id === conn);
    return product && (names.products ?? []).length > 1 ? `${product.name}: ${STAGE_WORD[stage ?? ""] ?? stage}` : (STAGE_WORD[stage ?? ""] ?? "A stage");
  }
  if (on === "launch") return ideaWord(!!names.ideas).A;
  if (on === "product" || on === "quiet") return "A product";
  if (on === "group") {
    // A product group's value starts with its product's connection id.
    const product = (names.products ?? []).find((p) => id.startsWith(`${p.id}:`));
    return product ? `a group in ${product.name}` : "A product group";
  }
  if (fieldOf(names, on)?.type === "team_member") return FORMER_TEAM_MEMBER;
  return "An option";
}

/** "12 Nov 2026". */
export function dayWords(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** An amount in whole minor units with its currency: 482000 GBP is "£4,820.00". */
export function amountWords(minor: number, code: string | null | undefined): string {
  const digits = currencyDigits(code);
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: code || "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minor / 10 ** digits);
  } catch {
    return (minor / 10 ** digits).toFixed(digits);
  }
}

const list = (parts: string[]) => (parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`);
const both = (parts: string[]) => (parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

/** A filter as a sentence: "Customer type is Wholesale", "Last order in the last 60 days", "Can email is Yes". */
export function filterInWords(f: ViewFilter, names: ViewNames): string {
  const name = filterName(f.on, names);
  const field = isBuiltInFilter(f.on) ? null : fieldOf(names, f.on);
  const number = (n: number) => (field?.type === "currency" ? amountWords(n, field.currency) : n.toLocaleString("en-GB"));
  const team = field?.type === "team_member" && !names.team;
  const opts = () => {
    const ids = Array.isArray(f.value) ? (f.value as string[]) : [];
    if (team) return [`${ids.length === 1 ? "a team member" : `one of ${ids.length} team members`}`];
    return ids.map((id) => optionName(f.on, id, names));
  };
  switch (f.op) {
    case "any_of": {
      const o = opts();
      return `${name} is ${o.length > 1 ? `any of ${both(o)}` : o[0]}`;
    }
    case "all_of":
      return `${name} has all of ${both(opts())}`;
    case "none_of": {
      const o = opts();
      return `${name} ${o.length > 1 ? `is none of ${both(o)}` : `isn't ${o[0]}`}`;
    }
    case "is":
      return `${name} is ${f.value === true ? "Yes" : "No"}`;
    case "eq":
      return `${name} is ${number(f.value as number)}`;
    case "ne":
      return `${name} isn't ${number(f.value as number)}`;
    case "gt":
      return `${name} is more than ${number(f.value as number)}`;
    case "gte":
      return `${name} is at least ${number(f.value as number)}`;
    case "lt":
      return `${name} is less than ${number(f.value as number)}`;
    case "lte":
      return `${name} is at most ${number(f.value as number)}`;
    case "between": {
      const [a, b] = f.value as [number, number];
      return `${name} is between ${number(a)} and ${number(b)}`;
    }
    case "on":
      return `${name} is on ${dayWords(f.value as string)}`;
    case "before":
      return `${name} is before ${dayWords(f.value as string)}`;
    case "after":
      return `${name} is after ${dayWords(f.value as string)}`;
    case "in_last":
      return `${name} in the last ${f.value} ${f.value === 1 ? "day" : "days"}`;
    case "in_next":
      return `${name} in the next ${f.value} ${f.value === 1 ? "day" : "days"}`;
    case "over_ago":
      return `${name} more than ${f.value} ${f.value === 1 ? "day" : "days"} ago`;
    case "contains":
      return `${name} contains “${f.value}”`;
    case "not_contains":
      return `${name} doesn't contain “${f.value}”`;
    case "equals":
      return `${name} is “${f.value}”`;
    case "not_equals":
      return `${name} isn't “${f.value}”`;
    case "empty":
      return `${name} is empty`;
    case "not_empty":
      return `${name} isn't empty`;
  }
}

/** The filters as one sentence, joined as the view joins them. */
export function filtersInWords(filters: readonly ViewFilter[], match: "all" | "any", names: ViewNames): string {
  const parts = filters.map((f) => filterInWords(f, names));
  if (!parts.length) return "Everyone";
  return match === "any" ? list(parts) : both(parts);
}

/** Which way a column sorts, in words: "high to low", "A to Z", "latest first". */
export function sortDirWords(by: string, dir: "asc" | "desc", fields: readonly RecordField[]): string {
  const kind = isBuiltInColumn(by) ? by : (fields.find((f) => f.key === by)?.type ?? null);
  const asc = dir === "asc";
  switch (kind) {
    case "person":
    case "text":
      return asc ? "A to Z" : "Z to A";
    case "number":
    case "currency":
      return asc ? "low to high" : "high to low";
    case "last_active":
    case "first_seen":
      return asc ? "earliest first" : "latest first";
    // A date field may be ahead, such as the next visit: the soonest comes first.
    case "date":
      return asc ? "soonest first" : "latest first";
    case "checkbox":
    case "can_email":
      return asc ? "No first" : "Yes first";
    case "select":
    case "status":
      return asc ? "in their order" : "in reverse order";
    default:
      return asc ? "low to high" : "high to low";
  }
}

/** A sort in words: "Spend this year, high to low", or the list's own order. */
export function sortInWords(sort: ViewSort | null, names: ViewNames): string {
  if (!sort) return "Most recently active first";
  return `${columnName(sort.by, names)}, ${sortDirWords(sort.by, sort.dir, names.fields)}`;
}
