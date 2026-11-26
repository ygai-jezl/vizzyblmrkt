import { z } from "zod";
import { applyFieldListChange, newOptionId, readFieldList } from "@/lib/audience/fieldList";
import { commitSettingsChange, getTenantById, isRateLimited, type RateLimitConfig, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { EventActor } from "@/lib/ontology/events";
import type { Tenant } from "@/lib/types/tenant";
import {
  CURRENCY_CODE,
  FIELD_LIST_SUBJECT,
  FIELD_TYPE_LABEL,
  fieldListProblems,
  FieldListSchema,
  hasOptions,
  type FieldList,
  type FieldOption,
  type FieldType,
  type RecordField,
} from "@/lib/types/recordField";
import { currencyFor, isRaiseKit, kitFields, kitOptions, labelMatches, sameLabel, type FieldPreset, type RaiseKit } from "./presets";
import { SETUP_WORDS, setupMessage } from "./words";

/**
 * Set up for raising, or Set up for funding (RAISE_PIPELINE_ENABLED): one press adds the board's
 * ready-made People fields and options that are missing, as ONE settings version on `fields:person`
 * (commitSettingsChange, source "editor", by the member), and never renames, retypes, reorders or
 * removes anything the team has.
 *
 * For each field preset, in the kit's order: a live field that carries it is used; else a live field
 * named like it (its label or an alias, any case), of a type it can use, is adopted by adding the
 * marker and nothing else; else a live field with its name but another type is kept as it is and
 * noted, and that preset stays unbound (an unbound Stage means no board); else, when the team
 * archived a field that carries it or has its name, nothing is added; else the field is added.
 * Each bound option field then gets the kit's options the same way: used, adopted by name, left
 * archived, or inserted next to the nearest kit option the field holds (after the nearest earlier
 * one, else before the nearest later one, else at the end), so the team's own options keep their
 * place and order. A second press finds everything and writes nothing.
 */

export type SetupError = "field_list_full" | "invalid_field" | "fields_changed";

export interface SetupPlan {
  ok: true;
  /** The People list after the press. */
  items: RecordField[];
  addFields: Array<{ label: string; type: FieldType }>;
  addOptions: Array<{ field: string; label: string }>;
  /** The team's own fields the press uses (marked, nothing else changed). */
  adopt: Array<{ label: string }>;
  kept: Array<{ label: string; note: string }>;
  added: { fields: number; options: number };
  nothing: boolean;
}

export interface PlanOptions {
  /** ISO 4217 for a new Cheque field. */
  currency: string;
  nowIso: string;
  userId: string | null;
  newFieldId?: () => string;
  newOptionId?: () => string;
}

const markerOf = (x: { preset?: unknown }) => (typeof x.preset === "string" ? x.preset : null);

/** "select or status", "text": the types a preset can use, in words. */
function typesInWords(types: readonly FieldType[]): string {
  const words = types.map((t) => FIELD_TYPE_LABEL[t]);
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words.at(-1)}` : (words[0] ?? "");
}

/**
 * Where a kit option goes among a field's options: right after the nearest earlier kit option the
 * field holds, else right before the nearest later one, else at the end.
 */
function insertAt(options: readonly FieldOption[], kitPresets: readonly string[], k: number): number {
  const at = (preset: string) => options.findIndex((o) => markerOf(o) === preset);
  for (let i = k - 1; i >= 0; i--) {
    const j = at(kitPresets[i]!);
    if (j >= 0) return j + 1;
  }
  for (let i = k + 1; i < kitPresets.length; i++) {
    const j = at(kitPresets[i]!);
    if (j >= 0) return j;
  }
  return options.length;
}

/** The press, worked out without saving: the list after it and what it adds, uses and keeps. Pure. */
export function planRaiseSetup(items: readonly RecordField[], kit: RaiseKit, opts: PlanOptions): SetupPlan | { ok: false; error: SetupError } {
  let next: RecordField[] = [...items];
  const plan: Omit<SetupPlan, "items" | "nothing" | "ok"> = { addFields: [], addOptions: [], adopt: [], kept: [], added: { fields: 0, options: 0 } };
  const claimed = new Set<string>();
  const touched = new Set<string>();
  const madeNow = new Set<string>();
  const people = (f: RecordField) => f.object === "person";

  for (const p of kitFields(kit)) {
    let i = next.findIndex((f) => people(f) && !f.archivedAt && markerOf(f) === p.preset);
    if (i < 0) {
      const free = (f: RecordField) => people(f) && !f.archivedAt && !markerOf(f) && !claimed.has(f.key);
      const fits = (f: RecordField) => p.adopt.includes(f.type);
      i = next.findIndex((f) => free(f) && fits(f) && sameLabel(f.label, p.label));
      if (i < 0) i = next.findIndex((f) => free(f) && fits(f) && labelMatches(f.label, p));
      if (i >= 0) {
        next = next.map((f, j) => (j === i ? ({ ...f, preset: p.preset } as RecordField) : f));
        touched.add(next[i]!.key);
      } else {
        const sameName = next.find((f) => free(f) && sameLabel(f.label, p.label));
        if (sameName) {
          plan.kept.push({ label: sameName.label, note: SETUP_WORDS.keptType(sameName.label, FIELD_TYPE_LABEL[sameName.type], p.preset === "raise.stage", typesInWords(p.adopt)) });
          continue;
        }
        const archived = next.find((f) => people(f) && f.archivedAt && (markerOf(f) === p.preset || sameLabel(f.label, p.label)));
        if (archived) {
          plan.kept.push({ label: archived.label, note: SETUP_WORDS.keptArchived(archived.label) });
          continue;
        }
        const made = addField(next, p, kit, opts);
        if (!made.ok) return made;
        next = made.items;
        i = next.length - 1;
        madeNow.add(next[i]!.key);
        plan.addFields.push({ label: p.label, type: p.make });
        plan.added.fields += 1;
        for (const o of next[i]!.options ?? []) plan.addOptions.push({ field: p.label, label: o.label });
        plan.added.options += next[i]!.options?.length ?? 0;
      }
    }
    const f = next[i]!;
    claimed.add(f.key);
    if (p.preset === "raise.cheque" && f.type === "currency" && f.currency && f.currency !== opts.currency && !madeNow.has(f.key)) {
      plan.kept.push({ label: f.label, note: SETUP_WORDS.keptCurrency(f.label, f.currency) });
    }
    if (!hasOptions(f.type) || madeNow.has(f.key)) continue;
    const kitOpts = kitOptions(kit, p.preset);
    if (!kitOpts.length) continue;
    const kitPresets = kitOpts.map((o) => o.preset);
    let options = [...(f.options ?? [])];
    let changed = false;
    kitOpts.forEach((k, ki) => {
      if (options.some((o) => markerOf(o) === k.preset)) return;
      const j = options.findIndex((o) => !o.archivedAt && !markerOf(o) && labelMatches(o.label, k));
      if (j >= 0) {
        options = options.map((o, x) => (x === j ? { ...o, preset: k.preset } : o));
        changed = true;
        return;
      }
      const archived = options.find((o) => o.archivedAt && !markerOf(o) && labelMatches(o.label, k));
      if (archived) {
        plan.kept.push({ label: archived.label, note: SETUP_WORDS.keptArchivedOption(archived.label, f.label) });
        return;
      }
      // Never two options of one name: one the team already has under that name stays as it is.
      if (options.some((o) => !o.archivedAt && sameLabel(o.label, k.label))) return;
      options.splice(insertAt(options, kitPresets, ki), 0, { id: (opts.newOptionId ?? newOptionId)(), label: k.label, preset: k.preset });
      plan.addOptions.push({ field: f.label, label: k.label });
      plan.added.options += 1;
      changed = true;
    });
    if (changed) {
      next = next.map((x) => (x.key === f.key ? ({ ...x, options } as RecordField) : x));
      touched.add(f.key);
    }
  }

  for (const f of items) if (touched.has(f.key)) plan.adopt.push({ label: f.label });
  if (fieldListProblems(next, "person").length) return { ok: false, error: "field_list_full" };
  const nothing = JSON.stringify(next) === JSON.stringify(items);
  if (!nothing && !FieldListSchema.safeParse({ items: next }).success) return { ok: false, error: "invalid_field" };
  return { ok: true, items: next, ...plan, nothing };
}

/** A new field for a preset with its kit's options, each marked, through the field list's own add. */
function addField(items: RecordField[], p: FieldPreset, kit: RaiseKit, opts: PlanOptions): { ok: true; items: RecordField[] } | { ok: false; error: SetupError } {
  const kitOpts = hasOptions(p.make) ? kitOptions(kit, p.preset) : [];
  const applied = applyFieldListChange(
    "person",
    items,
    { op: "add", label: p.label, type: p.make, ...(hasOptions(p.make) ? { options: kitOpts.map((o) => o.label) } : {}), ...(p.make === "currency" ? { currency: opts.currency } : {}) },
    { nowIso: opts.nowIso, userId: opts.userId, newFieldId: opts.newFieldId, newOptionId: opts.newOptionId },
  );
  if (!applied.ok) return { ok: false, error: applied.error === "field_list_full" ? "field_list_full" : "invalid_field" };
  const made = applied.items.at(-1)!;
  // Firestore refuses an undefined value, so an option the kit doesn't name (none should) has no marker key at all.
  const markOption = (o: FieldOption): FieldOption => {
    const preset = kitOpts.find((k) => sameLabel(k.label, o.label))?.preset;
    return preset ? { ...o, preset } : o;
  };
  const marked: RecordField = { ...made, preset: p.preset, ...(made.options ? { options: made.options.map(markOption) } : {}) };
  return { ok: true, items: [...applied.items.slice(0, -1), marked] };
}

export type SetupResult =
  | { ok: true; plan: SetupPlan; rev: number; message: string }
  | { ok: false; error: SetupError };

/** How many times a press is planned again when someone saved the list at the same moment. */
const TRIES = 3;

/**
 * Press Set up for raising or funding: plan from the list as it is, then save it as one version. A
 * plan with nothing to add writes nothing. A list that moved in between is planned again from what
 * it is now, up to 3 times, then answers `fields_changed`.
 */
export async function applyRaiseSetup(
  ctx: TenantContext,
  input: { kit: RaiseKit; currency: string; by: EventActor; nowIso?: string; newFieldId?: () => string; newOptionId?: () => string },
  db?: FirestoreLike,
): Promise<SetupResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const userId = input.by.type === "member" && input.by.id ? input.by.id : null;
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const list = await readFieldList(ctx, "person", db);
    const plan = planRaiseSetup(list.items, input.kit, { currency: input.currency, nowIso, userId, newFieldId: input.newFieldId, newOptionId: input.newOptionId });
    if (!plan.ok) return plan;
    if (plan.nothing) return { ok: true, plan, rev: list.rev, message: SETUP_WORDS.nothing };
    const r = await commitSettingsChange<FieldList>(
      ctx,
      {
        subject: FIELD_LIST_SUBJECT.person,
        baseRev: list.rev,
        value: { items: plan.items },
        by: input.by,
        source: "editor",
        message: setupMessage(
          input.kit,
          plan.added,
          plan.adopt.map((a) => a.label),
        ),
        nowIso,
      },
      db,
    );
    if (r.ok) return { ok: true, plan, rev: r.rev, message: SETUP_WORDS.done(plan.added.fields, plan.added.options) };
  }
  return { ok: false, error: "fields_changed" };
}

// --- Requests ----------------------------------------------------------------------------------

export type ApiResult = { status: number; body: unknown };

export const SETUP_LIMIT: RateLimitConfig = { prefix: "raise_setup", burstLimit: 10, hourlyLimit: 60 };
export const BOARD_HREF = "/admin/crm?tab=investors";

export interface SetupDeps {
  db?: FirestoreLike;
  loadTenant?: (id: string) => Promise<Tenant | null>;
  nowIso?: string;
  newFieldId?: () => string;
  newOptionId?: () => string;
}

const Currency = z.string().regex(CURRENCY_CODE);
const PreviewQuery = z.object({ kit: z.enum(["raising", "funding"]).optional(), currency: Currency.optional() }).strict();
const PressBody = z.object({ kit: z.enum(["raising", "funding"]), currency: Currency.optional() }).strict();

const STATUS: Record<SetupError, number> = { field_list_full: 400, invalid_field: 400, fields_changed: 409 };
const LIMITED: ApiResult = { status: 429, body: { error: "rate_limited" } };

/** The kit a brand sees first: funding for a shop or a service, raising otherwise. */
export function firstKitOf(tenant: Pick<Tenant, "businessProfile"> | null): RaiseKit {
  const run = tenant?.businessProfile?.answers?.run;
  return run === "shop" || run === "service" ? "funding" : "raising";
}

const shownPlan = (p: SetupPlan) => ({ addFields: p.addFields, addOptions: p.addOptions, adopt: p.adopt, kept: p.kept, nothing: p.nothing });

/** GET the press's preview for a kit: what it would add, use and keep, and which kit to show first. Admins only. */
export async function setupPreviewRequest(ctx: TenantContext, query: Record<string, string>, deps: SetupDeps = {}): Promise<ApiResult> {
  const q = PreviewQuery.safeParse(query);
  if (!q.success) return { status: 400, body: { error: "invalid_input" } };
  if (await isRateLimited(`tenant:${ctx.tenantId}`, SETUP_LIMIT, { db: deps.db })) return LIMITED;
  const [tenant, list] = await Promise.all([(deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null), readFieldList(ctx, "person", deps.db)]);
  const firstKit = firstKitOf(tenant);
  const kit = q.data.kit ?? firstKit;
  const currency = q.data.currency ?? currencyFor(tenant?.timeZone);
  const plan = planRaiseSetup(list.items, kit, { currency, nowIso: deps.nowIso ?? new Date().toISOString(), userId: ctx.userId ?? null, newFieldId: deps.newFieldId, newOptionId: deps.newOptionId });
  if (!plan.ok) return { status: STATUS[plan.error], body: { error: plan.error } };
  return { status: 200, body: { kit, currency, plan: shownPlan(plan), firstKit } };
}

/** POST the press. Admins only. */
export async function setupRequest(ctx: TenantContext, raw: unknown, deps: SetupDeps = {}): Promise<ApiResult> {
  const body = PressBody.safeParse(raw);
  if (!body.success || !isRaiseKit(body.data.kit)) return { status: 400, body: { error: "invalid_input" } };
  if (await isRateLimited(`tenant:${ctx.tenantId}`, SETUP_LIMIT, { db: deps.db })) return LIMITED;
  const currency = body.data.currency ?? currencyFor((await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null))?.timeZone);
  const r = await applyRaiseSetup(
    ctx,
    { kit: body.data.kit, currency, by: { type: "member", id: ctx.userId ?? null }, nowIso: deps.nowIso, newFieldId: deps.newFieldId, newOptionId: deps.newOptionId },
    deps.db,
  );
  if (!r.ok) return { status: STATUS[r.error], body: { error: r.error } };
  return {
    status: 200,
    body: {
      added: r.plan.nothing ? { fields: 0, options: 0 } : r.plan.added,
      adopted: r.plan.adopt.map((a) => a.label),
      kept: r.plan.kept,
      message: r.message,
      rev: r.rev,
      boardHref: BOARD_HREF,
    },
  };
}
