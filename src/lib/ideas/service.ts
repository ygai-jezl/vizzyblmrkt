import { z } from "zod";
import { forTenant, setLaunchArchived, TenantIsolationError, writeRecordWithEvents, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { actorOf, SUBJECT_ID, systemFieldId } from "@/lib/ontology/events";
import { fieldChangedEvent } from "@/lib/ontology/eventBuilders";
import { IDEA_LIMITS, IdeaStatusSchema, type Campaign, type Idea, type IdeaStatus } from "@/lib/types/campaign";
import type { EventWrite } from "@/lib/types/ontologyEvent";

/**
 * Change a launch's idea (LAUNCH_IDEAS_ENABLED): its hypothesis, status, outcome, hand-off and
 * Just a list. One transaction through writeRecordWithEvents, so a status change and a hand-off
 * commit with their record.field_changed events (`sys.idea.status` and `sys.idea.product` on
 * `idea:<campaignId>`). Hypothesis and outcome edits are not events: free text with no reader of
 * its history yet.
 *
 * Closing the waitlist (only with the idea parked or killed) runs after the commit, so a close
 * that fails never undoes the status: the result says whether it closed. Ticking or unticking Just a
 * list records, in the same commit, that the launch's people are owed a sync (`peopleResync`), so
 * "in more than one launch" follows it: the lifecycle tick flags the ones whose tag can change, a
 * page at a time (src/lib/ideas/people.ts), so a list of thousands never holds up the save.
 */

/** What a change may set. Strict, so a typo is a 400 and never a stray field on the launch. */
export const IdeaChangeSchema = z
  .object({
    hypothesis: z.string().trim().max(IDEA_LIMITS.hypothesis).nullable().optional(),
    outcome: z.string().trim().max(IDEA_LIMITS.outcome).nullable().optional(),
    status: IdeaStatusSchema.optional(),
    /** The connected product it became; only while the idea is, or becomes, launched. */
    productConnectionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
    justAList: z.boolean().optional(),
    /** Also close the waitlist; only while the idea is, or becomes, parked or killed. */
    closeWaitlist: z.literal(true).optional(),
  })
  .strict()
  .refine((c) => Object.keys(c).length > 0, { message: "nothing to change" });
export type IdeaChange = z.infer<typeof IdeaChangeSchema>;

/** The statuses that offer to close the waitlist. */
export const CLOSING_STATUSES: readonly IdeaStatus[] = ["parked", "killed"];

export type SetIdeaError = "invalid_id" | "not_found" | "product_not_found" | "not_launched" | "not_parked_or_killed";

export type SetIdeaResult =
  | {
      ok: true;
      idea: Idea;
      /** Whether anything was written. */
      changed: boolean;
      /** Asked to close the waitlist: whether it is closed now. Null when not asked. */
      archived: boolean | null;
    }
  | { ok: false; status: 400 | 404; error: SetIdeaError };

export interface SetIdeaDeps {
  db?: FirestoreLike;
  nowIso?: string;
  /** Closes the waitlist; tests pass their own (the real one writes the audit bucket). */
  archive?: (ctx: TenantContext, campaignId: string) => Promise<unknown>;
}

const STATUS_FIELD = systemFieldId("idea", "status");
const PRODUCT_FIELD = systemFieldId("idea", "product");

/** Blank text is no text: stored as null, never "". */
const textOf = (v: string | null | undefined): string | null => (v ? v : null);

/** A member's user id for the record, never an address. */
const userOf = (ctx: TenantContext): string | null => (ctx.userId && !ctx.userId.includes("@") ? ctx.userId : null);

const REJECTIONS: Record<string, { status: 400 | 404; error: SetIdeaError }> = {
  not_found: { status: 404, error: "not_found" },
  not_launched: { status: 400, error: "not_launched" },
  not_parked_or_killed: { status: 400, error: "not_parked_or_killed" },
};

/** The idea a change leads to, the events it writes, or why it can't happen. Pure: a transaction may run it twice. */
export function planIdea(
  current: Campaign,
  change: IdeaChange,
  who: { userId: string | null; actor: ReturnType<typeof actorOf>; nowIso: string },
): { idea: Idea; events: EventWrite[]; changed: boolean } | { reject: keyof typeof REJECTIONS } {
  const was: Idea = current.idea ?? {};
  const next: Idea = { ...was };
  const events: EventWrite[] = [];
  const subject = { type: "idea" as const, id: current.id };
  const event = (fieldId: string, before: unknown, after: unknown) =>
    fieldChangedEvent({ subject, personId: null, fieldId, object: "idea", before, after, source: "editor", actor: who.actor, at: who.nowIso });

  if (change.hypothesis !== undefined) next.hypothesis = textOf(change.hypothesis);
  if (change.outcome !== undefined) next.outcome = textOf(change.outcome);
  if (change.justAList !== undefined) next.justAList = change.justAList;
  if (change.status !== undefined && change.status !== was.status) {
    next.status = change.status;
    next.statusAt = who.nowIso;
    next.statusBy = who.userId;
    events.push(event(STATUS_FIELD, was.status ?? null, change.status));
  }
  if (change.productConnectionId !== undefined) {
    if (next.status !== "launched") return { reject: "not_launched" };
    if (change.productConnectionId !== was.productConnectionId) {
      next.productConnectionId = change.productConnectionId;
      next.handedOffAt = who.nowIso;
      next.handedOffBy = who.userId;
      events.push(event(PRODUCT_FIELD, was.productConnectionId ?? null, change.productConnectionId));
    }
  }
  if (change.closeWaitlist && !CLOSING_STATUSES.includes(next.status as IdeaStatus)) return { reject: "not_parked_or_killed" };

  const changed = (Object.keys(next) as Array<keyof Idea>).some((k) => next[k] !== was[k]);
  return { idea: next, events, changed };
}

/** Change one launch's idea. Another brand's launch, or none, is not found. */
export async function setIdea(ctx: TenantContext, campaignId: string, change: IdeaChange, deps: SetIdeaDeps = {}): Promise<SetIdeaResult> {
  // The id names the idea's events, so it must fit their subject id.
  if (!SUBJECT_ID.test(campaignId)) return { ok: false, status: 400, error: "invalid_id" };
  if (change.productConnectionId !== undefined) {
    const product = await forTenant(ctx, deps.db).productConnections.getById(change.productConnectionId);
    if (!product || product.status === "revoked") return { ok: false, status: 400, error: "product_not_found" };
  }
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const actor = actorOf(ctx);
  const who = { userId: userOf(ctx), actor: actor.id?.includes("@") ? { ...actor, id: null } : actor, nowIso };

  let written;
  try {
    written = await writeRecordWithEvents(
      ctx,
      "campaigns",
      campaignId,
      (current) => {
        if (!current) return { reject: "not_found" };
        const planned = planIdea(current, change, who);
        if ("reject" in planned) return { reject: planned.reject };
        if (!planned.changed) return null;
        // Just a list moved: its people are owed a sync, from the first page again.
        const listMoved = !!planned.idea.justAList !== !!current.idea?.justAList;
        const resync = listMoved ? { peopleResync: { owed: true as const, since: nowIso, cursor: null } } : {};
        return { patch: { idea: planned.idea, ...resync }, events: planned.events };
      },
      { db: deps.db, nowIso },
    );
  } catch (err) {
    if (err instanceof TenantIsolationError) return { ok: false, status: 404, error: "not_found" };
    throw err;
  }
  if (written.outcome === "rejected") return { ok: false, ...(REJECTIONS[written.reason] ?? REJECTIONS.not_found!) };
  if (!written.doc) return { ok: false, status: 404, error: "not_found" };
  const idea = written.doc.idea ?? {};
  const changed = written.outcome === "updated";

  let archived: boolean | null = null;
  if (change.closeWaitlist) {
    const close = deps.archive ?? ((c: TenantContext, id: string) => setLaunchArchived(c, id, "archive", { reason: `idea ${idea.status}` }, deps.db));
    archived = await close(ctx, campaignId).then(
      () => true,
      (err) => {
        console.error(`[ideas] closing the waitlist of ${campaignId} failed`, err);
        return false;
      },
    );
  }
  return { ok: true, idea, changed, archived };
}
