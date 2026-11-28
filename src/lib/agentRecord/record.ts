import { randomUUID } from "node:crypto";
import { forTenant, proposeAgentAction, transitionAgentAction, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { deterministicAgentActionId } from "@/lib/crm/identifiers";
import { getAgentAction } from "@/lib/ontology/agentActions";
import type { AgentTarget, EventActor } from "@/lib/ontology/events";
import { AgentActionSchema, agentDedupeKey, type AgentAction, type DeclineReason } from "@/lib/types/agentAction";
import type { LoopStamp, Made } from "@/lib/types/loopStamp";
import { isAgentRecordEnabled } from "./flags";
import { hash16, stableJson } from "./fingerprints";
import { lineFor, RECORD_SYSTEM, type DraftKind, type RecordAction, type SourceLine } from "./sources";

/**
 * Agent record (ADR-0026): recording an agent's draft beside its own save, and closing the record
 * where a person decides. Every write goes through 0e's writers (proposeAgentAction and
 * transitionAgentAction, src/lib/tenant/agentActions.ts).
 *
 * - One open record per draft, found by its draft kind, ref and state, by equality only (no
 *   composite index). Vizzy saving the same draft again declines the open record as superseded and
 *   opens a new one with the same action, so "edited" always means a person's change, and a
 *   journey Vizzy drafted and then styled stays one draft. Saving it with nothing changed keeps it.
 * - Soft: a failed write is logged and counted, and never fails the save it rides on.
 * - Closing runs whatever the switch says, so records written before a rollback still end right.
 *   With no open record it is one read and no write.
 * - Superseded, stale and expired are the system's, never a person's no. Every record asks 0e to
 *   clear its proposal when it closes (clearDetailsOnClose), so a decline, 0e's own expiry sweep
 *   included, keeps nothing of the draft (decision 25). Acted keeps the label, moved to `result`.
 * - The loops (learning loops step 5): a line whose outcome is counted here (`countsAt:
 *   "transition"`) keeps the stamp of what made the draft, so transitionAgentAction counts the
 *   person's answer once against it (kept, edited by the fingerprint, or dismissed). A line
 *   counted at its own path keeps none, so its answer is never counted twice.
 */

/** A draft as the record names it: its kind (a store) and its id there. */
export interface DraftRef {
  kind: DraftKind;
  ref: string;
}

/** The most key hashes and record refs a map run keeps. */
export const MAX_RUN_KEYS = 100;
/** A label's length at most. */
export const MAX_LABEL = 120;

export interface RecordDraftInput {
  action: RecordAction;
  draft: DraftRef;
  /** The launch the draft belongs to: its record targets the idea, so deleteLaunch erases it. */
  launchId?: string | null;
  /** The draft's page. */
  href: string;
  /** The brand's own name for the draft (none for a note or a style). */
  label?: string | null;
  /** What the draft holds now (fingerprints.ts), for "kept after a person's edits". */
  fingerprint?: string | null;
  /** A brand map run: the hashes of the keys it filed (keyHash). */
  keys?: readonly string[];
  /** A brand map run: the proposals it made on the map's records, as `sub:<id>`, `q:<id>` or `sit:<id>`. */
  refs?: readonly string[];
  /** Learning from a repo: the run's id. */
  run?: string;
  /** A content plan: the ids of its pieces already approved, and whether it was already scheduled, so only a later approval counts. */
  approved?: readonly string[];
  scheduled?: boolean;
  /** A brand map run: how many of its suggestions a newer research run replaced while it waited. */
  replaced?: number;
  /** The key's own part in place of the draft's ref and a random part (a style's hash of its suggestedAt). */
  keyPart?: string;
  /** Who asked: the member in the chat or on the page by default; the system for the autopilot. */
  requestedBy?: EventActor;
  /** What made the draft (learning loops step 5): kept only for a line counted here (stampOf). */
  made?: Made;
}

export type RecordOutcome = "recorded" | "same" | "off" | "failed";

/** A draft recorded, and whether its save left a draft already counted (learning loops step 5). */
export interface RecordResult {
  outcome: RecordOutcome;
  /**
   * True when the save left a draft already counted made and not yet answered: the record open
   * for it before kept a stamp (Vizzy's new words, or a save of another kind, on its own draft),
   * or nothing changed. False when nothing was open, the open record kept no stamp (a person's
   * draft, or one saved with LOOPS_ENABLED off) or it had expired, so the save is a new made thing.
   * Null with the record off or failed before it could tell: no record keeps the answer then, so
   * the caller's own rule decides.
   */
  counted: boolean | null;
}

export type DraftOutcome =
  | {
      to: "acted";
      by: EventActor;
      /** What the draft holds now, or a function that reads it, called only when a record is open. */
      fingerprint?: string | null | (() => Promise<string | null>);
      /** More to keep on the record: a map run's kept and dismissed counts, learning's accepted. */
      result?: Record<string, unknown>;
    }
  | { to: "declined"; reason: DeclineReason; by: EventActor };

export interface RecordDeps {
  db?: FirestoreLike;
  nowMs?: number;
}

const DAY_MS = 86_400_000;
const OPEN_READ = 5;
const KEY_PART = /^[A-Za-z0-9_.:-]{1,80}$/;

let failures = 0;
/** Writes that failed since this instance started (logged as `[agent-record] write_failed`). */
export function recordFailures(): number {
  return failures;
}
/** Test hook. */
export function resetRecordFailures(): void {
  failures = 0;
}

function failed(what: string, err: unknown): void {
  failures += 1;
  console.warn(`[agent-record] write_failed ${what}:`, err instanceof Error ? err.message.slice(0, 200) : "error");
}

/** A member from the context, by user id. */
export function memberOf(ctx: TenantContext): EventActor {
  return { type: "member", id: ctx.userId ?? null };
}

/** A draft's ref as a key part: itself when it fits, else its hash. */
const refPart = (ref: string) => (KEY_PART.test(ref) ? ref : hash16(ref));

/** This brand's open records for one draft, newest first: equality on the draft and the state only. */
export async function openRecordsFor(ctx: TenantContext, draft: DraftRef, db?: FirestoreLike): Promise<AgentAction[]> {
  const rows = await forTenant(ctx, db).agentActions.find({
    where: [
      ["draft.kind", "==", draft.kind],
      ["draft.ref", "==", draft.ref],
      ["state", "==", "proposed"],
    ],
    limit: OPEN_READ,
  });
  const out: AgentAction[] = [];
  for (const row of rows) {
    const r = AgentActionSchema.safeParse(row);
    if (r.success && r.data.tenantId === ctx.tenantId) out.push(r.data as AgentAction);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The proposal a record keeps: ids, a label and a fingerprint only. */
function proposalOf(input: RecordDraftInput): Record<string, unknown> {
  const label = input.label?.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
  return {
    ...(label ? { label } : {}),
    ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
    ...(input.keys?.length ? { keys: [...new Set(input.keys)].slice(0, MAX_RUN_KEYS) } : {}),
    ...(input.refs?.length ? { refs: [...new Set(input.refs)].slice(0, MAX_RUN_KEYS) } : {}),
    ...(input.run ? { run: input.run } : {}),
    ...(input.approved?.length ? { approved: [...new Set(input.approved)].slice(0, MAX_RUN_KEYS) } : {}),
    ...(input.scheduled ? { scheduled: true } : {}),
    ...(input.replaced ? { replaced: input.replaced } : {}),
  };
}

/** A stamp, leaving out a save with none. */
const stampIn = (m: Made | null | undefined): LoopStamp | undefined => (m && !("unstamped" in m) ? m : undefined);

/**
 * The stamp a record keeps (learning loops step 5): none for a line the loops count at its own
 * path (invite waves, content plans, the autopilot, brand map runs), so an answer counts once
 * there. Otherwise the newest save's stamp, as Vizzy's new words take the newest stamp; but a save
 * of another kind on a draft already recorded (a style on a journey Vizzy drafted) keeps the
 * draft's own stamp, as the record keeps its first action and target, so the answer counts under
 * the kind that made the draft. Pure.
 */
export function stampOf(line: Pick<SourceLine, "countsAt">, made: Made | null | undefined, open: AgentAction | undefined): LoopStamp | undefined {
  if (line.countsAt !== "transition") return undefined;
  const now = stampIn(made);
  const was = stampIn(open?.made);
  if (was && now && was.kind !== now.kind) return was;
  return now ?? was;
}

/** The same draft as the open record holds: nothing to write. */
function sameAs(open: AgentAction, proposal: Record<string, unknown>): boolean {
  return stableJson(open.proposal ?? {}) === stableJson(proposal);
}

/** What an acted record keeps once 0e clears its proposal: the label. */
function keptOf(a: AgentAction): Record<string, unknown> {
  return typeof a.proposal?.label === "string" ? { label: a.proposal.label } : {};
}

/** Decline one record as the system, its proposal cleared; false when it moved meanwhile. */
async function declineAsSystem(ctx: TenantContext, a: AgentAction, reason: DeclineReason, at: string, db?: FirestoreLike): Promise<boolean> {
  const r = await transitionAgentAction(ctx, a.id, { to: "declined", reason, by: RECORD_SYSTEM, at, expectRev: a.rev, clearDetails: true }, { db });
  return r.ok;
}

/**
 * Record a draft an agent saved, beside its own save. Off, it proposes nothing, but still declines
 * a record open for this draft as superseded (closing runs whatever the switch says). Never throws.
 */
export async function recordDraft(ctx: TenantContext, input: RecordDraftInput, deps: RecordDeps = {}): Promise<RecordOutcome> {
  return (await recordDraftCounted(ctx, input, deps)).outcome;
}

/**
 * recordDraft, saying too whether the draft was already counted (RecordResult.counted), so a
 * canvas kind counts made once for each record an answer can close (decision 20). Never throws.
 */
export async function recordDraftCounted(ctx: TenantContext, input: RecordDraftInput, deps: RecordDeps = {}): Promise<RecordResult> {
  try {
    const nowMs = deps.nowMs ?? Date.now();
    const at = new Date(nowMs).toISOString();
    const open = await openRecordsFor(ctx, input.draft, deps.db);
    if (!isAgentRecordEnabled()) {
      for (const a of open) await declineAsSystem(ctx, a, "superseded", at, deps.db);
      return { outcome: "off", counted: null };
    }
    const proposal = proposalOf(input);
    const [first, ...older] = open;
    for (const a of older) await declineAsSystem(ctx, a, "superseded", at, deps.db);
    // One past its expiry and not yet swept closes as expired: nobody decided it.
    const expired = first && first.expiresAt <= at;
    if (expired) await declineAsSystem(ctx, first, "expired", at, deps.db);
    const newest = expired ? undefined : first;
    // The draft keeps its first action and target: a journey drafted and then styled is one draft.
    const line = (newest && lineFor(newest.action)) || lineFor(input.action);
    if (!line) throw new Error(`unknown_action:${input.action}`);
    const dedupeKey = input.keyPart
      ? agentDedupeKey(line.action, input.keyPart)
      : agentDedupeKey(line.action, refPart(input.draft.ref), randomUUID().replace(/-/g, ""));
    // Nothing changed, and the open record is still the one its page will name: a style suggested
    // again unchanged gets a new suggestedAt, so its record moves to the new key.
    if (newest && sameAs(newest, proposal) && (!input.keyPart || newest.dedupeKey === dedupeKey)) return { outcome: "same", counted: true };
    // The open record's stamp was counted made when it was saved, and its answer moves to the new record.
    const counted = Boolean(stampIn(newest?.made));
    if (newest) await declineAsSystem(ctx, newest, "superseded", at, deps.db);
    const target: AgentTarget = newest ? newest.target : input.launchId ? { type: "idea", id: input.launchId } : { type: "brand", id: ctx.tenantId };
    const made = stampOf(line, input.made, newest);
    const saved = await proposeAgentAction(
      ctx,
      {
        dedupeKey,
        agent: line.agent,
        action: line.action,
        target,
        personId: null,
        proposal: Object.keys(proposal).length ? proposal : null,
        basis: null,
        signals: [],
        draft: { kind: input.draft.kind, ref: input.draft.ref },
        review: { kind: line.review, href: input.href },
        requestedBy: input.requestedBy ?? memberOf(ctx),
        expiresAt: new Date(nowMs + line.expiryDays * DAY_MS).toISOString(),
        // Whoever closes it, 0e's expiry sweep too, the proposal goes with the decision (decision 25).
        clearDetailsOnClose: true,
        // Kept only with LOOPS_ENABLED on (keptMade, in proposeAgentAction).
        ...(made ? { made } : {}),
        at,
      },
      { db: deps.db },
    );
    return saved.outcome === "created" ? { outcome: "recorded", counted } : { outcome: "same", counted: true };
  } catch (err) {
    failed(`record ${input.action}`, err);
    return { outcome: "failed", counted: null };
  }
}

/** "Kept after a person's edits": the fingerprints differ. Unknown when either is missing. */
function editedOf(a: AgentAction, now: string | null): boolean | undefined {
  const was = typeof a.proposal?.fingerprint === "string" ? a.proposal.fingerprint : null;
  return was && now ? was !== now : undefined;
}

async function closeOne(ctx: TenantContext, a: AgentAction, outcome: DraftOutcome, at: string, fingerprint: () => Promise<string | null>, db?: FirestoreLike): Promise<boolean> {
  if (outcome.to === "declined") {
    const r = await transitionAgentAction(ctx, a.id, { to: "declined", reason: outcome.reason, by: outcome.by, at, expectRev: a.rev, clearDetails: true }, { db });
    return r.ok;
  }
  const edited = editedOf(a, await fingerprint());
  const result = { ...keptOf(a), ...(edited === undefined ? {} : { edited }), ...(outcome.result ?? {}) };
  const r = await transitionAgentAction(ctx, a.id, { to: "acted", by: outcome.by, at, expectRev: a.rev, result: Object.keys(result).length ? result : null }, { db });
  return r.ok;
}

/** Runs the fingerprint once, however many records it closes. */
function once(fp: string | null | undefined | (() => Promise<string | null>)): () => Promise<string | null> {
  let memo: Promise<string | null> | null = null;
  return () => (memo ??= typeof fp === "function" ? fp().catch(() => null) : Promise.resolve(fp ?? null));
}

/**
 * Close the record open for a draft where a person (or the system) decided: acted, with "edited"
 * from the fingerprint, or declined. One decision closes one record: the newest. Any older one
 * left open (two saves at once) is superseded by the system, so a decision never counts twice.
 * Runs whatever the switch says. Returns how many records the decision closed (0 or 1); never
 * throws.
 */
export async function closeDraft(ctx: TenantContext, draft: DraftRef, outcome: DraftOutcome, deps: RecordDeps = {}): Promise<number> {
  try {
    const [newest, ...older] = await openRecordsFor(ctx, draft, deps.db);
    if (!newest) return 0;
    const at = new Date(deps.nowMs ?? Date.now()).toISOString();
    for (const a of older) await declineAsSystem(ctx, a, "superseded", at, deps.db);
    const fingerprint = once(outcome.to === "acted" ? outcome.fingerprint : null);
    return (await closeOne(ctx, newest, outcome, at, fingerprint, deps.db)) ? 1 : 0;
  } catch (err) {
    failed(`close ${draft.kind}`, err);
    return 0;
  }
}

/** A style's record id, from its suggestedAt: its routes find it with no lookup. */
export function styleRecordId(tenantId: string, action: "email_style.suggest" | "image_style.suggest", suggestedAt: string) {
  return deterministicAgentActionId(tenantId, agentDedupeKey(action, styleKeyPart(suggestedAt)));
}

/** A style's key part: a hash of its suggestedAt. */
export function styleKeyPart(suggestedAt: string): string {
  return hash16(`suggested\n${suggestedAt}`);
}

/**
 * Close a style suggestion's record, found by its suggestedAt: applied (acted, with "edited" from
 * what was saved) or dismissed. Runs whatever the switch says; one read when there is none.
 */
export async function closeStyle(
  ctx: TenantContext,
  action: "email_style.suggest" | "image_style.suggest",
  suggestedAt: string,
  outcome: DraftOutcome,
  deps: RecordDeps = {},
): Promise<boolean> {
  try {
    const a = await getAgentAction(ctx, styleRecordId(ctx.tenantId, action, suggestedAt), { db: deps.db });
    if (!a || a.state !== "proposed") return false;
    const at = new Date(deps.nowMs ?? Date.now()).toISOString();
    return await closeOne(ctx, a, outcome, at, once(outcome.to === "acted" ? outcome.fingerprint : null), deps.db);
  } catch (err) {
    failed(`close ${action}`, err);
    return false;
  }
}

/** Decline a record as the system (superseded, stale or expired), its proposal cleared. Never throws. */
export async function closeAsSystem(ctx: TenantContext, a: AgentAction, reason: "superseded" | "stale" | "expired", deps: RecordDeps = {}): Promise<boolean> {
  try {
    return await declineAsSystem(ctx, a, reason, new Date(deps.nowMs ?? Date.now()).toISOString(), deps.db);
  } catch (err) {
    failed(`close ${a.action}`, err);
    return false;
  }
}

/** Close a record as acted by the system (the engine switch, Found live, the map's own lists), keeping its label. Never throws. */
export async function actAsSystem(ctx: TenantContext, a: AgentAction, result: Record<string, unknown> | null, deps: RecordDeps = {}): Promise<boolean> {
  try {
    const at = new Date(deps.nowMs ?? Date.now()).toISOString();
    const kept = { ...keptOf(a), ...(result ?? {}) };
    const r = await transitionAgentAction(ctx, a.id, { to: "acted", by: RECORD_SYSTEM, at, expectRev: a.rev, result: Object.keys(kept).length ? kept : null }, { db: deps.db });
    return r.ok;
  } catch (err) {
    failed(`close ${a.action}`, err);
    return false;
  }
}
