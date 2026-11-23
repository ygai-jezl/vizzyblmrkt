import { pageAgentActions } from "@/lib/ontology/agentActions";
import { transitionAgentAction, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { AgentAction } from "@/lib/types/agentAction";
import { DATA_SIGNAL_ACTION, SIGNALS_AGENT } from "./names";

/**
 * Keeping suggestions from collected numbers in step (Connectors 2 group 4, ADR-0012): the lane's
 * housekeeping, run whenever CONNECTORS_ENABLED is on, whatever CONNECTOR_SIGNALS_ENABLED says, so
 * a suggestion's values never outlive its 30 days even with signals turned off.
 *
 * - Expiry: every open suggestion from `connector_signals` past its expiry is declined as expired,
 *   its values cleared with the decision. Only this agent's: the lifecycle tick expires the rest.
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

/** Decline this agent's Review suggestions past their expiry. Returns how many. */
export async function expireConnectorSignals(ctx: TenantContext, deps: ReconcileDeps = {}): Promise<{ expired: number }> {
  const now = (deps.now ?? new Date()).toISOString();
  let expired = 0;
  for (const a of await proposedOf(ctx, DATA_SIGNAL_ACTION, deps)) {
    if (a.expiresAt > now) continue;
    if (await declineAs(ctx, a, "expired", deps)) expired += 1;
  }
  return { expired };
}
