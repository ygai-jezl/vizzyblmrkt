import { createHash } from "node:crypto";
import type { Made } from "@/lib/types/loopStamp";
import { forTenant, proposeAgentAction, transitionAgentAction, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { deterministicAgentActionId } from "@/lib/crm/identifiers";
import { getAgentAction, listAgentActionsForPerson } from "@/lib/ontology/agentActions";
import { isContactPersonId, type ContactPersonId } from "@/lib/ontology/person";
import { jsonBytes } from "@/lib/ontology/events";
import { AGENT_ACTION_LIMITS, agentDedupeKey, isAgentActionId, type AgentAction, type AgentActionId } from "@/lib/types/agentAction";
import { checkFieldValue, cutText, sameFieldValue, VIZZY_TEXT_CHARS, vizzyReadsField, type FieldType, type FieldValue, type RecordField } from "@/lib/types/recordField";
import { readFieldList } from "./fieldList";
import { setFieldValues, valueText } from "./fields";
import { holdsScrubbedMark, identityScrubber } from "./identityScrubber";
import { personHref } from "./paths";
import { isVizzyTextFieldsEnabled } from "./peopleFlags";

/**
 * Vizzy's field suggestions (AUDIENCE_VIZZY_FIELDS_ENABLED): one agent action per suggestion, of
 * action `person_fields.suggest`, about one person. Vizzy proposes through the `person_fields`
 * canvas kind; someone on the team confirms, dismisses or undoes it on the person's page or from
 * Review. Nothing changes until then.
 *
 * - Only fields Vizzy may read (vizzyReadsField), in use, values their type allows. A text value
 *   is at most VIZZY_TEXT_CHARS and holds none of the scrubber's marks (vizzyValueFits). A text
 *   value Vizzy read cut (vizzyTextView) can be cleared, never written over.
 * - A suggestion too big to save as an agent action is refused (`too_large`), before anything
 *   waiting is replaced.
 * - The proposal holds the suggested values under `fields` and a short reason; the basis holds the
 *   values when it was made, also under `fields`, so confirming can refuse a stale one and an
 *   erased field is blanked in place.
 * - A suggestion for a field that already has one waiting replaces it (the old one is declined as
 *   superseded). The same suggestion from the same values again answers with the one there is,
 *   or, once a person decided it (confirmed or dismissed it), says so and saves nothing. One set
 *   aside by nobody (replaced by a newer one, out of time, or out of date) can be made again.
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
  | "too_large"
  | "already_decided";

/**
 * Whether a value Vizzy wrote fits what Vizzy may write, beyond its type: a text value of at most
 * VIZZY_TEXT_CHARS, with none of the scrubber's marks (`[name]`, `[email]`, `[id]`), so a scrubbed
 * value Vizzy read can never be saved over the real one. Other types always fit. Pure.
 */
export function vizzyValueFits(field: Pick<RecordField, "type">, value: FieldValue | null): boolean {
  if (field.type !== "text" || typeof value !== "string") return true;
  return value.length <= VIZZY_TEXT_CHARS && !holdsScrubbedMark(value);
}

/**
 * A stored text value as Vizzy reads it: through the person's scrubber first, then cut to
 * VIZZY_TEXT_CHARS, so a cut never leaves part of a name behind, and whether it was cut. Pure.
 */
export function vizzyTextView(scrub: (s: string) => string, stored: unknown): { text: string; cut: boolean } {
  return cutText(scrub(String(stored)), VIZZY_TEXT_CHARS);
}

/** Whether a proposal and its basis fit an agent action (AGENT_ACTION_LIMITS). */
export function fitsAgentAction(proposal: unknown, basis: unknown): boolean {
  return jsonBytes(proposal) <= AGENT_ACTION_LIMITS.proposalBytes && (basis == null || jsonBytes(basis) <= AGENT_ACTION_LIMITS.basisBytes);
}

export type SuggestResult =
  | { ok: true; outcome: "created" | "open"; action: AgentAction; fields: number; superseded: number }
  | { ok: false; error: SuggestError; fieldId?: string };

/** Values in a stable order, for the dedupe hash. */
function stable(values: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v]);
}

/**
 * The key that names this suggestion: the person, and a hash of what it changes from what. `round`
 * counts the earlier ones with the same key that nobody decided (each set aside), so it can be made
 * again under a key of its own; round 0 has no suffix.
 */
function dedupeKeyOf(personId: string, proposed: Record<string, FieldValue | null>, basis: Record<string, FieldValue | null>, round = 0): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([stable(proposed), stable(basis)]))
    .digest("hex")
    .slice(0, 32);
  return round ? agentDedupeKey(PERSON_FIELDS_ACTION, personId, hash, `r${round}`) : agentDedupeKey(PERSON_FIELDS_ACTION, personId, hash);
}

/** How many times the same suggestion may be set aside by nobody and made again. */
const MAX_ROUNDS = 50;

/**
 * Whether a person decided a suggestion: confirmed it (undone or not) or dismissed it. One declined
 * as superseded, expired or stale was set aside without anyone deciding the change itself.
 */
function decidedByAPerson(a: AgentAction): boolean {
  return a.state === "acted" || a.state === "undone" || (a.state === "declined" && a.declined?.reason === "dismissed");
}

/**
 * Save Vizzy's suggestion for one person's fields, as an agent action someone confirms. Checks
 * each change against the field list as it is now; leaves out a value that is already what it
 * suggests. `why` is scrubbed of their name and address and cut to SUGGESTION_WHY_CHARS.
 */
export async function suggestFieldChanges(
  ctx: TenantContext,
  input: { personId: string; changes: Record<string, unknown>; why?: string | null },
  /** `made`: the canvas route's stamp, kept on the suggestion (learning loops step 5). */
  deps: { db?: FirestoreLike; nowMs?: number; made?: Made } = {},
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
  const textFields = isVizzyTextFieldsEnabled();
  const scrub = identityScrubber({ name: [contact.firstName, contact.lastName].filter(Boolean).join(" "), email: contact.email ?? null });

  const proposed: Record<string, FieldValue | null> = {};
  const basis: Record<string, FieldValue | null> = {};
  for (const [fieldId, raw] of entries) {
    const field = byId.get(fieldId);
    if (!field) return { ok: false, error: "unknown_field", fieldId: fieldId.slice(0, 64) };
    if (field.archivedAt) return { ok: false, error: "archived_field", fieldId };
    if (!vizzyReadsField(field, textFields)) return { ok: false, error: "field_not_allowed", fieldId };
    const check = checkFieldValue(field, raw);
    if (!check.ok || !vizzyValueFits(field, check.value)) return { ok: false, error: "invalid_value", fieldId };
    const was = current[fieldId] ?? null;
    // Vizzy saw only the start of a cut text value, so it may clear it but never write over it.
    if (field.type === "text" && check.value !== null && typeof was === "string" && vizzyTextView(scrub, was).cut) return { ok: false, error: "invalid_value", fieldId };
    if (sameFieldValue(was, check.value)) continue;
    proposed[fieldId] = check.value;
    basis[fieldId] = was;
  }
  const fieldIds = Object.keys(proposed);
  if (!fieldIds.length) return { ok: false, error: "no_change" };

  const why = input.why ? scrub(input.why.replace(/\s+/g, " ").trim()).slice(0, SUGGESTION_WHY_CHARS) : "";
  // Checked before anything waiting is replaced: a proposal or basis over the limit would throw.
  if (!fitsAgentAction({ fields: proposed, why }, { fields: basis })) return { ok: false, error: "too_large" };
  const nowMs = deps.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();

  // The same suggestion from the same values: the one there is, or "already decided" once a person
  // decided it. Each earlier one set aside by nobody moves it on to the next round's key.
  let dedupeKey: string | null = null;
  for (let round = 0; round < MAX_ROUNDS && !dedupeKey; round += 1) {
    const key = dedupeKeyOf(personId, proposed, basis, round);
    const same = await getAgentAction(ctx, deterministicAgentActionId(ctx.tenantId, key), { db: deps.db });
    if (!same) dedupeKey = key;
    else if (same.state === "proposed" || same.state === "approved") return { ok: true, outcome: "open", action: same, fields: same.fieldIds.length, superseded: 0 };
    else if (decidedByAPerson(same)) return { ok: false, error: "already_decided" };
  }
  if (!dedupeKey) return { ok: false, error: "already_decided" };

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
      ...(deps.made ? { made: deps.made } : {}),
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

// --- On the person's page ----------------------------------------------------------------------

/** How long a confirmed suggestion can be undone from the page. */
export const UNDO_DAYS = 7;

export interface SuggestionLine {
  fieldId: string;
  label: string;
  /** Null for a field no longer on the list. */
  type: FieldType | null;
  /** In words; a date stays YYYY-MM-DD for the page to show in the viewer's words. Null: no value. */
  before: string | null;
  after: string | null;
}

export interface SuggestionView {
  id: AgentActionId;
  rev: number;
  state: "proposed" | "acted";
  why: string;
  lines: SuggestionLine[];
  at: string;
  actedAt: string | null;
}

function lineValue(field: RecordField | undefined, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (!field || field.type === "date") return Array.isArray(v) ? v.join(", ") : String(v);
  return valueText(field, v as FieldValue);
}

function linesOf(fields: ReadonlyMap<string, RecordField>, before: Record<string, unknown>, after: Record<string, unknown>): SuggestionLine[] {
  return Object.keys(after).map((fieldId) => {
    const field = fields.get(fieldId);
    return { fieldId, label: field?.label ?? "A field no longer in use", type: field?.type ?? null, before: lineValue(field, before[fieldId]), after: lineValue(field, after[fieldId]) };
  });
}

const fieldsUnder = (v: unknown): Record<string, unknown> => {
  const f = v && typeof v === "object" ? (v as Record<string, unknown>).fields : null;
  return f && typeof f === "object" ? (f as Record<string, unknown>) : {};
};

/**
 * What the page shows: the person's open suggestions, and those confirmed in the last UNDO_DAYS,
 * which can be undone. Equality filters only. Labels come from the field list as it is now.
 */
export async function suggestionsForPage(ctx: TenantContext, personId: ContactPersonId, deps: { db?: FirestoreLike; nowMs?: number } = {}): Promise<{ open: SuggestionView[]; confirmed: SuggestionView[] }> {
  const nowMs = deps.nowMs ?? Date.now();
  const since = new Date(nowMs - UNDO_DAYS * 86_400_000).toISOString();
  const [open, acted, list] = await Promise.all([
    openFieldSuggestions(ctx, personId, deps.db),
    listAgentActionsForPerson(ctx, personId, { state: "acted", limit: OPEN_READ, db: deps.db }),
    readFieldList(ctx, "person", deps.db),
  ]);
  const fields = new Map(list.items.map((f) => [f.key, f]));
  const view = (a: AgentAction, before: Record<string, unknown>, after: Record<string, unknown>): SuggestionView => ({
    id: a.id,
    rev: a.rev,
    state: a.state === "acted" ? "acted" : "proposed",
    why: typeof a.proposal?.why === "string" ? a.proposal.why : "",
    lines: linesOf(fields, before, after),
    at: a.createdAt,
    actedAt: a.actedAt,
  });
  return {
    open: open.map((a) => view(a, fieldsUnder(a.basis), fieldsUnder(a.proposal))),
    confirmed: acted.actions
      .filter((a) => a.action === PERSON_FIELDS_ACTION && a.undo && (a.actedAt ?? "") >= since)
      .map((a) => view(a, a.undo?.before ?? {}, fieldsUnder(a.result))),
  };
}

export type Decision = "confirm" | "dismiss" | "undo";
export type DecideError = "not_found" | "stale" | "changed" | "edited_since" | "too_old" | "too_large" | "no_user";
export type DecideResult = { ok: true; state: "acted" | "declined" | "undone" } | { ok: false; error: DecideError; fieldId?: string };

/**
 * Confirm, dismiss or undo one suggestion about this person, by the team member in `ctx`, at the
 * rev the page saw. Confirming writes the suggested values through the one writer with source
 * agent, only while each field still holds the value the suggestion was made from and Vizzy may
 * still read it (a text field an admin stopped Vizzy reading since, or text fields turned off),
 * and records agent.approved and agent.acted with the values in one transaction; a stale one is
 * set aside (declined as stale) and answers `stale`. Undo writes the earlier values back with source undo,
 * only while the fields still hold what the confirm set and for UNDO_DAYS after the confirm (as
 * the page offers it), and records agent.undone. Dismiss records agent.declined.
 */
export async function decideFieldSuggestion(
  ctx: TenantContext,
  personId: string,
  input: { id: string; rev: number; decision: Decision },
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<DecideResult> {
  const userId = ctx.userId;
  if (!userId || userId.includes("@")) return { ok: false, error: "no_user" };
  if (!isContactPersonId(personId)) return { ok: false, error: "not_found" };
  if (!isAgentActionId(input.id)) return { ok: false, error: "not_found" };
  const action = await getAgentAction(ctx, input.id, { db: deps.db });
  if (!action || action.action !== PERSON_FIELDS_ACTION || action.personId !== personId) return { ok: false, error: "not_found" };
  const by = { type: "member" as const, id: userId };
  const nowMs = deps.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();
  const setAside = async (reason: "stale" | "expired") => {
    await transitionAgentAction(ctx, action.id, { to: "declined", reason, by, at, expectRev: input.rev }, { db: deps.db }).catch(() => null);
  };

  if (input.decision === "dismiss") {
    if (action.state !== "proposed") return { ok: false, error: "changed" };
    const r = await transitionAgentAction(ctx, action.id, { to: "declined", reason: "dismissed", by, at, expectRev: input.rev }, { db: deps.db });
    return r.ok ? { ok: true, state: "declined" } : { ok: false, error: r.error === "not_found" ? "not_found" : "changed" };
  }

  if (input.decision === "confirm") {
    if (action.state !== "proposed" || action.rev !== input.rev) return { ok: false, error: "changed" };
    if (action.expiresAt <= at) {
      await setAside("expired");
      return { ok: false, error: "stale" };
    }
    const proposed = fieldsUnder(action.proposal);
    const basis = fieldsUnder(action.basis);
    const textFields = isVizzyTextFieldsEnabled();
    const r = await setFieldValues(
      ctx,
      {
        object: "person",
        recordId: personId,
        changes: proposed,
        expect: basis,
        // A field Vizzy may no longer read is never written from its suggestion: checked against
        // the list as read in the write's own transaction, so an untick a moment ago counts.
        allowField: (f) => vizzyReadsField(f, textFields),
        by,
        source: "agent",
        nowIso: at,
        agentAction: { id: action.id, transition: { to: "acted", by, at, expectRev: input.rev, result: { fields: proposed }, undo: { before: basis } } },
      },
      { db: deps.db },
    );
    if (r.ok) return { ok: true, state: "acted" };
    if (r.error === "stale" || r.error === "unknown_field" || r.error === "archived_field" || r.error === "invalid_value") {
      await setAside("stale");
      return { ok: false, error: "stale", ...(r.fieldId ? { fieldId: r.fieldId } : {}) };
    }
    if (r.error === "record_too_large") return { ok: false, error: "too_large" };
    return { ok: false, error: r.error === "not_found" || r.error === "agent_action_not_found" ? "not_found" : "changed" };
  }

  // Undo, for as long as the page offers it.
  if (action.state !== "acted" || action.rev !== input.rev || !action.undo) return { ok: false, error: "changed" };
  if ((action.actedAt ?? "") < new Date(nowMs - UNDO_DAYS * 86_400_000).toISOString()) return { ok: false, error: "too_old" };
  const r = await setFieldValues(
    ctx,
    {
      object: "person",
      recordId: personId,
      changes: action.undo.before,
      expect: fieldsUnder(action.result),
      // The values it held before the confirm, archived options and all.
      restoring: true,
      by,
      source: "undo",
      nowIso: at,
      agentAction: { id: action.id, transition: { to: "undone", by, at, expectRev: input.rev } },
    },
    { db: deps.db },
  );
  if (r.ok) return { ok: true, state: "undone" };
  if (r.error === "stale" || r.error === "unknown_field" || r.error === "archived_field" || r.error === "invalid_value") {
    return { ok: false, error: "edited_since", ...(r.fieldId ? { fieldId: r.fieldId } : {}) };
  }
  if (r.error === "record_too_large") return { ok: false, error: "too_large" };
  return { ok: false, error: r.error === "not_found" || r.error === "agent_action_not_found" ? "not_found" : "changed" };
}
