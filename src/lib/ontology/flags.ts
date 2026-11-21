import { isPersonLinksEnabled } from "@/lib/audience/flags";

/**
 * Switches for the ontology in code. Server only, each off unless "true": listed "false" in
 * apphosting.yaml and turned on per deployment.
 */

/**
 * The person (a `ct_` id) written on every new send, email event, product event, enrolment and
 * plan as it is written, with the moves that follow a product user's address. Needs the person
 * links, so a row never points at a person record that isn't kept. Off: rows are written as before.
 */
export function isOntologyPersonIdsEnabled(): boolean {
  return isPersonLinksEnabled() && process.env.ONTOLOGY_PERSON_IDS_ENABLED === "true";
}
