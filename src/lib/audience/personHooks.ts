import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import type { Signup } from "@/lib/types/signup";
import { normalizeEmail } from "@/lib/waitlist/identifiers";
import { isPersonLinksEnabled } from "./flags";
import {
  flagPeopleIn,
  isPeopleConnection,
  loadPeopleConnections,
  markNeedsSync,
  personKeyOf,
  signupPersonKey,
  syncPersonSafe,
  syncProductLinkSafe,
} from "./personSync";

/** How many people one batch of product writes syncs at once. */
const BATCH_CONCURRENCY = 8;

/**
 * Where the write paths keep the person record up to date (AUDIENCE_PERSON_LINKS_ENABLED).
 * Each does nothing while the switch is off and never throws: a sync that fails flags
 * the person for the lifecycle tick's sweep.
 */

interface HookDeps {
  db?: FirestoreLike;
  nowMs?: number;
}

/** After a sign-up is recorded, confirmed, offboarded or removed. */
export async function personAfterSignup(ctx: TenantContext, signup: Pick<Signup, "email" | "phone">, deps: HookDeps = {}): Promise<void> {
  if (!isPersonLinksEnabled()) return;
  await syncPersonSafe(ctx, signupPersonKey(signup), deps);
}

/**
 * After an address opts out of email, or an unsubscribe is lifted. Webhooks bring these in
 * batches, so the person is only flagged: the lifecycle tick rebuilds them within minutes.
 * Sends never wait on this: they check the opt-outs themselves.
 */
export async function personAfterOptOut(ctx: TenantContext, email: string, deps: HookDeps = {}): Promise<void> {
  if (!isPersonLinksEnabled()) return;
  await markNeedsSync(ctx, normalizeEmail(email), deps.db);
}

/**
 * After product users were written. `previousKey` is the person they belonged to before
 * the write, when their address may have changed. Writes that changed nothing are skipped.
 */
export async function personAfterProductWrites(
  ctx: TenantContext,
  connection: ProductConnection,
  writes: ReadonlyArray<{ user: ProductUser; previousKey?: string | null; quiet?: boolean }>,
  deps: HookDeps = {},
): Promise<void> {
  if (!isPersonLinksEnabled() || !isPeopleConnection(connection)) return;
  const changed = writes.filter((w) => !w.quiet);
  if (changed.length === 0) return;
  const connections = await loadPeopleConnections(ctx, deps.db).catch(() => undefined);
  // A batch of a hundred, a few at a time, so the product's request isn't held up by each in turn.
  let next = 0;
  const worker = async () => {
    while (next < changed.length) {
      const w = changed[next++]!;
      await syncProductLinkSafe(ctx, connection, w.user, { ...deps, connections, previousKey: w.previousKey ?? null });
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, changed.length) }, worker));
}

/** After a product is revoked: its people lose the link (and go, if it was all they had) at the next sweep. */
export async function personAfterProductRevoked(ctx: TenantContext, connectionId: string, deps: HookDeps = {}): Promise<void> {
  if (!isPersonLinksEnabled()) return;
  await flagPeopleIn(ctx, `product:${connectionId}`, deps.db).catch((err) => {
    console.warn(`[audience] flagging a revoked product's people failed tenant=${ctx.tenantId}:`, err instanceof Error ? err.message : "error");
  });
}

/** The person key a product user had before a write: null for one we didn't hold. */
export function previousPersonKey(before: ProductUser | null | undefined): string | null {
  return before && before.status === "active" ? personKeyOf(before) : null;
}

/** After a product user is erased: their person loses the link, and goes if nothing else is left. */
export async function personAfterProductErase(ctx: TenantContext, key: string | null, deps: HookDeps = {}): Promise<void> {
  if (!isPersonLinksEnabled() || !key) return;
  await syncPersonSafe(ctx, key, deps);
}
