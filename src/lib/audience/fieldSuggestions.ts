import { createHash } from "node:crypto";
import { forTenant, proposeAgentAction, transitionAgentAction, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { deterministicAgentActionId } from "@/lib/crm/identifiers";
import { getAgentAction, listAgentActionsForPerson } from "@/lib/ontology/agentActions";
import { isContactPersonId, type ContactPersonId } from "@/lib/ontology/person";
import { agentDedupeKey, type AgentAction } from "@/lib/types/agentAction";
import { checkFieldValue, isVizzyFieldType, sameFieldValue, type FieldValue } from "@/lib/types/recordField";
import { readFieldList } from "./fieldList";
import { identityScrubber } from "./identityScrubber";
import { personHref } from "./paths";

/**
 * Vizzy's field suggestions (AUDIENCE_VIZZY_FIELDS_ENABLED): one agent action per suggestion, of
 * action `person_fields.suggest`, about one person. Vizzy proposes through the `person_fields`
 * canvas kind; someone on the team confirms, dismisses or undoes it on the person's page or from
 * Review. Nothing changes until then.
 *
 * - Only the seven types Vizzy may read, fields in use, values their type allows.
 * - The proposal holds the suggested values under `fields` and a short reason; the basis holds the
 *   values when it was made, also under `fields`, so confirming can refuse a stale one and an
 *   erased field is blanked in place.
 * - A suggestion for a field that already has one waiting replaces it (the old one is declined as
 *   superseded). The same suggestion from the same values again answers with the one there is,
 *   or, once someone decided it, says so and saves nothing.
 */

export const PERSON_FIELDS_ACTION = "person_fields.suggest";

/** How long a suggestion waits before the tick sets it aside. */
export const SUGGESTION_DAYS = 30;
/** The most fields in one suggestion. */
export const SUGGESTION_MAX_FIELDS = 20;
/** The reason shown under it, at most. */
export const SUGGESTION_WHY_CHARS = 280;

/** The most open actions read for one person: every action expires, so a person's open ones stay few. */
const OPEN_READ = 200;

/** A person's open field suggestions, newest first, by equality filters only (no composite index). */
export async function openFieldSuggestions(ctx: TenantContext, personId: ContactPersonId, db?: FirestoreLike): Promise<AgentAction[]> {
  const page = await listAgentActionsForPerson(ctx, personId, { state: "proposed", limit: OPEN_READ, db });
  const now = new Date().toISOString();
  return page.actions.filter((a) => a.action === PERSON_FIELDS_ACTION && a.expiresAt > now);
}

export type SuggestError =
  | "person_not_found"
  | "unknown_field"
  | "archived_field"
  | "field_not_allowed"
  | "invalid_value"
  | "no_change"
  | "too_many_fields"
  | "already_decided";

export type SuggestResult =
  | { ok: true; outcome: "created" | "open"; action: AgentAction; fields: number; superseded: number }
  | { ok: false; error: SuggestError; fieldId?: string };

/** Values in a stable order, for the dedupe hash. */
function stable(values: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v]);
}

/** The key that names this suggestion: the person, and a hash of what it changes from what. */
function dedupeKeyOf(personId: string, proposed: Record<string, FieldValue | null>, basis: Record<string, FieldValue | null>): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([stable(proposed), stable(basis)]))
    .digest("hex")
    .slice(0, 32);
  return agentDedupeKey(PERSON_FIELDS_ACTION, personId, hash);
}

/**
 * Save Vizzy's suggestion for one person's fields, as an agent action someone confirms. Checks
 * each change against the field list as it is now; leaves out a value that is already what it
 * suggests. `why` is scrubbed of their name and address and cut to SUGGESTION_WHY_CHARS.
 */
export async function suggestFieldChanges(
  ctx: TenantContext,
  input: { personId: string; changes: Record<string, unknown>; why?: string | null },
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<SuggestResult> {
  if (!isContactPersonId(input.personId)) return { ok: false, error: "person_not_found" };
  const personId = input.personId;
  const entries = Object.entries(input.changes ?? {});
  if (entries.length > SUGGESTION_MAX_FIELDS) return { ok: false, error: "too_many_fields" };
  const contact = await forTenant(ctx, deps.db).contacts.getById(personId);
  if (!contact) return { ok: false, error: "person_not_found" };
  const list = await readFieldList(ctx, "person", deps.db);
  const byId = new Map(list.items.map((f) => [f.key, f]));
  const current = (contact.fields ?? {}) as Record<string, FieldValue>;

  const proposed: Record<string, FieldValue | null> = {};
  const basis: Record<string, FieldValue | null> = {};
  for (const [fieldId, raw] of entries) {
    const field = byId.get(fieldId);
    if (!field) return { ok: false, error: "unknown_field", fieldId: fieldId.slice(0, 64) };
    if (field.archivedAt) return { ok: false, error: "archived_field", fieldId };
    if (!isVizzyFieldType(field.type)) return { ok: false, error: "field_not_allowed", fieldId };
    const check = checkFieldValue(field, raw);
    if (!check.ok) return { ok: false, error: "invalid_value", fieldId };
    const was = current[fieldId] ?? null;
    if (sameFieldValue(was, check.value)) continue;
    proposed[fieldId] = check.value;
    basis[fieldId] = was;
  }
  const fieldIds = Object.keys(proposed);
  if (!fieldIds.length) return { ok: false, error: "no_change" };

  const scrub = identityScrubber({ name: [contact.firstName, contact.lastName].filter(Boolean).join(" "), email: contact.email ?? null });
  const why = input.why ? scrub(input.why.replace(/\s+/g, " ").trim()).slice(0, SUGGESTION_WHY_CHARS) : "";
  const dedupeKey = dedupeKeyOf(personId, proposed, basis);
  const nowMs = deps.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();

  // The same suggestion from the same values: the one there is, or "already decided".
  const same = await getAgentAction(ctx, deterministicAgentActionId(ctx.tenantId, dedupeKey), { db: deps.db });
  if (same && (same.state === "proposed" || same.state === "approved")) return { ok: true, outcome: "open", action: same, fields: same.fieldIds.length, superseded: 0 };
  if (same) return { ok: false, error: "already_decided" };

  // A newer suggestion for a field replaces the one waiting.
  let superseded = 0;
  for (const old of await openFieldSuggestions(ctx, personId, deps.db)) {
    if (!old.fieldIds.some((id) => fieldIds.includes(id))) continue;
    const r = await transitionAgentAction(ctx, old.id, { to: "declined", reason: "superseded", by: { type: "agent", id: "vizzy" }, at, expectRev: old.rev }, { db: deps.db });
    if (r.ok) superseded += 1;
  }

  const saved = await proposeAgentAction(
    ctx,
    {
      dedupeKey,
      agent: "vizzy",
      action: PERSON_FIELDS_ACTION,
      target: { type: "person", id: personId },
      personId,
      proposal: { fields: proposed, why },
      basis: { fields: basis },
      fieldIds,
      signals: [],
      review: { kind: "person_suggestion", href: `${personHref(personId)}#vizzy` },
      // The team member who asked in the chat, by user id.
      requestedBy: { type: "member", id: ctx.userId ?? null },
      expiresAt: new Date(nowMs + SUGGESTION_DAYS * 86_400_000).toISOString(),
      at,
    },
    { db: deps.db },
  );
  if (saved.outcome === "decided") return { ok: false, error: "already_decided" };
  return { ok: true, outcome: saved.outcome, action: saved.action, fields: fieldIds.length, superseded };
}
