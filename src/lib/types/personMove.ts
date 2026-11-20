import type { ContactPersonId } from "@/lib/ontology/person";

/**
 * A product user moved from one person to another (`person_moves`, the brand's regional database,
 * ONTOLOGY_PERSON_IDS_ENABLED). Written by src/lib/ontology/moves.ts after a product write:
 *
 * - `record.merged`: a product user known only as their own `pu:` person gave an address, and
 *   joined the person for it;
 * - `record.repointed`: their address changed or went, so they belong to another person now.
 *
 * Their rows (product events, enrolments, plans, sends and email events) follow them: the
 * person_repoint job moves them and then marks the move done. The event fields never change; only
 * `repoint` goes from pending to done. Ids only, never an address. Erased and exported with the
 * product user and with either person.
 */
export interface PersonMove {
  /** `mv_` and a hash of the brand, the write's message id and the product user: one per write. */
  id: string;
  tenantId: string;
  kind: "record.merged" | "record.repointed";
  /** The person they belonged to before the write. */
  fromPersonId: ContactPersonId;
  /** The person they belong to after it. */
  personId: ContactPersonId;
  productUserId: string;
  connectionId: string;
  /** When the write happened, ISO 8601. */
  at: string;
  /** Pending until the repoint job has moved their rows. */
  repoint: "pending" | "done";
  createdAt: string;
}
