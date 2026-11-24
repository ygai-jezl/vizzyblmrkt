import { parseQuestion, removeQuestion } from "@/lib/brandMap/records";
import { pageAgentActions } from "@/lib/ontology/agentActions";
import { transitionAgentAction, type TenantContext } from "@/lib/tenant";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { AgentAction } from "@/lib/types/agentAction";
import { DATA_SIGNAL_ACTION, EXPIRY_DAYS, PROPOSE_QUESTION_ACTION, SIGNALS_AGENT } from "./names";
import { dropSearchConsolePicks } from "./planning";
import { blankSignal } from "./store";

/**
 * Keeping suggestions from collected numbers in step (Connectors 2 group 4, ADR-0012): the lane's
 * housekeeping, run whenever CONNECTORS_ENABLED is on, whatever CONNECTOR_SIGNALS_ENABLED says, so
 * a suggestion's values never outlive its 30 days even with signals turned off.
 *
 * - Expiry: every open suggestion from `connector_signals` past its expiry is declined as expired,
 *   its values cleared with the decision. Only this agent's: the lifecycle tick expires the rest.
 * - The brand map (pick 23): questions are decided through many paths (accepting proposals from
 *   three screens, a subject's dismissal, merging subjects, removing a question or a subject), so
 *   instead of hooking each, every open `brand_map.propose_question` is put in step with its
 *   question: decided means acted; dismissed means declined (dismissed); merged away or gone means
 *   declined (superseded). A question still undecided when its action expires (30 days) is
 *   withdrawn with removeQuestion, not dismissed, so its words don't stay and don't block a later
 *   proposal. One whose action someone else already closed (the lifecycle tick's expiry) is found
 *   by its connection (`fromConnectionId`) and withdrawn too.
 * - Planning (pick 6): a Search Console connection that no longer lets both members and Vizzy read
 *   it stops feeding planning at once. Its open suggestions are declined as stale with their values
 *   cleared, the questions it proposed that nobody has decided are withdrawn, and Next up picks
 *   that weighed its numbers are taken off (setGrants does this when the grant goes; the lane does
 *   it again for any connection it finds not feeding planning, so a failed first try is caught).
 */

/** Pages of one action read in a run, at most. Open suggestions are capped at 15 a brand. */
const PAGES = 5;
const PAGE = 50;

export interface ReconcileDeps {
  db?: FirestoreLike;
  now?: Date;
}

/** This agent's proposed actions of one kind, a few pages in id order (equality only). */
export async function proposedOf(ctx: TenantContext, action: string, deps: ReconcileDeps): Promise<AgentAction[]> {
  const out: AgentAction[] = [];
  let after: string | null = null;
  for (let page = 0; page < PAGES; page++) {
    const r = await pageAgentActions(ctx, { action, state: "proposed" }, { after, limit: PAGE, db: deps.db });
    out.push(...r.actions.filter((a) => a.agent === SIGNALS_AGENT));
    if (!r.more) break;
    after = r.last;
  }
  return out;
}

/** Decline one action as the system, values cleared; false when it moved meanwhile. */
export async function declineAs(ctx: TenantContext, a: AgentAction, reason: "expired" | "stale" | "dismissed" | "superseded", deps: ReconcileDeps): Promise<boolean> {
  const at = (deps.now ?? new Date()).toISOString();
  const r = await transitionAgentAction(ctx, a.id, { to: "declined", reason, by: { type: "system", id: SIGNALS_AGENT }, at, expectRev: a.rev, clearDetails: true }, { db: deps.db });
  return r.ok;
}

/** The connection an open suggestion came from, and its generation, from its proposal. */
function sourceOf(a: AgentAction): { connectionId: string | null; gen: number | null } {
  const p = (a.proposal ?? {}) as { connectionId?: unknown; gen?: unknown };
  return { connectionId: typeof p.connectionId === "string" ? p.connectionId : null, gen: typeof p.gen === "number" ? p.gen : null };
}

/**
 * Decline this agent's Review suggestions past their expiry, and any still open from a connection
 * that no longer feeds planning (`notPlanning`) as stale. Returns how many.
 */
export async function expireConnectorSignals(ctx: TenantContext, deps: ReconcileDeps & { notPlanning?: ReadonlySet<string> } = {}): Promise<{ expired: number }> {
  const now = (deps.now ?? new Date()).toISOString();
  let expired = 0;
  for (const a of await proposedOf(ctx, DATA_SIGNAL_ACTION, deps)) {
    if (a.expiresAt <= now) {
      if (await declineAs(ctx, a, "expired", deps)) expired += 1;
      continue;
    }
    const from = sourceOf(a).connectionId;
    if (from && deps.notPlanning?.has(from) && (await declineAs(ctx, a, "stale", deps))) {
      await blankSignal(ctx, a.target.id, { db: deps.db });
      expired += 1;
    }
  }
  return { expired };
}

/**
 * This agent's open suggestions of both kinds from one connection (for `gens`, only those
 * generations'), found from the agent actions themselves: bounded (15 open a brand at most) and by
 * equality, so none is missed however many rows the connection's signals hold.
 */
export async function openSuggestionsOf(ctx: TenantContext, connectionId: string, gens: "all" | readonly number[], deps: ReconcileDeps = {}): Promise<AgentAction[]> {
  const out: AgentAction[] = [];
  for (const action of [DATA_SIGNAL_ACTION, PROPOSE_QUESTION_ACTION]) {
    for (const a of await proposedOf(ctx, action, deps)) {
      const from = sourceOf(a);
      if (from.connectionId !== connectionId) continue;
      if (gens !== "all" && (from.gen === null || !gens.includes(from.gen))) continue;
      out.push(a);
    }
  }
  return out;
}

/**
 * A Search Console connection stopped feeding planning (members or Vizzy lost the grant): its open
 * suggestions declined as stale with their values cleared, the questions it proposed that nobody
 * has decided withdrawn, and Next up picks that weighed Search Console taken off. Returns how many
 * of each.
 */
export async function stopPlanningFrom(ctx: TenantContext, connectionId: string, deps: ReconcileDeps = {}): Promise<{ declined: number; withdrawn: number; picks: number }> {
  let declined = 0;
  let withdrawn = 0;
  for (const a of await openSuggestionsOf(ctx, connectionId, "all", deps)) {
    if (a.action === PROPOSE_QUESTION_ACTION && (await withdrawQuestion(ctx, a.target.id, deps))) withdrawn += 1;
    if (await declineAs(ctx, a, "stale", deps)) {
      declined += 1;
      if (a.action === DATA_SIGNAL_ACTION) await blankSignal(ctx, a.target.id, { db: deps.db });
    }
  }
  withdrawn += await withdrawProposedBy(ctx, connectionId, "all", deps);
  const picks = await dropSearchConsolePicks(ctx, { db: deps.db });
  return { declined, withdrawn, picks };
}

const DAY_MS = 86_400_000;

/** Withdraw an undecided question from the map: removed, never dismissed. False when it is gone or decided. */
export async function withdrawQuestion(ctx: TenantContext, id: string, deps: ReconcileDeps = {}): Promise<boolean> {
  const q = parseQuestion(await brandMapRecords(ctx, deps.db).get("q", id).catch(() => null));
  if (!q || q.status !== "proposed") return false;
  return (await removeQuestion(ctx, id, { db: deps.db })).ok;
}

/**
 * Before reverting Connectors 2 (ADR-0012): every open suggestion from collected numbers closed,
 * declined as stale with its values cleared, its row blanked and an undecided question it proposed
 * withdrawn. An older build can't read an agent action about a `data_signal` or a `brand_question`,
 * and its expiry stops at the first one it can't read, so none may stay open across a revert.
 * Counts only with `apply` false.
 */
export async function closeAllSuggestions(ctx: TenantContext, deps: ReconcileDeps & { apply: boolean }): Promise<{ open: number; closed: number; withdrawn: number }> {
  const out = { open: 0, closed: 0, withdrawn: 0 };
  for (const action of [DATA_SIGNAL_ACTION, PROPOSE_QUESTION_ACTION]) {
    for (const a of await proposedOf(ctx, action, deps)) {
      out.open += 1;
      if (!deps.apply) continue;
      if (action === PROPOSE_QUESTION_ACTION && (await withdrawQuestion(ctx, a.target.id, deps))) out.withdrawn += 1;
      if (await declineAs(ctx, a, "stale", deps)) {
        out.closed += 1;
        if (action === DATA_SIGNAL_ACTION) await blankSignal(ctx, a.target.id, { db: deps.db });
      }
    }
  }
  return out;
}

/**
 * Put this agent's brand map proposals in step with their questions, then withdraw any question
 * proposed from these Search Console connections that is still undecided after 30 days. Returns
 * how many actions moved and questions were withdrawn.
 */
export async function reconcileProposals(
  ctx: TenantContext,
  connectionIds: readonly string[],
  deps: ReconcileDeps & { notPlanning?: ReadonlySet<string> } = {},
): Promise<{ acted: number; declined: number; withdrawn: number }> {
  const nowDate = deps.now ?? new Date();
  const now = nowDate.toISOString();
  const store = brandMapRecords(ctx, deps.db);
  const out = { acted: 0, declined: 0, withdrawn: 0 };
  for (const a of await proposedOf(ctx, PROPOSE_QUESTION_ACTION, deps)) {
    const q = parseQuestion(await store.get("q", a.target.id).catch(() => null));
    if (q?.status === "decided") {
      const r = await transitionAgentAction(ctx, a.id, { to: "acted", by: { type: "system", id: SIGNALS_AGENT }, at: now, expectRev: a.rev, result: { questionId: q.id }, clearDetails: true }, { db: deps.db });
      if (r.ok) out.acted += 1;
    } else if (!q || q.mergedInto) {
      if (await declineAs(ctx, a, "superseded", deps)) out.declined += 1;
    } else if (q.status === "dismissed") {
      if (await declineAs(ctx, a, "dismissed", deps)) out.declined += 1;
    } else if (a.expiresAt <= now) {
      if (await withdrawQuestion(ctx, q.id, deps)) out.withdrawn += 1;
      if (await declineAs(ctx, a, "expired", deps)) out.declined += 1;
    } else if (deps.notPlanning?.has(sourceOf(a).connectionId ?? "")) {
      // Its connection no longer feeds planning: the whole team sees the map, so it goes now.
      if (await withdrawQuestion(ctx, q.id, deps)) out.withdrawn += 1;
      if (await declineAs(ctx, a, "stale", deps)) out.declined += 1;
    }
  }
  const cutoff = new Date(nowDate.getTime() - EXPIRY_DAYS * DAY_MS).toISOString();
  for (const id of connectionIds) {
    const proposed = await store.find("q", { where: [["fromConnectionId", "==", id]], limit: 500 }).catch(() => []);
    const stopped = deps.notPlanning?.has(id) ?? false;
    for (const raw of proposed) {
      const q = parseQuestion(raw);
      if (q?.status === "proposed" && (stopped || (q.createdAt && q.createdAt <= cutoff)) && (await withdrawQuestion(ctx, q.id, deps))) out.withdrawn += 1;
    }
  }
  return out;
}

/**
 * Every undecided question a connection proposed, withdrawn (Disconnect, Change property and the
 * purge, whatever any switch says). Decided ones stay: a person adopted them. With `questionIds`,
 * only those (an old generation's); else every one found by the connection.
 */
export async function withdrawProposedBy(ctx: TenantContext, connectionId: string, questionIds: readonly string[] | "all", deps: ReconcileDeps = {}): Promise<number> {
  const ids =
    questionIds === "all"
      ? (await brandMapRecords(ctx, deps.db).find("q", { where: [["fromConnectionId", "==", connectionId]], limit: 500 }).catch(() => [])).map((r) => String(r.ref))
      : [...questionIds];
  let n = 0;
  for (const id of new Set(ids)) if (await withdrawQuestion(ctx, id, deps)) n += 1;
  return n;
}

/**
 * The questions a connection proposed that someone dismissed keep their own words (so the same
 * search isn't proposed again), but lose the search's words and numbers they came with (`evidence`
 * and `reason`) when the connection's data is erased. Decided ones keep theirs: a person adopted
 * them. Returns how many.
 */
export async function blankDismissedFrom(ctx: TenantContext, connectionId: string, deps: ReconcileDeps = {}): Promise<number> {
  const store = brandMapRecords(ctx, deps.db);
  const found = await store.find("q", { where: [["fromConnectionId", "==", connectionId]], limit: 500 }).catch(() => []);
  let n = 0;
  for (const raw of found) {
    const q = parseQuestion(raw);
    if (!q || q.status !== "dismissed" || q.from !== "search_console" || (!q.reason && !q.evidence)) continue;
    const done = await store.claim("q", q.id, (cur) => (cur.status === "dismissed" ? { reason: "", evidence: "" } : null)).catch(() => null);
    if (done) n += 1;
  }
  return n;
}
