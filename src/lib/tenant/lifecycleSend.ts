import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import { TENANT_FIELD } from "./repository";
import { TenantIsolationError } from "./errors";
import type { FirestoreLike, TenantContext } from "./types";

/**
 * The lifecycle runner's SEND CLAIM, in one transaction across two documents:
 *  - the enrolment: still leased by this run, still active, no send in flight →
 *    stamp `pendingSend` (if the process dies after the provider call, the next
 *    run sees it and records the send as `unknown` — it is never resent);
 *  - the journey's daily counter: under the cap → +1 (exact, never over).
 *
 * Tenant ownership is re-checked on both documents inside the transaction.
 */

export type SendClaimOutcome = "claimed" | "capped" | "lost_lease";

export interface SendClaimArgs {
  enrolmentId: string;
  leaseId: string;
  pendingSend: { nodeId: string; poolId: string; itemId: string; at: string };
  counter: { id: string; journeyId: string; day: string; cap: number; ttlAt: Date };
  updatedAt: string;
}

export async function claimLifecycleSend(
  ctx: TenantContext,
  args: SendClaimArgs,
  db?: FirestoreLike,
): Promise<SendClaimOutcome> {
  const store = db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);
  const enrolmentRef = store.collection("lifecycle_enrolments").doc(args.enrolmentId);
  const counterRef = store.collection("lifecycle_counters").doc(args.counter.id);

  return store.runTransaction(async (txn): Promise<SendClaimOutcome> => {
    const [enrolmentSnap, counterSnap] = [await txn.get(enrolmentRef), await txn.get(counterRef)];
    if (!enrolmentSnap.exists) return "lost_lease";
    const enrolment = enrolmentSnap.data() ?? {};
    if (enrolment[TENANT_FIELD] !== ctx.tenantId) {
      throw new TenantIsolationError(`lifecycle_enrolments/${args.enrolmentId} belongs to another tenant`);
    }
    if (enrolment.leaseId !== args.leaseId || enrolment.status !== "active" || enrolment.pendingSend) {
      return "lost_lease";
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
