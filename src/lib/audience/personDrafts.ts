import { randomUUID } from "node:crypto";
import { forTenant, proposeAgentAction, transitionAgentAction, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { deterministicAgentActionId } from "@/lib/crm/identifiers";
import { getAgentAction, listAgentActionsForPerson } from "@/lib/ontology/agentActions";
import { isContactPersonId, type ContactPersonId } from "@/lib/ontology/person";
import { agentDedupeKey, isAgentActionId, type AgentAction, type AgentActionId } from "@/lib/types/agentAction";
import { checkFieldValue, liveOptions, sameFieldValue, VIZZY_TEXT_CHARS, vizzyReadsField, type FieldValue, type RecordField } from "@/lib/types/recordField";
import { normalizeEmail } from "@/lib/waitlist/identifiers";
import { newPersonKey } from "./addPerson";
import { readFieldList } from "./fieldList";
import { fitsAgentAction, vizzyValueFits } from "./fieldSuggestions";
import { parseNewPerson, type NewPersonError } from "./newPerson";
import { isVizzyTextFieldsEnabled } from "./peopleFlags";
import { personIdOf } from "./personSync";

/**
 * Vizzy's New person drafts (AUDIENCE_VIZZY_ADD_PERSON_ENABLED): asked to add someone, Vizzy saves
 * what the user typed as an agent action of action `new_person.draft`, which an admin opens as the
 * New person form, checks and confirms. Vizzy never records consent: the draft holds none and the
 * form starts at Not yet.
 *
 * - The draft's person is `personIdOf(key)`, worked out exactly as New person does (the
 *   normalised address, else the trimmed phone), so erasing that person finds it, and the address
 *   is not stored a second time anywhere else.
 * - The details sit in the proposal and are cleared when it closes: confirmed (acted, keeping only
 *   the new person's id), dismissed, or declined as expired by the tick after 7 days.
 * - Someone already in People gets no draft: Vizzy is told, and links to their page.
 * - Field values only of fields Vizzy may read (vizzyReadsField), named by label or id; an option
 *   by its label or id. A text value is at most VIZZY_TEXT_CHARS with none of the scrubber's marks
 *   (vizzyValueFits). Anything else is left out with a warning, and the admin types it in the form.
 * - A draft too big to save as an agent action is refused (`too_large`), before one waiting is
 *   replaced.
 */

export const NEW_PERSON_ACTION = "new_person.draft";
export const DRAFT_DAYS = 7;

/** What a draft fills in. */
export interface DraftDetails {
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  /** By field id, as the form takes them. */
  fields: Record<string, FieldValue>;
}

/** Where the form opens filled in from a draft: the People list, with the draft's id only. */
export function draftHref(id: string): string {
  return `/admin/crm?draft=${encodeURIComponent(id)}`;
}

export type DraftError = NewPersonError | "too_large";

export type DraftResult =
  | { ok: true; outcome: "created" | "open"; action: AgentAction; fields: number; warnings: string[] }
  | { ok: true; outcome: "existing"; personId: ContactPersonId }
  | { ok: false; error: DraftError };

const norm = (s: string) => s.trim().toLowerCase();

/** A typed value as the field stores it: an option by its label or id, a list of them for a multi select. */
function asStored(field: RecordField, raw: unknown): unknown {
  if (field.type !== "select" && field.type !== "status" && field.type !== "multi_select") return raw;
  const options = liveOptions(field);
  const pick = (v: unknown) => (typeof v === "string" ? (options.find((o) => o.id === v || norm(o.label) === norm(v))?.id ?? v) : v);
  if (field.type === "multi_select") return Array.isArray(raw) ? raw.map(pick) : typeof raw === "string" ? [pick(raw)] : raw;
  return pick(raw);
}

/** Field values named by label or id, checked against the list; the rest become warnings. */
function draftFields(items: readonly RecordField[], typed: Record<string, unknown>, textFields: boolean): { fields: Record<string, FieldValue>; warnings: string[] } {
  const live = items.filter((f) => vizzyReadsField(f, textFields));
  const fields: Record<string, FieldValue> = {};
  const warnings: string[] = [];
  for (const [name, raw] of Object.entries(typed).slice(0, 50)) {
    const field = live.find((f) => f.key === name || norm(f.label) === norm(name));
    const shown = name.slice(0, 60);
    if (!field) {
      warnings.push(`No field you can fill in is called "${shown}": the admin can type it in the form.`);
      continue;
    }
    const check = checkFieldValue(field, asStored(field, raw));
    if (check.ok && field.type === "text" && typeof check.value === "string" && check.value.length > VIZZY_TEXT_CHARS) {
      warnings.push(`That value is too long for ${field.label}: you can fill in up to ${VIZZY_TEXT_CHARS} characters, and the admin can type it in the form.`);
    } else if (!check.ok || !vizzyValueFits(field, check.value)) warnings.push(`That value doesn't fit ${field.label}: the admin can set it in the form.`);
    else if (check.value !== null) fields[field.key] = check.value;
  }
  return { fields, warnings };
}

const sameDetails = (a: Record<string, unknown> | null, b: DraftDetails): boolean => {
  const p = (a?.person ?? {}) as Record<string, unknown>;
  const f = (a?.fields ?? {}) as Record<string, FieldValue>;
  const keys = new Set([...Object.keys(f), ...Object.keys(b.fields)]);
  return (
    (p.email ?? null) === b.email &&
    (p.phone ?? null) === b.phone &&
    (p.firstName ?? null) === b.firstName &&
    (p.lastName ?? null) === b.lastName &&
    [...keys].every((k) => sameFieldValue(f[k], b.fields[k]))
  );
};

/** A person's open drafts (equality filters only). */
async function openDrafts(ctx: TenantContext, personId: ContactPersonId, db?: FirestoreLike): Promise<AgentAction[]> {
  const page = await listAgentActionsForPerson(ctx, personId, { state: "proposed", limit: 50, db });
  return page.actions.filter((a) => a.action === NEW_PERSON_ACTION);
}

/**
 * Save what the user typed as a New person draft. Someone whose address or phone is already in
 * People gets none. The same details again answer with the draft waiting; different details for
 * the same person replace it.
 */
export async function draftNewPerson(
  ctx: TenantContext,
  input: { email?: string | null; phone?: string | null; firstName?: string | null; lastName?: string | null; fields?: Record<string, unknown> | null },
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<DraftResult> {
  const parsed = parseNewPerson({
    ...(input.email ? { email: input.email } : {}),
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.firstName ? { firstName: input.firstName } : {}),
    ...(input.lastName ? { lastName: input.lastName } : {}),
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const key = newPersonKey(parsed.value)!;
  const personId = personIdOf(ctx.tenantId, key) as ContactPersonId;
  if (await forTenant(ctx, deps.db).contacts.getById(personId)) return { ok: true, outcome: "existing", personId };

  const list = await readFieldList(ctx, "person", deps.db);
  const { fields, warnings } = draftFields(list.items, input.fields ?? {}, isVizzyTextFieldsEnabled());
  const details: DraftDetails = {
    email: parsed.value.email ? normalizeEmail(parsed.value.email) : null,
    phone: parsed.value.phone,
    firstName: parsed.value.firstName,
    lastName: parsed.value.lastName,
    fields,
  };
  const proposal = { person: { email: details.email, phone: details.phone, firstName: details.firstName, lastName: details.lastName }, fields: details.fields };
  // Checked before a waiting draft is replaced: a proposal over the limit would throw.
  if (!fitsAgentAction(proposal, null)) return { ok: false, error: "too_large" };
  const nowMs = deps.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();

  let replaced = false;
  for (const old of await openDrafts(ctx, personId, deps.db)) {
    if (sameDetails(old.proposal, details) && old.expiresAt > at) return { ok: true, outcome: "open", action: old, fields: Object.keys(fields).length, warnings };
    // Different details for the same person: the newer draft replaces it, and its details go.
    await transitionAgentAction(ctx, old.id, { to: "declined", reason: "superseded", by: { type: "agent", id: "vizzy" }, at, expectRev: old.rev, clearDetails: true }, { db: deps.db }).catch(() => null);
    replaced = true;
  }

  // A one off: each request its own key, so a dismissed draft never blocks asking again.
  const dedupeKey = agentDedupeKey(NEW_PERSON_ACTION, personId, randomUUID().replace(/-/g, ""));
  const id = deterministicAgentActionId(ctx.tenantId, dedupeKey);
  const saved = await proposeAgentAction(
    ctx,
    {
      dedupeKey,
      agent: "vizzy",
      action: NEW_PERSON_ACTION,
      target: { type: "person", id: personId },
      personId,
      proposal,
      basis: null,
      fieldIds: Object.keys(details.fields),
      signals: [],
      review: { kind: "person_suggestion", href: draftHref(id) },
      requestedBy: { type: "member", id: ctx.userId ?? null },
      expiresAt: new Date(nowMs + DRAFT_DAYS * 86_400_000).toISOString(),
      clearDetailsOnClose: true,
      at,
    },
    { db: deps.db },
  );
  if (replaced) warnings.push("It replaces the draft for this person that was waiting.");
  return { ok: true, outcome: saved.outcome === "open" ? "open" : "created", action: saved.action, fields: Object.keys(fields).length, warnings };
}

/** A draft as the form reads it, or null once it is closed, cleared or past its 7 days. */
export async function readNewPersonDraft(
  ctx: TenantContext,
  id: string,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<({ id: AgentActionId; rev: number; expiresAt: string } & DraftDetails) | null> {
  if (!isAgentActionId(id)) return null;
  const a = await getAgentAction(ctx, id, { db: deps.db });
  const at = new Date(deps.nowMs ?? Date.now()).toISOString();
  if (!a || a.action !== NEW_PERSON_ACTION || a.state !== "proposed" || !a.proposal || a.expiresAt <= at) return null;
  const p = (a.proposal.person ?? {}) as Record<string, string | null>;
  return {
    id: a.id,
    rev: a.rev,
    expiresAt: a.expiresAt,
    email: p.email ?? null,
    phone: p.phone ?? null,
    firstName: p.firstName ?? null,
    lastName: p.lastName ?? null,
    fields: (a.proposal.fields ?? {}) as Record<string, FieldValue>,
  };
}

/**
 * Close a draft once the form it filled is confirmed: acted, keeping only the id of the person
 * added (or already there), with its details cleared. A draft already closed or gone is left as it
 * is: the person is added either way.
 */
export async function closeNewPersonDraft(ctx: TenantContext, id: string, personId: string, deps: { db?: FirestoreLike; nowMs?: number } = {}): Promise<boolean> {
  if (!isAgentActionId(id) || !isContactPersonId(personId) || !ctx.userId) return false;
  const a = await getAgentAction(ctx, id, { db: deps.db });
  if (!a || a.action !== NEW_PERSON_ACTION || a.state !== "proposed") return false;
  const at = new Date(deps.nowMs ?? Date.now()).toISOString();
  const r = await transitionAgentAction(
    ctx,
    a.id,
    { to: "acted", by: { type: "member", id: ctx.userId }, at, expectRev: a.rev, result: { personId }, clearDetails: true },
    { db: deps.db },
  );
  return r.ok;
}

/** Dismiss a draft: declined, with its details cleared. False when it is no longer open. */
export async function dismissNewPersonDraft(ctx: TenantContext, id: string, deps: { db?: FirestoreLike; nowMs?: number } = {}): Promise<boolean> {
  if (!isAgentActionId(id) || !ctx.userId) return false;
  const a = await getAgentAction(ctx, id, { db: deps.db });
  if (!a || a.action !== NEW_PERSON_ACTION || a.state !== "proposed") return false;
  const at = new Date(deps.nowMs ?? Date.now()).toISOString();
  const r = await transitionAgentAction(ctx, a.id, { to: "declined", reason: "dismissed", by: { type: "member", id: ctx.userId }, at, expectRev: a.rev, clearDetails: true }, { db: deps.db });
  return r.ok;
}
