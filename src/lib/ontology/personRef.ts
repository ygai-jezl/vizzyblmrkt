import { isPeopleConnection, personIdOf, personKeyOf, signupPersonKey } from "@/lib/audience/personSync";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import type { Signup } from "@/lib/types/signup";
import { normalizeEmail } from "@/lib/waitlist/identifiers";
import { isOntologyPersonIdsEnabled } from "./flags";
import { isContactPersonId, type ContactPersonId } from "./person";

/**
 * The person a row is about, as the `ct_` id of their person record. The three finders are pure
 * and never read the switch, so the backfill and the repoint job use them too; they only wrap the
 * one derivation in src/lib/audience/personSync.ts. Writers always go through personStamp, which
 * does read it.
 */

/** The id when it has the `ct_` shape, else null. */
function checked(id: string): ContactPersonId | null {
  return isContactPersonId(id) ? id : null;
}

/** A sign-up's person: by its address, or its phone when it gave no address. */
export function personIdForSignup(tenantId: string, signup: Pick<Signup, "email" | "phone">): ContactPersonId | null {
  const key = signupPersonKey(signup);
  return key ? checked(personIdOf(tenantId, key)) : null;
}

/**
 * A product user's person: by their address, or their own `pu:` person until one arrives. None
 * for an erased user, or when the product is missing, a sandbox or revoked: those users are not
 * people.
 */
export function personIdForProductUser(
  tenantId: string,
  user: Pick<ProductUser, "id" | "emailNormalized"> & { status?: ProductUser["status"] },
  connection: Pick<ProductConnection, "kind" | "status"> | null | undefined,
): ContactPersonId | null {
  if (!connection || !isPeopleConnection(connection)) return null;
  if (user.status === "deleted" || !user.id) return null;
  return checked(personIdOf(tenantId, personKeyOf(user)));
}

/** The person for an address, such as the recipient of a sign-up's email. */
export function personIdForAddress(tenantId: string, address: string | null | undefined): ContactPersonId | null {
  const key = address ? normalizeEmail(address) : "";
  return key ? checked(personIdOf(tenantId, key)) : null;
}

/** The field to spread into a row as it is written: empty while the switch is off or there is no person. */
export function personStamp(id: ContactPersonId | null | undefined): { personId?: ContactPersonId } {
  if (!id || !isOntologyPersonIdsEnabled()) return {};
  return { personId: id };
}
