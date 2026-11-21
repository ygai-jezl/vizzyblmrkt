import { forTenant, moveRecordFieldValues, repointHistoryPage, type HistoryStore } from "@/lib/tenant";
import { personIdOf, personKeyOf, syncPersonSafe } from "@/lib/audience/personSync";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { EmailJob } from "@/lib/types/emailJob";
import { isOntologyPersonIdsEnabled } from "./flags";
import { isContactPersonId, type ContactPersonId } from "./person";
import { personIdForProductUser } from "./personRef";

/**
 * The person_repoint job (ONTOLOGY_PERSON_IDS_ENABLED): brings one product user's rows to the
 * person they belong to now, after a move (./moves.ts). Self correcting: it works out the person
 * when it runs, so the newest one always wins whatever order jobs run in, and it checks again
 * before each page and at the end.
 *
 * It works in slices (20 seconds by default, well under the delivery lease) with a cursor saved on
 * the job, and answers "again" to be put back in the queue; the next run resumes from the cursor
 * while the person is still the same. When it is done it marks the user's pending moves done and
 * answers "drop", so the job is deleted and no id outlives the work. When the user can no longer
 * be a person (erased, gone, or their product revoked or missing) it marks their pending moves
 * dropped and answers "drop", so the lifecycle tick stops queueing them. Switch off: "drop",
 * writing nothing.
 *
 * After the five stores it walks the event history and agent actions (by the repository keys in
 * HISTORY_STORES, never a collection name): first their rows naming the product user, then, for
 * each pending move of theirs that was a merge (a pu: person never comes back once the user has
 * an address) or whose from-person's record is gone, every row filed under that person.
 *
 * Before the walk, the team's field values follow them: from each person their pending moves left
 * behind onto the person they are now, through the one field writer (moveRecordFieldValues), and
 * a record that leaves empty is synced again, so one nothing else keeps goes as it would have
 * without values and its history follows in the walk. Running it again moves nothing twice.
 *
 * A sync a product write couldn't make is made here first: the record left behind still looks
 * like someone in People while it owes one, and the new record may not exist yet. Values that
 * still didn't move (a failed write, or a sync that failed again) keep their record's history
 * with them, and the job answers "again" with its moves still pending, up to MAX_VALUE_TRIES runs
 * in all; after that it settles them and logs that values were left behind.
 */

/** The stores a product user's person is written on, in the order the job walks them. */
export const REPOINT_STORES = [
  { store: "productEvents", field: "productUserId" },
  { store: "lifecycleEnrolments", field: "productUserId" },
  { store: "personPlans", field: "productUserId" },
  { store: "emailSends", field: "signupId" },
  { store: "emailEvents", field: "signupId" },
] as const;
type StoreName = (typeof REPOINT_STORES)[number]["store"];

/** The history stores, by their repository keys, walked after the five. */
export const HISTORY_STORES = ["ontologyEvents", "agentActions"] as const satisfies readonly HistoryStore[];

/** One store's walk: by the product user, or a history store by the person rows were filed under. */
type Step =
  | { kind: "rows"; store: StoreName; field: (typeof REPOINT_STORES)[number]["field"] }
  | { kind: "history"; store: HistoryStore; from: ContactPersonId | null };

export interface RepointCursor {
  store: StoreName | HistoryStore;
  /** The last document id done in that store, or null to start it. */
  after: string | null;
  /** The person the cursor was saved for: a cursor for anyone else is thrown away. */
  target: ContactPersonId;
  /** For a history store walked by a person: the person the rows were filed under. */
  from?: ContactPersonId;
}

export interface RepointDeps {
  now?: () => number;
  sliceMs?: number;
  pageSize?: number;
}

const DEFAULT_SLICE_MS = 20_000;
const DEFAULT_PAGE = 300;
/** The runs one job tries to move field values that didn't move, before it settles its moves anyway. */
export const MAX_VALUE_TRIES = 5;

/** The runs so far that left field values behind, saved on the job. */
function valueTriesOf(payload: Record<string, unknown>): number {
  const n = payload.valueTries;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
}

function cursorOf(payload: Record<string, unknown>): RepointCursor | null {
  const c = payload.cursor as Partial<RepointCursor> | undefined;
  if (!c || typeof c !== "object") return null;
  if (!REPOINT_STORES.some((s) => s.store === c.store) && !(HISTORY_STORES as readonly string[]).includes(c.store as string)) return null;
  if (typeof c.target !== "string") return null;
  return {
    store: c.store as StoreName | HistoryStore,
    after: typeof c.after === "string" ? c.after : null,
    target: c.target as ContactPersonId,
    ...(isContactPersonId(c.from) ? { from: c.from } : {}),
  };
}

const sameStep = (step: Step, c: RepointCursor) => step.store === c.store && (step.kind === "rows" ? !c.from : (step.from ?? undefined) === c.from);

export async function processPersonRepointJob(
  ctx: TenantContext,
  job: EmailJob,
  db?: FirestoreLike,
  deps: RepointDeps = {},
): Promise<"drop" | "again"> {
  if (!isOntologyPersonIdsEnabled()) return "drop";
  const productUserId = typeof job.payload.productUserId === "string" ? job.payload.productUserId : "";
  if (!productUserId) return "drop";
  const now = deps.now ?? Date.now;
  const sliceMs = deps.sliceMs ?? DEFAULT_SLICE_MS;
  const pageSize = deps.pageSize ?? DEFAULT_PAGE;
  const started = now();
  const repo = forTenant(ctx, db);

  /**
   * Settle every pending move of theirs: done once their rows are with their person, dropped when
   * they can't be (they are no longer a person). Either way the tick stops queueing the job again.
   */
  const settleMoves = async (to: "done" | "dropped"): Promise<"drop"> => {
    let cursor: string | null = null;
    for (;;) {
      const page = await repo.personMoves.updateWhere(
        [
          ["productUserId", "==", productUserId],
          ["repoint", "==", "pending"],
        ],
        () => ({ repoint: to }),
        { startAfter: cursor, limit: pageSize },
      );
      cursor = page.last;
      if (!page.more) break;
    }
    return "drop";
  };

  const user0 = await repo.productUsers.getById(productUserId);
  if (!user0 || user0.status !== "active") return settleMoves("dropped");
  const connection = await repo.productConnections.getById(user0.connectionId);
  /** Their person now, or null when they're gone or no longer a person (a revoked product). */
  const currentTarget = async (): Promise<ContactPersonId | null> => {
    const user = await repo.productUsers.getById(productUserId);
    return user ? personIdForProductUser(ctx.tenantId, user, connection) : null;
  };
  let target = personIdForProductUser(ctx.tenantId, user0, connection);
  if (!target) return settleMoves("dropped");
  /** The people whose field values didn't leave in this run's walk: tried again on the next run. */
  let unsettled = new Set<ContactPersonId>();

  /**
   * The walk for a target: the five stores, the history stores by the product user, then the
   * history stores by each person their pending moves left behind for good: a merge's pu: person,
   * or a from-person whose record is gone. Sorted, so a saved cursor finds its place again.
   */
  const stepsFor = async (to: ContactPersonId): Promise<Step[]> => {
    const steps: Step[] = [
      ...REPOINT_STORES.map((s): Step => ({ kind: "rows", store: s.store, field: s.field })),
      ...HISTORY_STORES.map((store): Step => ({ kind: "history", store, from: null })),
    ];
    const pending = await repo.personMoves.find({
      where: [
        ["productUserId", "==", productUserId],
        ["repoint", "==", "pending"],
      ],
      limit: 100,
    });
    // Their field values first: a record they leave empty may go, and then its history follows below.
    unsettled = await moveFieldValues(pending, to);
    const froms = new Set<ContactPersonId>();
    for (const m of pending) {
      if (!isContactPersonId(m.fromPersonId) || m.fromPersonId === to || froms.has(m.fromPersonId)) continue;
      // Values that didn't move keep their record's history with them until they do.
      if (unsettled.has(m.fromPersonId)) continue;
      if (m.kind === "record.merged" || !(await repo.contacts.getById(m.fromPersonId))) froms.add(m.fromPersonId);
    }
    for (const from of [...froms].sort()) for (const store of HISTORY_STORES) steps.push({ kind: "history", store, from });
    return steps;
  };

  /**
   * Field values from each person their pending moves left behind, onto `to`. Never throws: it
   * answers the people whose values didn't move and should have.
   */
  async function moveFieldValues(pending: ReadonlyArray<{ fromPersonId: string }>, to: ContactPersonId): Promise<Set<ContactPersonId>> {
    const froms = [...new Set(pending.map((m) => m.fromPersonId))].filter((f): f is ContactPersonId => isContactPersonId(f) && f !== to).sort();
    // The run's start, so the slice clock isn't spent here.
    const at = new Date(started).toISOString();
    const left = new Set<ContactPersonId>();
    for (const from of froms) {
      try {
        if (!(await moveFieldValuesFrom(from, to, at))) left.add(from);
      } catch (err) {
        left.add(from);
        console.warn(`[ontology] moving field values failed tenant=${ctx.tenantId}:`, err instanceof Error ? err.message.slice(0, 120) : "error");
      }
    }
    return left;
  }

  /**
   * One person's values onto `to`. True once they are settled: moved, nothing to move, or kept by
   * design (the new record's own value, too large, or a record that is still someone in People).
   */
  async function moveFieldValuesFrom(from: ContactPersonId, to: ContactPersonId, at: string): Promise<boolean> {
    let r = await moveRecordFieldValues(ctx, { from, to, nowIso: at }, { db });
    if (r.outcome === "skipped" && (r.reason === "no_target" || r.owesSync)) {
      // A sync a product write couldn't make: make it now, then try once more.
      const key = r.reason === "no_target" ? await keyOfTarget(to) : r.fromKey;
      if (key) await syncPersonSafe(ctx, key, { db, nowMs: started });
      r = await moveRecordFieldValues(ctx, { from, to, nowIso: at }, { db });
    }
    // Codes and counts only: never a value, an address or an id.
    if (r.tooLarge.length) console.warn(`[ontology] move_field_values_too_large tenant=${ctx.tenantId} count=${r.tooLarge.length}`);
    if (r.outcome === "moved" && r.emptied) await syncPersonSafe(ctx, r.fromKey, { db, nowMs: started });
    if (r.outcome !== "skipped" || (r.reason === "still_a_person" && !r.owesSync)) return true;
    console.warn(`[ontology] move_field_values_${r.reason === "no_target" ? "no_target" : "sync_owed"} tenant=${ctx.tenantId}`);
    return false;
  }

  /** The person key behind `to` while it is still the product user's person, so its record can be synced. */
  async function keyOfTarget(to: ContactPersonId): Promise<string | null> {
    const user = await repo.productUsers.getById(productUserId);
    if (!user) return null;
    const key = personKeyOf(user);
    return personIdOf(ctx.tenantId, key) === to ? key : null;
  }

  let steps = await stepsFor(target);
  const saved = cursorOf(job.payload);
  let index = 0;
  let after: string | null = null;
  if (saved && saved.target === target) {
    const at = steps.findIndex((step) => sameStep(step, saved));
    if (at >= 0) {
      index = at;
      after = saved.after;
    }
  }

  for (;;) {
    if (index >= steps.length) {
      // The end: if they moved again meanwhile, start over for the new person.
      const fresh = await currentTarget();
      if (!fresh) return settleMoves("dropped");
      if (fresh !== target) {
        target = fresh;
        steps = await stepsFor(target);
        index = 0;
        after = null;
        continue;
      }
      if (unsettled.size) {
        // Field values that should have moved didn't: go again, from the history stores (the five are
        // done for this person), with the moves still pending, a bounded number of times.
        const tries = valueTriesOf(job.payload) + 1;
        if (tries < MAX_VALUE_TRIES) {
          const cursor: RepointCursor = { store: HISTORY_STORES[0], after: null, target };
          await repo.emailJobs.update(job.id, { payload: { ...job.payload, cursor, valueTries: tries } });
          return "again";
        }
        console.warn(`[ontology] move_field_values_left_behind tenant=${ctx.tenantId} count=${unsettled.size}`);
      }
      // Every pending move of theirs is now carried out.
      return settleMoves("done");
    }
    if (now() - started >= sliceMs) {
      const step = steps[index]!;
      const cursor: RepointCursor = { store: step.store, after, target, ...(step.kind === "history" && step.from ? { from: step.from } : {}) };
      await repo.emailJobs.update(job.id, { payload: { ...job.payload, cursor } });
      return "again";
    }
    // Before each page: still the same person? If not, the newest one wins and the walk starts over.
    const fresh = await currentTarget();
    if (!fresh) return settleMoves("dropped");
    if (fresh !== target) {
      target = fresh;
      steps = await stepsFor(target);
      index = 0;
      after = null;
      continue;
    }
    const step = steps[index]!;
    const to = target;
    const page =
      step.kind === "rows"
        ? await (repo[step.store] as unknown as RepointCollection).updateWhere(
            [[step.field, "==", productUserId]],
            (row) => (row.personId === to ? null : { personId: to }),
            { startAfter: after, limit: pageSize },
          )
        : await repointHistoryPage(
            ctx,
            { store: step.store, by: step.from ? { personId: step.from } : { productUserId }, target: to },
            { after, limit: pageSize, db },
          );
    if (page.more) after = page.last;
    else {
      index += 1;
      after = null;
    }
  }
}

/** The part of each store's TenantCollection the walk uses: they differ only in their row type. */
interface RepointCollection {
  updateWhere(
    where: Array<[string, "==", unknown]>,
    plan: (row: { personId?: string }) => { personId: ContactPersonId } | null,
    opts: { startAfter?: string | null; limit: number },
  ): Promise<{ last: string | null; more: boolean }>;
}
