import { rowOf, sourceNames, type PeopleRow } from "@/lib/audience/peopleList";
import { queryToken } from "@/lib/crm/searchTokens";
import { forTenant, type TenantContext, type WhereClause } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { RecordField } from "@/lib/types/recordField";
import type { ViewBackend, ViewRunInput, ViewRunResult, ViewStart } from "./backend";
import { columnKind, isSortable, startTags } from "./conditions";
import { applicableFilters, evaluateView, type ViewPerson } from "./evaluate";
import { isBuiltInColumn, isBuiltInFilter, VIEW_LIMITS, type ViewDefinition } from "./types";

/**
 * Reading people for a view, in memory (piece C, CRM_VIEWS_ENABLED). Every read goes through
 * forTenant(ctx) and an index firestore.indexes.json already has:
 *
 * - a "match all" view starts from its smallest group (an idea, how they joined, more than one
 *   idea, a product, a stage, quiet, a product group, a select or status option, a ticked box),
 *   found with one count() per candidate, (tenantId, memberOf CONTAINS); otherwise from Everyone;
 * - it reads that group newest first in pages of 1,000, up to 5,000, by (tenantId, memberOf
 *   CONTAINS, sortKey DESC), with a projection of only the list's order and tags, reach and the
 *   fields the filters and sort use, and returns the group's real total and whether it was capped;
 * - with words in the search box it reads that search's people instead, by (tenantId, searchTokens
 *   CONTAINS, sortKey DESC), up to 5,000, and applies everything else in memory, Everyone included.
 *
 * At most 2 runs at a time per instance; another is refused as busy. A field tag dropped past
 * MAX_FIELD_TAGS (50 a person) is missed by a view that starts from it, as the field filter misses it.
 */

/** People read a page. */
export const READ_PAGE = 1000;
/** Runs at once per instance. */
export const MAX_RUNS = 2;

let running = 0;

/** One of this instance's run slots, or null when MAX_RUNS are running. Call the answer once done. */
export function takeRunSlot(): (() => void) | null {
  if (running >= MAX_RUNS) return null;
  running += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    running -= 1;
  };
}

/** A field value's path for a projection: read only (src/lib/tenant/recordFieldWrites.ts is the one writer). */
const valuePath = (fieldId: string) => ["fields", fieldId].join(".");

/** The fields a run reads of each person: the list's order and tags, reach, and what the filters and sort use. */
export function fieldsToRead(def: ViewDefinition, fields: readonly RecordField[]): string[] {
  const out = new Set(["sortKey", "memberOf", "reach"]);
  for (const { filter } of applicableFilters(def, fields).active) {
    if (!isBuiltInFilter(filter.on)) out.add(valuePath(filter.on));
    else if (filter.on === "last_active") out.add("activeAt");
    else if (filter.on === "first_seen") out.add("firstSeenAt");
    else if (filter.on === "email_domain") out.add("emailDomain");
  }
  const by = def.sort && isSortable(columnKind(def.sort.by, fields)) ? def.sort.by : null;
  if (by === "person") for (const f of ["firstName", "lastName", "email"]) out.add(f);
  else if (by === "last_active") out.add("activeAt");
  else if (by === "first_seen") out.add("firstSeenAt");
  else if (by && !isBuiltInColumn(by)) out.add(valuePath(by));
  return [...out];
}

const memberOf = (tag: string): WhereClause[] => [["memberOf", "array-contains", tag]];

/** Where a run starts, with that group's total. */
async function chooseStart(
  ctx: TenantContext,
  input: ViewRunInput,
  db?: FirestoreLike,
): Promise<{ where: WhereClause[]; total: number; start: ViewStart }> {
  const repo = forTenant(ctx, db);
  const token = input.q ? queryToken(input.q) : "";
  if (token) {
    const where: WhereClause[] = [["searchTokens", "array-contains", token]];
    return { where, total: await repo.contacts.count(where), start: { kind: "search" } };
  }
  const candidates =
    input.definition.match === "all" ? [...new Set(applicableFilters(input.definition, input.fields).active.flatMap((a) => startTags(a.filter, a.field)))] : [];
  if (candidates.length) {
    const counts = await Promise.all(candidates.map((tag) => repo.contacts.count(memberOf(tag))));
    let best = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i]! < counts[best]!) best = i;
    const tag = candidates[best]!;
    return { where: memberOf(tag), total: counts[best]!, start: { kind: "group", tag } };
  }
  return { where: memberOf("all"), total: await repo.contacts.count(memberOf("all")), start: { kind: "everyone" } };
}

/** Run a view in memory, or refuse it as busy. */
export async function runViewInMemory(ctx: TenantContext, input: ViewRunInput, db?: FirestoreLike): Promise<ViewRunResult> {
  const release = takeRunSlot();
  if (!release) return { ok: false, error: "views_busy" };
  try {
    const { where, total, start } = await chooseStart(ctx, input, db);
    const select = fieldsToRead(input.definition, input.fields);
    const contacts = forTenant(ctx, db).contacts;
    const people: ViewPerson[] = [];
    let cursor: string | null = null;
    while (people.length < VIEW_LIMITS.readCap) {
      const limit = Math.min(READ_PAGE, VIEW_LIMITS.readCap - people.length);
      const page = (await contacts.find({
        where,
        orderBy: [["sortKey", "desc"]],
        limit,
        select,
        ...(cursor ? { startAfter: [cursor] } : {}),
      })) as unknown as ViewPerson[];
      people.push(...page);
      if (page.length < limit) break;
      cursor = page[page.length - 1]!.sortKey ?? null;
      if (!cursor) break;
    }
    const evaluation = evaluateView(people, input.definition, { fields: input.fields, timeZone: input.timeZone, now: input.now ?? new Date() });
    return {
      ok: true,
      run: { ...evaluation, total, capped: total > VIEW_LIMITS.readCap, start },
    };
  } finally {
    release();
  }
}

export const memoryBackend: ViewBackend = { run: runViewInMemory };

/** A row of a view: the People list's row, with when they were first seen. */
export interface ViewRow extends PeopleRow {
  firstSeenAt: string | null;
}

const ROW_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Up to 50 people by id as rows, with their values for the view's field columns in use, in the
 * order asked. Changing columns reads rows again, never runs the view again. Someone erased, or no
 * longer in Everyone, since the run is left out; ids from another brand read as nobody.
 */
export async function readViewRows(
  ctx: TenantContext,
  ids: readonly string[],
  columns: readonly string[],
  fields: readonly RecordField[],
  db?: FirestoreLike,
): Promise<ViewRow[]> {
  const wanted = [...new Set(ids.filter((id) => ROW_ID.test(id)))].slice(0, VIEW_LIMITS.page);
  if (!wanted.length) return [];
  const contacts = forTenant(ctx, db).contacts;
  const [docs, names] = await Promise.all([Promise.all(wanted.map((id) => contacts.getById(id))), sourceNames(ctx, db)]);
  const fieldIds = new Set(columns.filter((c) => !isBuiltInColumn(c) && columnKind(c, fields) !== null));
  return docs.flatMap((c) => (c && (c.memberOf ?? []).includes("all") ? [{ ...rowOf(c, names, fieldIds), firstSeenAt: c.firstSeenAt ?? null }] : []));
}
