import { forTenant, type WhereClause } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Contact, PersonProductLink } from "@/lib/types/contact";
import { queryToken } from "@/lib/crm/searchTokens";
import { ENVIRONMENT_LABEL, environmentOf, productNameOf } from "@/lib/connect/environments";
import { loadPeopleConnections } from "./personSync";
import { ENTITY_ID_RE } from "@/lib/connect/v2/contract";
import { isFilterType, liveOptions, type FieldValue, type FieldType, type RecordField } from "@/lib/types/recordField";
import { CHECKED, fieldTag, parseFieldTag } from "./fieldTags";
import { readFieldList } from "./fieldList";

/**
 * Audience → People (AUDIENCE_ONE_VIEW_ENABLED): one list of everyone a brand knows,
 * from the person records. Firestore allows one array-contains a query, so the list
 * shows one group at a time (a `memberOf` tag: everyone, a launch, how they joined, a
 * product, or a stage in one product), optionally only those we can email. With
 * AUDIENCE_FIELD_FILTERS_ENABLED a group can also be a field value or a product group, through
 * the same tags and indexes. Search looks through everyone. Pages of 50, newest activity first,
 * with a real total.
 */

export const PEOPLE_PAGE = 50;

const ID = "[A-Za-z0-9_-]{1,128}";
const TAG = new RegExp(
  `^(all|launch:any|product:any|via:(form|site)|launch:${ID}|product:${ID}|quiet:${ID}|stage:${ID}:(new|onboarding|stuck|activated|member))$`,
);

/** Whether a string is a group the list can show. */
export function isPeopleTag(tag: string): boolean {
  return TAG.test(tag);
}

/** A product group: `group:<connectionId>:<the product's own entity id>`, which may hold `.` and `:`. */
const GROUP_TAG = new RegExp(`^group:(${ID}):(${ENTITY_ID_RE.source.replace(/^\^|\$$/g, "")})$`);

/** A product group's parts, or null. */
export function parseGroupTag(tag: string): { connectionId: string; entityId: string } | null {
  const m = GROUP_TAG.exec(tag);
  return m ? { connectionId: m[1]!, entityId: m[2]! } : null;
}

/**
 * Whether a string is a field value or a product group the list can show (with
 * AUDIENCE_FIELD_FILTERS_ENABLED): `field:<fieldId>:<optionId|yes>` or a group tag.
 */
export function isFilterTag(tag: string): boolean {
  return parseFieldTag(tag) !== null || parseGroupTag(tag) !== null;
}

/** Whether a string can be a page cursor (a sort key: `activeAt|id`). */
export function isPeopleCursor(cursor: string): boolean {
  const [at, id, ...rest] = cursor.split("|");
  return rest.length === 0 && !!at && !Number.isNaN(Date.parse(at)) && !!id && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

export interface PeopleQuery {
  /** The group to show (a memberOf tag); "all" for everyone. */
  tag: string;
  /** Only people we can email. */
  canEmail: boolean;
  /** Search everyone by name, address or domain; the group and can-email don't apply. */
  q: string;
  /** From the previous page: the last row's sort key. */
  cursor: string | null;
}

export interface PeopleRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  launches: Array<{ id: string; name: string; status: string; via: "form" | "site" }>;
  products: Array<{ id: string; name: string; stage: PersonProductLink["stage"]; quiet: boolean; lastActiveAt: string | null }>;
  reach: "yes" | "limited" | "no";
  /** A brand-wide opt-out: why nothing can be sent. */
  blocked: "unsubscribe" | "spam" | "hard_bounce" | null;
  activeAt: string | null;
  /** With field filters on: their values for the fields the list can filter by. */
  fields?: Record<string, FieldValue>;
}

/** Launch and product names by id, for the rows and the filters. */
async function sourceNames(ctx: TenantContext, db?: FirestoreLike) {
  const [campaigns, connections] = await Promise.all([forTenant(ctx, db).campaigns.find({ limit: 500 }), loadPeopleConnections(ctx, db)]);
  const launches = new Map(campaigns.map((c) => [c.id, c.waitlistName || "Untitled launch"]));
  const products = new Map(
    [...connections.values()].map((c) => {
      const env = environmentOf(c);
      return [c.id, `${productNameOf(c)}${env ? ` · ${ENVIRONMENT_LABEL[env]}` : ""}`];
    }),
  );
  return { launches, products };
}

function rowOf(c: Contact, names: Awaited<ReturnType<typeof sourceNames>>, fieldIds?: ReadonlySet<string>): PeopleRow {
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || null;
  return {
    id: c.id,
    name,
    email: c.email ?? null,
    phone: c.email ? null : (c.phone ?? null),
    launches: (c.campaigns ?? [])
      .filter((l) => l.status !== "deleted")
      .map((l) => ({ id: l.campaignId, name: names.launches.get(l.campaignId) ?? "A launch", status: l.status, via: l.joinedVia ?? "form" })),
    products: (c.products ?? []).map((p) => ({
      id: p.connectionId,
      name: names.products.get(p.connectionId) ?? "A product",
      stage: p.stage,
      quiet: p.quiet,
      lastActiveAt: p.lastActiveAt ?? null,
    })),
    reach: c.reach ?? "no",
    blocked: c.optOuts?.blocked ?? null,
    activeAt: c.activeAt ?? null,
    ...(fieldIds ? { fields: Object.fromEntries(Object.entries(c.fields ?? {}).filter(([id]) => fieldIds.has(id))) } : {}),
  };
}

function whereOf(q: PeopleQuery): WhereClause[] {
  const token = q.q ? queryToken(q.q) : "";
  if (token) return [["searchTokens", "array-contains", token]];
  return [["memberOf", "array-contains", q.tag], ...(q.canEmail ? ([["reach", "==", "yes"]] as WhereClause[]) : [])];
}

/** One page of the list, and the total on the first page. */
export async function listPeople(
  ctx: TenantContext,
  q: PeopleQuery,
  db?: FirestoreLike,
  opts: { fieldIds?: ReadonlySet<string> } = {},
): Promise<{ people: PeopleRow[]; nextCursor: string | null; total: number | null }> {
  const repo = forTenant(ctx, db);
  const where = whereOf(q);
  const [rows, total, names] = await Promise.all([
    repo.contacts.find({ where, orderBy: [["sortKey", "desc"]], limit: PEOPLE_PAGE + 1, ...(q.cursor ? { startAfter: [q.cursor] } : {}) }),
    q.cursor ? Promise.resolve(null) : repo.contacts.count(where),
    sourceNames(ctx, db),
  ]);
  const page = rows.slice(0, PEOPLE_PAGE);
  const nextCursor = rows.length > PEOPLE_PAGE ? (page[page.length - 1]!.sortKey ?? null) : null;
  return { people: page.map((c) => rowOf(c, names, opts.fieldIds)), nextCursor, total };
}

/** A field the list can filter by, with its options in use (a ticked checkbox is the option "yes"). Counted on demand. */
export interface FilterField {
  id: string;
  label: string;
  type: FieldType;
  options: Array<{ id: string; label: string }>;
}

/** The People fields in use the list can filter by: select, multi select, status and checkbox. */
export function filterFields(items: readonly RecordField[]): FilterField[] {
  return items
    .filter((f) => !f.archivedAt && isFilterType(f.type))
    .map((f) => ({
      id: f.key,
      label: f.label,
      type: f.type,
      options: f.type === "checkbox" ? [{ id: CHECKED, label: "Yes" }] : liveOptions(f).map((o) => ({ id: o.id, label: o.label })),
    }));
}

export interface PeopleFilters {
  /** With field filters on: the fields the list can filter by, without counts. */
  fields?: FilterField[];
  everyone: number;
  canEmail: number;
  via: { form: number; site: number };
  launches: Array<{ id: string; name: string; count: number }>;
  products: Array<{ id: string; name: string; count: number; stages: Record<"new" | "onboarding" | "stuck" | "activated" | "quiet", number> }>;
}

const STAGES = ["new", "onboarding", "stuck", "activated"] as const;

/** The groups this brand's list can show, each with how many people are in it, and with `fields` the fields it can filter by. */
export async function peopleFilters(ctx: TenantContext, db?: FirestoreLike, opts: { fields?: boolean } = {}): Promise<PeopleFilters> {
  const repo = forTenant(ctx, db);
  const names = await sourceNames(ctx, db);
  const count = (tag: string, canEmail = false) => repo.contacts.count(whereOf({ tag, canEmail, q: "", cursor: null }));
  const [everyone, canEmail, form, site, launches, products, fieldList] = await Promise.all([
    count("all"),
    count("all", true),
    count("via:form"),
    count("via:site"),
    Promise.all([...names.launches].map(async ([id, name]) => ({ id, name, count: await count(`launch:${id}`) }))),
    Promise.all(
      [...names.products].map(async ([id, name]) => {
        const [total, quiet, ...stages] = await Promise.all([count(`product:${id}`), count(`quiet:${id}`), ...STAGES.map((s) => count(`stage:${id}:${s}`))]);
        return {
          id,
          name,
          count: total,
          stages: { ...(Object.fromEntries(STAGES.map((s, i) => [s, stages[i]!])) as Record<(typeof STAGES)[number], number>), quiet },
        };
      }),
    ),
    opts.fields ? readFieldList(ctx, "person", db) : Promise.resolve(null),
  ]);
  return { ...(fieldList ? { fields: filterFields(fieldList.items) } : {}), everyone, canEmail, via: { form, site }, launches, products };
}

/**
 * How many people have each option of one field, counted when its menu opens so a page load
 * never runs one count per option. Null for a field the list can't filter by.
 */
export async function fieldOptionCounts(ctx: TenantContext, fieldId: string, db?: FirestoreLike): Promise<Record<string, number> | null> {
  const list = await readFieldList(ctx, "person", db);
  const field = filterFields(list.items).find((f) => f.id === fieldId);
  if (!field) return null;
  const repo = forTenant(ctx, db);
  const counts = await Promise.all(field.options.map((o) => repo.contacts.count([["memberOf", "array-contains", fieldTag(field.id, o.id)]])));
  return Object.fromEntries(field.options.map((o, i) => [o.id, counts[i]!]));
}

/** The fields the list shows values for: those it can filter by. */
export async function filterFieldIds(ctx: TenantContext, db?: FirestoreLike): Promise<Set<string>> {
  return new Set(filterFields((await readFieldList(ctx, "person", db)).items).map((f) => f.id));
}
