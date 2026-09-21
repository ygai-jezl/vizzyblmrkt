import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import { TENANT_FIELD } from "./repository";
import { TenantIsolationError } from "./errors";
import type { FirestoreLike, TenantContext } from "./types";
import type { ProductUser } from "@/lib/types/productUser";
import type { ProductEvent } from "@/lib/types/productEvent";

/**
 * Apply ONE inbound product message atomically. The event row is the idempotency
 * gate (its id is derived from connectionId + messageId), and it commits in the
 * SAME transaction as the product-user profile change — so a message is either
 * fully applied once or not at all, and a replay is a clean "duplicate".
 *
 * `mutate` is pure: it receives the freshest profile (or null) and returns the
 * complete next profile (or null for no change), or a rejection reason. Tenant
 * ownership is re-checked inside the transaction on both documents.
 */

type Doc<T> = Omit<T, "id" | "tenantId">;

export type ApplyOutcome =
  | { outcome: "applied" | "unchanged"; user: ProductUser | null }
  | { outcome: "duplicate" }
  | { outcome: "rejected"; reason: string };

export interface ApplyMessageArgs {
  eventId: string;
  userDocId: string;
  mutate: (current: ProductUser | null) =>
    | { next: Doc<ProductUser> | null; applied: boolean }
    | { reject: string };
  /** The event row to record, given whether the message changed anything. */
  buildEvent: (applied: boolean) => Doc<ProductEvent>;
}

export async function applyProductMessage(
  ctx: TenantContext,
  args: ApplyMessageArgs,
  db?: FirestoreLike,
): Promise<ApplyOutcome> {
  const store = db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);
  const eventRef = store.collection("product_events").doc(args.eventId);
  const userRef = store.collection("product_users").doc(args.userDocId);

  return store.runTransaction(async (txn): Promise<ApplyOutcome> => {
    const [eventSnap, userSnap] = [await txn.get(eventRef), await txn.get(userRef)];
    if (eventSnap.exists) {
      if ((eventSnap.data() ?? {})[TENANT_FIELD] !== ctx.tenantId) {
        throw new TenantIsolationError(`product_events/${args.eventId} belongs to another tenant`);
      }
      return { outcome: "duplicate" };
    }
    let current: ProductUser | null = null;
    if (userSnap.exists) {
      const data = userSnap.data() ?? {};
      if (data[TENANT_FIELD] !== ctx.tenantId) {
        throw new TenantIsolationError(`product_users/${args.userDocId} belongs to another tenant`);
      }
      current = { id: userSnap.id, ...data } as ProductUser;
    }

    const result = args.mutate(current);
    if ("reject" in result) return { outcome: "rejected", reason: result.reject };

    txn.create(eventRef, { ...args.buildEvent(result.applied), [TENANT_FIELD]: ctx.tenantId });
    if (!result.next) return { outcome: "unchanged", user: current };
    const doc = { ...result.next, [TENANT_FIELD]: ctx.tenantId };
    if (userSnap.exists) txn.set(userRef, doc);
    else txn.create(userRef, doc);
    return {
      outcome: result.applied ? "applied" : "unchanged",
      user: { id: args.userDocId, ...doc } as ProductUser,
    };
  });
}
