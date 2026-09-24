import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import { TENANT_FIELD } from "./repository";
import { TenantIsolationError } from "./errors";
import type { FirestoreLike, TenantContext } from "./types";

/**
 * The lifecycle runner's SEND CLAIM, in one transaction:
 *  - the enrolment: still leased by this run, still active, no send in flight →
 *    stamp `pendingSend` (if the process dies after the provider call, the next
 *    run sees it and records the send as `unknown` — it is never resent);
 *  - the journey's daily counter: under the cap → +1 (exact, never over).
 *
 * For an AI-line email the person's draft is read in the SAME transaction, and
 * `draft.decide` picks the version from its freshest state (so a staff decision
 * racing the send is either seen or loses cleanly). If it says not to send
 * (staff skipped it, or approval is required), the draft is updated and nothing
 * else is touched: `declined`.
 *
 * Tenant ownership is re-checked on every document inside the transaction.
 */

export type SendClaimOutcome = "claimed" | "capped" | "lost_lease" | "declined";

export interface SendClaimArgs {
  /** Where the enrolment lives: product journeys (the default) or waitlist journeys. */
  collection?: "lifecycle_enrolments" | "waitlist_enrolments";
  enrolmentId: string;
  leaseId: string;
  pendingSend: { nodeId: string; poolId: string; itemId: string; at: string };
  counter: { id: string; journeyId: string; day: string; cap: number; ttlAt: Date };
  updatedAt: string;
  draft?: {
    id: string;
    /** Pure; may run more than once (transaction retries) — the last call wins. */
    decide: (current: Record<string, unknown> | null) => { send: boolean; patch: Record<string, unknown> | null };
  };
}

export async function claimLifecycleSend(
  ctx: TenantContext,
  args: SendClaimArgs,
  db?: FirestoreLike,
): Promise<SendClaimOutcome> {
  const store = db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);
  const enrolments = args.collection ?? "lifecycle_enrolments";
  const enrolmentRef = store.collection(enrolments).doc(args.enrolmentId);
  const counterRef = store.collection("lifecycle_counters").doc(args.counter.id);
  const draftRef = args.draft ? store.collection("lifecycle_drafts").doc(args.draft.id) : null;

  return store.runTransaction(async (txn): Promise<SendClaimOutcome> => {
    const [enrolmentSnap, counterSnap] = [await txn.get(enrolmentRef), await txn.get(counterRef)];
    const draftSnap = draftRef ? await txn.get(draftRef) : null;
    if (!enrolmentSnap.exists) return "lost_lease";
    const enrolment = enrolmentSnap.data() ?? {};
    if (enrolment[TENANT_FIELD] !== ctx.tenantId) {
      throw new TenantIsolationError(`${enrolments}/${args.enrolmentId} belongs to another tenant`);
    }
    if (enrolment.leaseId !== args.leaseId || enrolment.status !== "active" || enrolment.pendingSend) {
      return "lost_lease";
    }

    let draftPatch: Record<string, unknown> | null = null;
    if (args.draft && draftRef && draftSnap) {
      let current: Record<string, unknown> | null = null;
      if (draftSnap.exists) {
        const data = draftSnap.data() ?? {};
        if (data[TENANT_FIELD] !== ctx.tenantId) {
          throw new TenantIsolationError(`lifecycle_drafts/${args.draft.id} belongs to another tenant`);
        }
        current = { id: draftSnap.id, ...data };
      }
      const decision = args.draft.decide(current);
      draftPatch = draftSnap.exists ? decision.patch : null;
      if (!decision.send) {
        if (draftPatch) txn.update(draftRef, draftPatch);
        return "declined";
      }
    }

    let sends = 0;
    if (counterSnap.exists) {
      const counter = counterSnap.data() ?? {};
      if (counter[TENANT_FIELD] !== ctx.tenantId) {
        throw new TenantIsolationError(`lifecycle_counters/${args.counter.id} belongs to another tenant`);
      }
      sends = typeof counter.sends === "number" ? counter.sends : 0;
    }
    if (sends >= args.counter.cap) return "capped";

    txn.update(enrolmentRef, { pendingSend: args.pendingSend, updatedAt: args.updatedAt });
    if (draftPatch && draftRef) txn.update(draftRef, draftPatch);
    if (counterSnap.exists) {
      txn.update(counterRef, { sends: sends + 1 });
    } else {
      txn.create(counterRef, {
        [TENANT_FIELD]: ctx.tenantId,
        journeyId: args.counter.journeyId,
        day: args.counter.day,
        sends: 1,
        enrolments: 0,
        ttlAt: args.counter.ttlAt,
      });
    }
    return "claimed";
  });
}
