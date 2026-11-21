import type { TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { listAgentActionsForPerson } from "@/lib/ontology/agentActions";
import type { ContactPersonId } from "@/lib/ontology/person";
import type { AgentAction } from "@/lib/types/agentAction";

/**
 * Vizzy's field suggestions (AUDIENCE_VIZZY_FIELDS_ENABLED): one agent action per suggestion, of
 * action `person_fields.suggest`, about one person. Vizzy proposes through the `person_fields`
 * canvas kind; someone on the team confirms, dismisses or undoes it on the person's page or from
 * Review. Nothing changes until then.
 */

export const PERSON_FIELDS_ACTION = "person_fields.suggest";

/** The most open actions read for one person: every action expires, so a person's open ones stay few. */
const OPEN_READ = 200;

/** A person's open field suggestions, newest first, by equality filters only (no composite index). */
export async function openFieldSuggestions(ctx: TenantContext, personId: ContactPersonId, db?: FirestoreLike): Promise<AgentAction[]> {
  const page = await listAgentActionsForPerson(ctx, personId, { state: "proposed", limit: OPEN_READ, db });
  const now = new Date().toISOString();
  return page.actions.filter((a) => a.action === PERSON_FIELDS_ACTION && a.expiresAt > now);
}
