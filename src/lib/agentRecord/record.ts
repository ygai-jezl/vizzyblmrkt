import { randomUUID } from "node:crypto";
import { forTenant, proposeAgentAction, transitionAgentAction, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { deterministicAgentActionId } from "@/lib/crm/identifiers";
import { getAgentAction } from "@/lib/ontology/agentActions";
import type { AgentTarget, EventActor } from "@/lib/ontology/events";
import { AgentActionSchema, agentDedupeKey, type AgentAction, type DeclineReason } from "@/lib/types/agentAction";
import { isAgentRecordEnabled } from "./flags";
import { hash16 } from "./fingerprints";
import { lineFor, RECORD_SYSTEM, type DraftKind, type RecordAction } from "./sources";

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
 * - Superseded, stale and expired are the system's, never a person's no. A decline clears the
 *   proposal (decision 25); acted keeps the label.
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
  /** The key's own part in place of the draft's ref and a random part (a style's hash of its suggestedAt). */
  keyPart?: string;
  /** Who asked: the member in the chat or on the page by default; the system for the autopilot. */
  requestedBy?: EventActor;
}

export type RecordOutcome = "recorded" | "same" | "off" | "failed";

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
  };
}

/** The same draft as the open record holds: nothing to write. */
function sameAs(open: AgentAction, proposal: Record<string, unknown>): boolean {
  const was = open.proposal ?? {};
  return ["label", "fingerprint", "keys", "refs", "run"].every((k) => JSON.stringify(was[k] ?? null) === JSON.stringify(proposal[k] ?? null));
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
  try {
    const nowMs = deps.nowMs ?? Date.now();
    const at = new Date(nowMs).toISOString();
    const open = await openRecordsFor(ctx, input.draft, deps.db);
    if (!isAgentRecordEnabled()) {
      for (const a of open) await declineAsSystem(ctx, a, "superseded", at, deps.db);
      return "off";
    }
    const proposal = proposalOf(input);
    const [first, ...older] = open;
    for (const a of older) await declineAsSystem(ctx, a, "superseded", at, deps.db);
    // One past its expiry and not yet swept closes as expired: nobody decided it.
    const expired = first && first.expiresAt <= at;
    if (expired) await declineAsSystem(ctx, first, "expired", at, deps.db);
    const newest = expired ? undefined : first;
    if (newest && sameAs(newest, proposal)) return "same";
    // The draft keeps its first action and target: a journey drafted and then styled is one draft.
    const line = (newest && lineFor(newest.action)) || lineFor(input.action);
    if (!line) throw new Error(`unknown_action:${input.action}`);
    if (newest) await declineAsSystem(ctx, newest, "superseded", at, deps.db);
    const target: AgentTarget = newest ? newest.target : input.launchId ? { type: "idea", id: input.launchId } : { type: "brand", id: ctx.tenantId };
    const dedupeKey = input.keyPart
      ? agentDedupeKey(line.action, input.keyPart)
      : agentDedupeKey(line.action, refPart(input.draft.ref), randomUUID().replace(/-/g, ""));
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
        at,
      },
      { db: deps.db },
    );
    return saved.outcome === "created" ? "recorded" : "same";
  } catch (err) {
    failed(`record ${input.action}`, err);
    return "failed";
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
  const result = { ...(edited === undefined ? {} : { edited }), ...(outcome.result ?? {}) };
  const r = await transitionAgentAction(ctx, a.id, { to: "acted", by: outcome.by, at, expectRev: a.rev, result: Object.keys(result).length ? result : null }, { db });
  return r.ok;
}

/** Runs the fingerprint once, however many records it closes. */
function once(fp: string | null | undefined | (() => Promise<string | null>)): () => Promise<string | null> {
  let memo: Promise<string | null> | null = null;
  return () => (memo ??= typeof fp === "function" ? fp().catch(() => null) : Promise.resolve(fp ?? null));
}

/**
 * Close the records open for a draft where a person (or the system) decided: acted, with "edited"
 * from the fingerprint, or declined. Runs whatever the switch says. Returns how many it closed;
 * never throws.
 */
export async function closeDraft(ctx: TenantContext, draft: DraftRef, outcome: DraftOutcome, deps: RecordDeps = {}): Promise<number> {
  try {
    const open = await openRecordsFor(ctx, draft, deps.db);
    if (!open.length) return 0;
    const at = new Date(deps.nowMs ?? Date.now()).toISOString();
    const fingerprint = once(outcome.to === "acted" ? outcome.fingerprint : null);
    let closed = 0;
    for (const a of open) if (await closeOne(ctx, a, outcome, at, fingerprint, deps.db)) closed += 1;
    return closed;
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

/** Close a record as acted by the system (the engine switch, Found live, the map's own lists). Never throws. */
export async function actAsSystem(ctx: TenantContext, a: AgentAction, result: Record<string, unknown> | null, deps: RecordDeps = {}): Promise<boolean> {
  try {
    const at = new Date(deps.nowMs ?? Date.now()).toISOString();
    const r = await transitionAgentAction(ctx, a.id, { to: "acted", by: RECORD_SYSTEM, at, expectRev: a.rev, result }, { db: deps.db });
    return r.ok;
  } catch (err) {
    failed(`close ${a.action}`, err);
    return false;
  }
}
