import { eraseHistory, forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { personIdOf, PRODUCT_USER_KEY_PREFIX } from "@/lib/audience/personSync";
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
 * After a product user's erase: when the person record for their key went with them (it only
 * ever came from products), erase that person's history too. Nothing when the record is still
 * there (it belongs to someone who is still a person), or when there is no key.
 */
export async function forgetGonePersonHistory(
  ctx: TenantContext,
  personKey: string | null,
  opts: { db?: FirestoreLike } = {},
): Promise<{ events: number; agentActions: number } | null> {
  if (!personKey) return null;
  const personId = personIdOf(ctx.tenantId, personKey);
  if (await forTenant(ctx, opts.db).contacts.getById(personId)) return { events: 0, agentActions: 0 };
  return eraseHistory(ctx, { personId }, { db: opts.db });
}
