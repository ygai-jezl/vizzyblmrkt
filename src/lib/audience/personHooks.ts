import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import type { Signup } from "@/lib/types/signup";
import { normalizeEmail } from "@/lib/waitlist/identifiers";
import { isPersonLinksEnabled } from "./flags";
import {
  isPeopleConnection,
  loadPeopleConnections,
  personKeyOf,
  signupPersonKey,
  syncPersonSafe,
  syncProductLinkSafe,
} from "./personSync";

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

/** After an address opts out of email, or an unsubscribe is lifted. */
export async function personAfterOptOut(ctx: TenantContext, email: string, deps: HookDeps = {}): Promise<void> {
  if (!isPersonLinksEnabled()) return;
  await syncPersonSafe(ctx, normalizeEmail(email), deps);
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
  for (const w of changed) {
    await syncProductLinkSafe(ctx, connection, w.user, { ...deps, connections, previousKey: w.previousKey ?? null });
  }
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
