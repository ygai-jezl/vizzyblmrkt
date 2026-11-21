import { forTenant, isRateLimited, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { isContactPersonId } from "@/lib/ontology/person";
import { isVizzyFieldType, liveOptions, type FieldValue, type RecordField } from "@/lib/types/recordField";
import { readFieldList } from "./fieldList";
import { valueText } from "./fields";
import { openFieldSuggestions } from "./fieldSuggestions";
import { identityScrubber, type IdentityScrubber } from "./identityScrubber";
import { isVizzyFieldsEnabled } from "./peopleFlags";

/**
 * What Vizzy may read about fields (AUDIENCE_VIZZY_FIELDS_ENABLED): the brand's People fields of
 * the seven safe types (select, multi select, status, checkbox, number, currency and date), and
 * one person's values of those types. Never text, email, phone, link or team member values, which
 * can hold who someone is, and never their name or address. Works for anyone in People: someone
 * who only joined a launch, or was added by hand, as well as a product's users. Auth is the
 * signed canvas token, which names the brand.
 */

export type ApiResult = { status: number; body: unknown };

/** A read is one or two documents; plenty for a chat that looks at a few people. */
const READ_LIMIT = { prefix: "audience_agent_fields", burstLimit: 20, hourlyLimit: 300 };

/** How each type's value is written, for Vizzy to read and to suggest. */
const VALUE_SHAPES =
  "Values: select and status take one option id, multi select a list of option ids, checkbox true or false, number a number, currency whole minor units of the field's currency (1250 means 12.50 USD, and 1250 JPY means 1250 yen, since the yen has no minor unit), date a day as YYYY-MM-DD. null clears a value.";

/** 503 while off or without the signing key, 401 for a token that doesn't verify; the brand comes from the token. */
export function vizzyFieldsAgentGate(req: Request): { ok: true; ctx: TenantContext } | { ok: false; result: ApiResult } {
  if (!isVizzyFieldsEnabled()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  return { ok: true, ctx: tenantContextFromCanvasToken(verified.claims) };
}

/** The People fields Vizzy may see: in use, of the seven types. */
export function vizzyFields(items: readonly RecordField[]): RecordField[] {
  return items.filter((f) => !f.archivedAt && isVizzyFieldType(f.type));
}

/** A field as Vizzy reads it: its id, name, type, live options and currency. Scrubbed when it is about one person. */
function describe(f: RecordField, scrub: (s: string) => string = (s) => s) {
  return {
    id: f.key,
    label: scrub(f.label),
    type: f.type,
    ...(f.options ? { options: liveOptions(f).map((o) => ({ id: o.id, label: scrub(o.label) })) } : {}),
    ...(f.currency ? { currency: f.currency } : {}),
  };
}

/** A value as Vizzy reads it: a date stays a day, the rest in words. */
function words(f: RecordField, v: FieldValue): string {
  return f.type === "date" ? String(v) : valueText(f, v);
}

/** The brand's People fields of the seven types, with no values. */
export async function agentFieldList(ctx: TenantContext, db?: FirestoreLike): Promise<ApiResult> {
  if (await isRateLimited(`tenant:${ctx.tenantId}`, READ_LIMIT, { db })) return { status: 429, body: { error: "rate_limited" } };
  const list = await readFieldList(ctx, "person", db);
  return { status: 200, body: { fields: vizzyFields(list.items).map((f) => describe(f)), note: VALUE_SHAPES } };
}

/** The scrubber for one contact: their name and address taken out of anything sent about them. */
function contactScrubber(c: { firstName?: string | null; lastName?: string | null; email?: string | null }): IdentityScrubber {
  return identityScrubber({ name: [c.firstName, c.lastName].filter(Boolean).join(" "), email: c.email ?? null });
}

/**
 * One person's values of the seven types, every such field listed (null when unset), with the
 * fields that already have a suggestion waiting. The person is our id for them (`ct_`); anything
 * else, or nobody, is `person_not_found`.
 */
export async function agentPersonFields(ctx: TenantContext, personId: string, db?: FirestoreLike): Promise<ApiResult> {
  if (await isRateLimited(`tenant:${ctx.tenantId}`, READ_LIMIT, { db })) return { status: 429, body: { error: "rate_limited" } };
  if (!isContactPersonId(personId)) return { status: 404, body: { error: "person_not_found" } };
  const contact = await forTenant(ctx, db).contacts.getById(personId);
  if (!contact) return { status: 404, body: { error: "person_not_found" } };
  const [list, open] = await Promise.all([readFieldList(ctx, "person", db), openFieldSuggestions(ctx, personId, db)]);
  const scrub = contactScrubber(contact);
  const values = (contact.fields ?? {}) as Record<string, FieldValue>;
  const fields = vizzyFields(list.items).map((f) => {
    const v = values[f.key];
    const set = v !== undefined && v !== null;
    return { ...describe(f, scrub), value: set ? v : null, text: set ? scrub(words(f, v)) : null };
  });
  const shown = new Set(fields.map((f) => f.id));
  const waiting = [...new Set(open.flatMap((a) => a.fieldIds))].filter((id) => shown.has(id));
  return {
    status: 200,
    body: {
      personId,
      fields,
      waiting,
      note: `${VALUE_SHAPES} "waiting" lists fields that already have a suggestion for someone to confirm: a new suggestion for one of them replaces it.`,
    },
  };
}
