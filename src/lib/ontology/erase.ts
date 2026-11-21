import { eraseHistory, forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { personIdOf, PRODUCT_USER_KEY_PREFIX, syncPerson } from "@/lib/audience/personSync";
import { personAfterProductErase } from "@/lib/audience/personHooks";
import type { ContactPersonId } from "./person";

/**
 * Erasing the event history and agent actions of people who are reached through a product user,
 * whatever any switch says (ONTOLOGY_PERSON_IDS_ENABLED included).
 *
 * Why the pu: id: a product user with no address is their own person, keyed `pu:<productUserId>`.
 * When they give an address, the sync moves them to the address's person and deletes the pu:
 * record (src/lib/audience/personSync.ts), and their key from then on is the address. Rows written
 * about the pu: person stay under its id until 0c's repoint job moves them, which it does only
 * while its switch is on. The pu: person's id is always the same hash of the brand and the
 * product user, whether or not that record still exists, so it is the one way back to those rows.
 */

/** The id a product user's own pu: person always has. */
export function productUserPersonId(tenantId: string, productUserId: string): ContactPersonId {
  return personIdOf(tenantId, `${PRODUCT_USER_KEY_PREFIX}${productUserId}`) as ContactPersonId;
}

/**
 * After a product user's erase: when the person for their key goes with them (no sign-up and no
 * other product user keeps them, and their record, if any, only ever came from products), erase
 * that person's history too. Nothing for someone who is still a person, or when there is no key.
 *
 * Decided from the person's sources, as the person sync decides (its dry run, which writes
 * nothing and reads no switch), never from whether the record is still there: the record can go
 * later, at the sweep after a sync that failed, or once person links are turned on, and then
 * nothing else would erase what is filed under it.
 */
export async function forgetGonePersonHistory(
  ctx: TenantContext,
  personKey: string | null,
  opts: { db?: FirestoreLike } = {},
): Promise<{ events: number; agentActions: number } | null> {
  if (!personKey) return null;
  const person = await syncPerson(ctx, personKey, { db: opts.db, dryRun: true, erase: true });
  if (!person.personId) return null;
  if (person.outcome !== "deleted" && person.outcome !== "none") return { events: 0, agentActions: 0 };
  return eraseHistory(ctx, { personId: person.personId }, { db: opts.db });
}

/** The most earlier people of one product user read for their erase. */
const LEFT_BEHIND_READ = 200;

/**
 * The keys of the people a product user left behind on a move, other than `currentKey`: their own
 * pu: person, and the person for each address they had before (from person_moves, written while
 * ONTOLOGY_PERSON_IDS_ENABLED is on, which fields need). A sync keeps such a person while it holds
 * the team's field values, so their erase has to find them. Read before the product user's history
 * (their moves included) is erased.
 */
export async function leftBehindPersonKeys(
  ctx: TenantContext,
  productUserId: string,
  currentKey: string | null,
  opts: { db?: FirestoreLike } = {},
): Promise<string[]> {
  const repo = forTenant(ctx, opts.db);
  const keys = new Set<string>([`${PRODUCT_USER_KEY_PREFIX}${productUserId}`]);
  const moves = await repo.personMoves.find({ where: [["productUserId", "==", productUserId]], limit: LEFT_BEHIND_READ });
  const from = [...new Set(moves.map((m) => m.fromPersonId))];
  for (const contact of await Promise.all(from.map((id) => repo.contacts.getById(id)))) if (contact?.contactKey) keys.add(contact.contactKey);
  if (currentKey) keys.delete(currentKey);
  return [...keys];
}

/**
 * After a product user's erase: each person they left behind (leftBehindPersonKeys) goes when
 * nothing else keeps them (no sign-up, no other product user, not added by hand), field values
 * and all, and with them their history. Someone still a person stays.
 */
export async function forgetLeftBehindPeople(ctx: TenantContext, keys: readonly string[], opts: { db?: FirestoreLike; nowMs?: number } = {}): Promise<void> {
  for (const key of keys) {
    await personAfterProductErase(ctx, key, opts);
    await forgetGonePersonHistory(ctx, key, { db: opts.db });
  }
}
