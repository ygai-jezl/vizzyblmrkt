import { forTenant, type WhereClause } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Contact, PersonProductLink } from "@/lib/types/contact";
import { queryToken } from "@/lib/crm/searchTokens";
import { ENVIRONMENT_LABEL, environmentOf, productNameOf } from "@/lib/connect/environments";
import { loadPeopleConnections } from "./personSync";

/**
 * Audience → People (AUDIENCE_ONE_VIEW_ENABLED): one list of everyone a brand knows,
 * from the person records. Firestore allows one array-contains a query, so the list
 * shows one group at a time (a `memberOf` tag: everyone, a launch, how they joined, a
 * product, or a stage in one product), optionally only those we can email. Search
 * looks through everyone. Pages of 50, newest activity first, with a real total.
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

export interface PeopleQuery {
  /** The group to show (a memberOf tag); "all" for everyone. */
  tag: string;
  /** Only people we can email. */
  canEmail: boolean;
  /** Search everyone by name, address or domain; the group and can-email don't apply. */
  q: string;
  /** From the previous page. */
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

function rowOf(c: Contact, names: Awaited<ReturnType<typeof sourceNames>>): PeopleRow {
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
): Promise<{ people: PeopleRow[]; nextCursor: string | null; total: number | null }> {
  const repo = forTenant(ctx, db);
  const where = whereOf(q);
  const [rows, total, names] = await Promise.all([
    repo.contacts.find({ where, orderBy: [["activeAt", "desc"]], limit: PEOPLE_PAGE, ...(q.cursor ? { startAfter: [q.cursor] } : {}) }),
    q.cursor ? Promise.resolve(null) : repo.contacts.count(where),
    sourceNames(ctx, db),
  ]);
  // A full page holds back its trailing people who share the last activity time, so the next
  // page (which starts after the cursor) has all of them.
  let page = rows;
  let nextCursor: string | null = null;
  if (rows.length === PEOPLE_PAGE) {
    const last = rows[rows.length - 1]!.activeAt;
    const keep = rows.filter((r) => r.activeAt !== last);
    page = keep.length ? keep : rows;
    nextCursor = page[page.length - 1]!.activeAt ?? null;
  }
  return { people: page.map((c) => rowOf(c, names)), nextCursor, total };
}

export interface PeopleFilters {
  everyone: number;
  canEmail: number;
  via: { form: number; site: number };
  launches: Array<{ id: string; name: string; count: number }>;
  products: Array<{ id: string; name: string; count: number; stages: Record<"new" | "onboarding" | "stuck" | "activated" | "quiet", number> }>;
}

const STAGES = ["new", "onboarding", "stuck", "activated"] as const;

/** The groups this brand's list can show, each with how many people are in it. */
export async function peopleFilters(ctx: TenantContext, db?: FirestoreLike): Promise<PeopleFilters> {
  const repo = forTenant(ctx, db);
  const names = await sourceNames(ctx, db);
  const count = (tag: string, canEmail = false) => repo.contacts.count(whereOf({ tag, canEmail, q: "", cursor: null }));
  const [everyone, canEmail, form, site, launches, products] = await Promise.all([
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
  ]);
  return { everyone, canEmail, via: { form, site }, launches, products };
}
