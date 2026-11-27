import { createHash } from "node:crypto";
import { z } from "zod";
import { readFieldList } from "@/lib/audience/fieldList";
import { setFieldValues } from "@/lib/audience/fields";
import { personHref } from "@/lib/audience/paths";
import { agentActionReviewItem, getAgentAction, listAgentActionsForPerson, listOpenAgentActions, pageAgentActions } from "@/lib/ontology/agentActions";
import type { EventActor } from "@/lib/ontology/events";
import type { ReviewItem } from "@/lib/review/summary";
import { forTenant, getTenantById, isRateLimited, proposeAgentAction, transitionAgentAction, type AgentProposal, type RateLimitConfig, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { agentDedupeKey, isAgentActionId, type AgentAction, type AgentActionId } from "@/lib/types/agentAction";
import type { ContactPersonId } from "@/lib/ontology/person";
import type { Tenant } from "@/lib/types/tenant";
import { optionLabel, sameFieldValue, type FieldValue, type RecordField } from "@/lib/types/recordField";
import type { BoardCard } from "./board";
import { raiseFieldsOf } from "./fields";
import { QUIET_AFTER_DAYS, quietDays, todayFor, type DueReason } from "./due";
import { isRaiseFollowupsEnabled } from "./flags";
import { REVIEW_WORDS } from "./words";

/**
 * Follow-ups from the investor and funding board (RAISE_FOLLOWUPS_ENABLED): YouGrow's rule
 * (src/lib/raise/pipeline/due.ts) raises one agent action per person per due reason, shown in Review
 * as "Follow-ups from your board" and on the board as a Follow up chip. No AI, no fetch.
 *
 * - The dedupe key carries its due reason and a hash of the day it came from (the Last touch, or the
 *   Next step date) and the Stage, so the same quiet spell or the same past date in the same stage
 *   never raises a second one, whether the first is still open or was decided. A new one needs a new
 *   Last touch or Next step date, or a new Stage they are still due in. One set aside as stale (their
 *   Stage moved, or the board went) was decided by nobody, so if they are back in that stage and
 *   still due, a new round of the key raises one again. The key holds no value: the hash, as person
 *   field suggestions do (src/lib/audience/fieldSuggestions.ts).
 * - Cleared when touched or moved: a new Last touch marks the quiet ones acted, a new Next step date
 *   the next step ones; a new Stage declines every open one as stale. I followed up today sets Last
 *   touch to today and marks it acted in one transaction; Dismiss declines it. 14 days untouched
 *   declines it as expired, and a brand that is no longer set up for the board has its open ones
 *   declined as stale.
 * - The basis (the Stage and the day it came from) sits under `basis.fields` by field id, so a
 *   field erase blanks it in place, and it is cleared when the follow-up closes. A person's erase
 *   deletes their follow-ups, and their export includes them, as for every agent action.
 * - Review rows carry no name, address or value beyond the brand's own stage name and a day count.
 */

export const RAISE_FOLLOWUP_ACTION = "raise_followup.suggest";
export const RAISE_FOLLOWUPS_AGENT = "raise_followups" as const;
export const RAISE_FOLLOWUP_REVIEW_KIND = "raise_followup" as const;
/** The rule behind them (RULE_DECISIONS.investor_quiet) and its version. */
export const FOLLOWUP_RULE = { rule: "investor_quiet", ruleVersion: 1 } as const;
/** A follow-up nobody decides goes after this many days. */
export const FOLLOWUP_EXPIRY_DAYS = 14;

const SYSTEM: EventActor = { type: "system", id: RAISE_FOLLOWUPS_AGENT };
const DAY_MS = 86_400_000;
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** The board's field ids a follow-up reads. */
export interface FollowUpFields {
  stage: string;
  lastTouch?: string;
  nextStepDate?: string;
}

/**
 * A follow-up's dedupe key: `raise_followup.suggest|<due>|<personId>|<hash>`, the hash over the due
 * reason, the date field, the day and the Stage option, so the key keeps no field value (an erase of
 * Last touch leaves none behind) and the same day in the same stage gives the same key; a later
 * round adds `|r<n>`. The due reason stays readable for the timeline (personTimelineView.ts). Pure.
 */
export function followUpKey(input: { personId: string; due: DueReason; day: string; dateField: string; stageOptionId: string; round?: number }): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([input.due, input.dateField, input.day, input.stageOptionId]))
    .digest("hex")
    .slice(0, 32);
  const parts = [input.due, input.personId, hash, ...(input.round ? [`r${input.round}`] : [])];
  return agentDedupeKey(RAISE_FOLLOWUP_ACTION, ...parts);
}

/** How many times one follow-up set aside as stale may be raised again for the same day and stage. */
const MAX_ROUNDS = 10;

/** One follow-up for one person and one due reason, as proposeAgentAction takes it. Pure. */
export function followUpProposal(input: { personId: string; due: DueReason; day: string; stageOptionId: string; stageField: string; dateField: string; at: string; round?: number }): AgentProposal {
  const { personId, due, day, stageOptionId, stageField, dateField, at, round } = input;
  return {
    dedupeKey: followUpKey({ personId, due, day, dateField, stageOptionId, round }),
    agent: RAISE_FOLLOWUPS_AGENT,
    action: RAISE_FOLLOWUP_ACTION,
    target: { type: "person", id: personId },
    personId: personId as ContactPersonId,
    proposal: { due, ...FOLLOWUP_RULE, quietAfterDays: QUIET_AFTER_DAYS },
    basis: { fields: { [stageField]: stageOptionId, [dateField]: day } },
    fieldIds: [stageField, dateField],
    // The day first, then the stage: refs only, so they outlive a field erase.
    signals: [
      { kind: "field_value", ref: dateField },
      { kind: "field_value", ref: stageField },
    ],
    review: { kind: RAISE_FOLLOWUP_REVIEW_KIND, href: personHref(personId) },
    requestedBy: SYSTEM,
    expiresAt: new Date(Date.parse(at) + FOLLOWUP_EXPIRY_DAYS * DAY_MS).toISOString(),
    clearDetailsOnClose: true,
    at,
  };
}

/** A follow-up's due reason and the field ids it was made from (from its signals, which an erase never blanks). */
export function followUpParts(a: Pick<AgentAction, "proposal" | "signals" | "basis">): { due: DueReason | null; dateField: string | null; stageField: string | null; basis: Record<string, unknown> } {
  const due = a.proposal?.due === "quiet" || a.proposal?.due === "next_step" ? (a.proposal.due as DueReason) : null;
  const basis = (a.basis?.fields && typeof a.basis.fields === "object" ? a.basis.fields : {}) as Record<string, unknown>;
  return { due, dateField: a.signals[0]?.ref ?? null, stageField: a.signals[1]?.ref ?? null, basis };
}

/**
 * Raise a follow-up for each due reason of each card, newest rule first, stopping at `maxOpen` open
 * for the brand or `maxNew` new this run. Idempotent: a key already used writes nothing, unless the
 * one it holds was set aside as stale, when the next round is tried (at most MAX_ROUNDS).
 */
export async function proposeFollowUps(
  ctx: TenantContext,
  cards: readonly Pick<BoardCard, "id" | "stageOptionId" | "lastTouch" | "nextStepDate" | "due">[],
  opts: { fields: FollowUpFields; now: Date; openNow: number; maxOpen: number; maxNew: number; stop?: () => boolean },
  db?: FirestoreLike,
): Promise<{ created: number; open: number }> {
  let created = 0;
  let open = opts.openNow;
  const at = opts.now.toISOString();
  for (const card of cards) {
    if (!card.stageOptionId) continue;
    for (const due of card.due) {
      if (open >= opts.maxOpen || created >= opts.maxNew || opts.stop?.()) return { created, open };
      const day = due === "quiet" ? card.lastTouch : card.nextStepDate;
      const dateField = due === "quiet" ? opts.fields.lastTouch : opts.fields.nextStepDate;
      if (!day || !dateField) continue;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const r = await proposeAgentAction(ctx, followUpProposal({ personId: card.id, due, day, stageOptionId: card.stageOptionId, stageField: opts.fields.stage, dateField, at, round }), { db });
        if (r.outcome === "created") {
          created += 1;
          open += 1;
        }
        // Open, or decided by someone (followed up, dismissed) or let go (expired): never again.
        if (r.outcome !== "decided" || r.action.declined?.reason !== "stale") break;
      }
    }
  }
  return { created, open };
}

/** What became of a follow-up whose person changed: their Stage moved (stale), its day moved (acted), or nothing. */
export function followUpChange(a: Pick<AgentAction, "proposal" | "signals" | "basis">, now: (fieldId: string) => unknown): "stale" | "acted" | null {
  const { stageField, dateField, basis } = followUpParts(a);
  if (!stageField || !dateField) return "stale";
  const same = (id: string) => sameFieldValue((now(id) ?? null) as FieldValue | null, (basis[id] ?? null) as FieldValue | null);
  if (!same(stageField)) return "stale";
  if (!same(dateField)) return "acted";
  return null;
}

/** The most pages of open follow-ups one brand's reconcile reads. */
const RECONCILE_PAGES = 4;

/**
 * Put every open follow-up in step with its person, for changes no route cleared at once (Vizzy's
 * confirmed suggestions, a paste, another writer): their Stage no longer what it came from means
 * declined as stale, its day no longer what it came from means acted (they were touched, or got a
 * new date), and past its expiry means declined as expired. `valuesOf` answers a person's values by
 * field id, or null when they are gone. Equality only (no composite index). Returns the open ones left.
 */
export async function reconcileFollowUps(
  ctx: TenantContext,
  opts: { now: Date; valuesOf: (personId: string) => Promise<Record<string, unknown> | null>; stop?: () => boolean },
  db?: FirestoreLike,
): Promise<{ acted: number; cleared: number; expired: number; open: number; openPeople: Set<string> }> {
  const out = { acted: 0, cleared: 0, expired: 0, open: 0, openPeople: new Set<string>() };
  const at = opts.now.toISOString();
  let after: string | null = null;
  for (let page = 0; page < RECONCILE_PAGES; page++) {
    // Past the deadline: no further reads.
    if (opts.stop?.()) break;
    const p = await pageAgentActions(ctx, { action: RAISE_FOLLOWUP_ACTION, state: "proposed" }, { after, limit: 50, db });
    for (const a of p.actions) {
      if (opts.stop?.() || !a.personId) {
        out.open += 1;
        continue;
      }
      let move: { to: "declined"; reason: "expired" | "stale" } | { to: "acted" } | null = null;
      if (a.expiresAt <= at) move = { to: "declined", reason: "expired" };
      else {
        const values = await opts.valuesOf(a.personId);
        const change = values ? followUpChange(a, (id) => values[id]) : "stale";
        if (change === "stale") move = { to: "declined", reason: "stale" };
        else if (change === "acted") move = { to: "acted" };
      }
      if (!move) {
        out.open += 1;
        out.openPeople.add(a.personId);
        continue;
      }
      const r = await transitionAgentAction(ctx, a.id, { ...move, by: SYSTEM, at, expectRev: a.rev }, { db });
      if (!r.ok) continue;
      if (move.to === "acted") out.acted += 1;
      else if (move.reason === "expired") out.expired += 1;
      else out.cleared += 1;
    }
    if (!p.more || opts.stop?.()) break;
    after = p.last;
  }
  return out;
}

/**
 * After a write to a person commits (a card move, or a value set on their page): their open
 * follow-ups cleared at once. A new Stage declines every one as stale; a new Last touch marks the
 * quiet ones acted, a new Next step date the next step ones, by whoever made the change. Only while
 * RAISE_FOLLOWUPS_ENABLED is on (off: nothing is read). Never throws.
 */
export async function clearFollowUpsAfterWrite(
  ctx: TenantContext,
  personId: string,
  changedFieldIds: readonly string[],
  by: EventActor,
  opts: { db?: FirestoreLike; now?: Date } = {},
): Promise<{ acted: number; cleared: number }> {
  const out = { acted: 0, cleared: 0 };
  if (!isRaiseFollowupsEnabled() || !changedFieldIds.length) return out;
  try {
    const { actions } = await listAgentActionsForPerson(ctx, personId as ContactPersonId, { state: "proposed", db: opts.db });
    const changed = new Set(changedFieldIds);
    const at = (opts.now ?? new Date()).toISOString();
    for (const a of actions) {
      if (a.action !== RAISE_FOLLOWUP_ACTION) continue;
      const { stageField, dateField } = followUpParts(a);
      const move = stageField && changed.has(stageField) ? ({ to: "declined", reason: "stale" } as const) : dateField && changed.has(dateField) ? ({ to: "acted" } as const) : null;
      if (!move) continue;
      const r = await transitionAgentAction(ctx, a.id, { ...move, by, at, expectRev: a.rev }, { db: opts.db });
      if (r.ok && move.to === "acted") out.acted += 1;
      else if (r.ok) out.cleared += 1;
    }
  } catch (err) {
    console.warn(`[raise] clearing follow-ups for ${ctx.tenantId} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
  }
  return out;
}

/** The people with an open follow-up now, for the board's Follow up chips. */
export async function openFollowUpPeople(ctx: TenantContext, db?: FirestoreLike): Promise<Set<string>> {
  const open = await listOpenAgentActions(ctx, { action: RAISE_FOLLOWUP_ACTION, limit: 200, db });
  return new Set(open.flatMap((a) => (a.personId ? [a.personId] : [])));
}

/** One open follow-up as a Review row: the stage's name and a day count, never who. Pure. */
export function followUpReviewItem(a: AgentAction, fields: readonly RecordField[], today: string): ReviewItem | null {
  const { due, stageField, dateField, basis } = followUpParts(a);
  if (!due) return null;
  const field = fields.find((f) => f.key === stageField);
  const stageId = stageField ? basis[stageField] : null;
  const stage = field && typeof stageId === "string" ? optionLabel(field, stageId) : null;
  const quiet = due === "quiet";
  const day = dateField ? basis[dateField] : null;
  const days = isDay(day) ? quietDays(day, today) : null;
  const item = agentActionReviewItem(a, {
    title: quiet ? (days !== null ? REVIEW_WORDS.quietTitle(days) : REVIEW_WORDS.quietWhile) : REVIEW_WORDS.nextStepTitle,
    detail: quiet ? REVIEW_WORDS.quietDetail(stage) : REVIEW_WORDS.nextStepDetail(stage),
    action: REVIEW_WORDS.open,
  });
  return item ? { ...item, followUp: { id: a.id, rev: a.rev, quiet } } : null;
}

/**
 * Review's "Follow-ups from your board": every open follow-up, newest first. Shown to everyone on the
 * team, and none once the brand has no board (its Stage archived): the tick lane sets those aside.
 * The brand's time zone is read from the control plane (`db` stands in for it in tests, as Review's
 * other loaders do).
 */
export async function followUpReviewItems(
  ctx: TenantContext,
  db?: FirestoreLike,
  deps: { loadTenant?: (id: string) => Promise<Tenant | null>; now?: () => Date } = {},
): Promise<ReviewItem[]> {
  const open = await listOpenAgentActions(ctx, { action: RAISE_FOLLOWUP_ACTION, limit: 50, db });
  if (!open.length) return [];
  const loadTenant = deps.loadTenant ?? ((id: string) => getTenantById(id, db));
  const [list, tenant] = await Promise.all([readFieldList(ctx, "person", db), loadTenant(ctx.tenantId).catch(() => null)]);
  if (!raiseFieldsOf(list.items).setUp) return [];
  const today = todayFor(tenant?.timeZone, deps.now?.() ?? new Date());
  return open.map((a) => followUpReviewItem(a, list.items, today)).filter((i): i is ReviewItem => !!i);
}

// --- Deciding one ------------------------------------------------------------------------------

export type ApiResult = { status: number; body: unknown };

export const FOLLOWUP_LIMIT: RateLimitConfig = { prefix: "raise_followup", burstLimit: 20, hourlyLimit: 300 };

const DecideBody = z.object({ op: z.enum(["followed_up", "dismiss"]), rev: z.number().int().min(1) }).strict();

const STALE: ApiResult = { status: 409, body: { error: "stale" } };
const NOT_FOUND: ApiResult = { status: 404, body: { error: "not_found" } };

/**
 * I followed up today (quiet ones only): Last touch set to today and the follow-up acted, in one
 * transaction through the one field writer, with `expect` on the day it came from. Dismiss: declined
 * as dismissed. Both name the rev the row showed. Admins only (the gate). Another brand's id, or one
 * that isn't a follow-up, is not found.
 */
export async function decideFollowUp(
  ctx: TenantContext,
  id: string,
  raw: unknown,
  deps: { db?: FirestoreLike; loadTenant?: (id: string) => Promise<Tenant | null>; now?: () => Date; forget?: (tenantId: string) => void } = {},
): Promise<ApiResult> {
  if (!isAgentActionId(id)) return NOT_FOUND;
  const body = DecideBody.safeParse(raw);
  if (!body.success) return { status: 400, body: { error: "invalid_input" } };
  if (await isRateLimited(`user:${ctx.tenantId}:${ctx.userId ?? "anon"}`, FOLLOWUP_LIMIT, { db: deps.db })) return { status: 429, body: { error: "rate_limited" } };
  const a = await getAgentAction(ctx, id as AgentActionId, { db: deps.db });
  if (!a || a.action !== RAISE_FOLLOWUP_ACTION || a.target.type !== "person" || !a.personId) return NOT_FOUND;
  if (a.state !== "proposed" || a.rev !== body.data.rev) return STALE;
  const by: EventActor = { type: "member", id: ctx.userId ?? null };
  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();
  if (body.data.op === "dismiss") {
    const r = await transitionAgentAction(ctx, a.id, { to: "declined", reason: "dismissed", by, at, expectRev: body.data.rev }, { db: deps.db });
    if (!r.ok) return r.error === "not_found" ? NOT_FOUND : STALE;
  } else {
    const { due, dateField, basis } = followUpParts(a);
    if (due !== "quiet" || !dateField) return { status: 400, body: { error: "invalid_input" } };
    const tenant = await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);
    const r = await setFieldValues(
      ctx,
      {
        object: "person",
        recordId: a.personId,
        changes: { [dateField]: todayFor(tenant?.timeZone, now) },
        by,
        source: "editor",
        agentAction: { id: a.id, transition: { to: "acted", by, at, expectRev: body.data.rev } },
        expect: { [dateField]: basis[dateField] ?? null },
        nowIso: at,
      },
      { db: deps.db },
    );
    if (!r.ok) {
      if (r.error === "not_found" || r.error === "agent_action_not_found") return NOT_FOUND;
      if (r.error === "stale" || r.error === "agent_action_changed" || r.error === "agent_action_wrong_state") return STALE;
      return { status: 400, body: { error: "invalid_value" } };
    }
  }
  if (deps.forget) deps.forget(ctx.tenantId);
  else (await import("@/lib/review/summary")).forgetReviewCount(ctx.tenantId);
  return { status: 200, body: { ok: true } };
}

/** A person's values by field id, read by id (another brand's or someone erased reads as nobody). */
export async function personValues(ctx: TenantContext, personId: string, db?: FirestoreLike): Promise<Record<string, unknown> | null> {
  const p = await forTenant(ctx, db).contacts.getById(personId);
  return p ? ((p.fields ?? {}) as Record<string, unknown>) : null;
}
