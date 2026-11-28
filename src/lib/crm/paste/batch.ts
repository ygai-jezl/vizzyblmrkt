import { randomUUID } from "node:crypto";
import { z } from "zod";
import { forTenant, proposeAgentAction, transitionAgentAction, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { deterministicAgentActionId, deterministicCompanyId } from "@/lib/crm/identifiers";
import { readFieldList } from "@/lib/audience/fieldList";
import { fitsAgentAction } from "@/lib/audience/fieldSuggestions";
import { peopleWarning } from "@/lib/audience/newPerson";
import { isFieldsEnabled } from "@/lib/audience/peopleFlags";
import { personIdOf } from "@/lib/audience/personSync";
import { getAgentAction } from "@/lib/ontology/agentActions";
import { checkAllowance, type UsageDeps } from "@/lib/plans/usage";
import { agentDedupeKey, isAgentActionId, type AgentAction, type AgentActionId } from "@/lib/types/agentAction";
import type { FieldValue, RecordField } from "@/lib/types/recordField";
import { mapColumns } from "./columns";
import { PASTE_LIMITS, parseSheet, type ParseError } from "./parse";
import { readRows, type LeftReason, type RowRead } from "./rows";
import { isPasteBatch, PASTE_ACTION, PASTE_DAYS, pasteHref } from "./review";
import { PASTE_NOTE_CODES, type PasteNote, type RowReason } from "./words";

/**
 * Paste a list (RAISE_PASTE_ENABLED): a pasted list into one card waiting in Review, and reading
 * or dismissing that card. The rows are read by code (parse, columns, rows), checked against
 * People and Companies, and saved as one agent action an admin adds from (apply.ts).
 *
 * What is never stored, anywhere, logs included: the pasted text; every cell of a column that
 * isn't read; rows that were left out and rows already in People or Companies (counted only);
 * and on firm rows every name, title, city and profile link. The card holds only the rows it will
 * add, each with its own column of field values, and it clears them when it is added, dismissed
 * or declined as expired after 7 days.
 */

/** A row the card will add, as stored. `row` is its number in the sheet, the header being row 1. */
export type PasteRow =
  | { row: number; kind: "person"; email: string | null; phone: string | null; firstName: string | null; lastName: string | null }
  | { row: number; kind: "company"; domain: string; name: string | null };

const FieldValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

/** The card's proposal, as stored and read back. */
export const PasteProposalSchema = z.object({
  v: z.literal(1),
  /** The answer to "Where is this list from?", trimmed, one line. */
  source: z.string().min(1).max(PASTE_LIMITS.sourceChars),
  rows: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          row: z.number().int().min(2),
          kind: z.literal("person"),
          email: z.string().nullable(),
          phone: z.string().nullable(),
          firstName: z.string().nullable(),
          lastName: z.string().nullable(),
        }),
        z.object({ row: z.number().int().min(2), kind: z.literal("company"), domain: z.string().min(1), name: z.string().nullable() }),
      ]),
    )
    .max(PASTE_LIMITS.rows),
  /**
   * Field values by field id, each a map from a row's index in `rows` ("0", "2") to its value,
   * leaving out rows with none. A map, not an array: a multi select value is itself an array, and
   * Firestore stores no array directly inside another. A People field's values are for person
   * rows, a company field's for company rows. A field whose values were erased since is null
   * whole (blankFieldInAgentActions).
   */
  fields: z.record(z.string(), z.record(z.string().regex(/^(0|[1-9]\d*)$/), FieldValueSchema).nullable()),
  /** How the header was read: header names only, never a cell. */
  columns: z.object({ read: z.array(z.object({ header: z.string(), as: z.string() })), left: z.array(z.string()) }),
});
export type PasteProposal = z.infer<typeof PasteProposalSchema>;

const LEFT_REASONS = ["no_contact", "bad_email", "bad_phone", "not_a_firm_site", "repeated"] as const satisfies readonly LeftReason[];

/** The card's basis: counts and note codes only, never text. */
export const PasteBasisSchema = z.object({
  from: z.enum(["box", "chat"]),
  read: z.number().int().min(0),
  left: z.object(Object.fromEntries(LEFT_REASONS.map((r) => [r, z.number().int().min(0)])) as Record<LeftReason, z.ZodNumber>),
  already: z.object({ people: z.number().int().min(0), companies: z.number().int().min(0) }),
  notes: z.array(z.enum(PASTE_NOTE_CODES)).default([]),
});
export type PasteBasis = z.infer<typeof PasteBasisSchema>;

/** What the sheet and Vizzy's card show of a waiting list. */
export interface PasteBatchView {
  id: AgentActionId;
  rev: number;
  expiresAt: string;
  source: string;
  rows: Array<{ row: number; kind: "person" | "company"; name: string | null; contact: string; fields: number }>;
  counts: { read: number; people: number; companies: number; left: number; already: number };
  columns: { read: Array<{ header: string; as: string }>; left: string[] };
  notes: PasteNote[];
}

/** A row left out or already here: its number and why, never a cell. */
export interface Skipped {
  row: number;
  reason: RowReason;
}

export type PasteReadError = "source_needed" | ParseError | "no_header" | "too_large";

export type PasteReadResult =
  | { ok: true; outcome: "ready"; batch: PasteBatchView; skipped: Skipped[]; warning: string | null }
  | { ok: true; outcome: "nothing_to_add"; skipped: Skipped[]; counts: PasteBatchView["counts"] }
  | { ok: false; error: PasteReadError };

export interface PasteDeps {
  db?: FirestoreLike;
  nowMs?: number;
  usage?: UsageDeps;
  /** Fill the brand's own fields (AUDIENCE_FIELDS_ENABLED unless said). */
  fields?: boolean;
}

const DAY_MS = 86_400_000;

/** Where the list is from as kept: one line, trimmed, 1 to 80 characters; null otherwise. */
export function cleanSource(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.replace(/\s+/g, " ").trim();
  return v && v.length <= PASTE_LIMITS.sourceChars ? v : null;
}

/** Both field lists, or none while fields are off. */
export async function pasteFieldLists(ctx: TenantContext, deps: PasteDeps): Promise<{ person: RecordField[]; company: RecordField[] }> {
  if (!(deps.fields ?? isFieldsEnabled())) return { person: [], company: [] };
  const [person, company] = await Promise.all([readFieldList(ctx, "person", deps.db), readFieldList(ctx, "company", deps.db)]);
  return { person: person.items, company: company.items };
}

/** A row as stored on the card. */
function storedRow(r: RowRead): PasteRow {
  return r.kind === "person"
    ? { row: r.row, kind: "person", email: r.email, phone: r.phone, firstName: r.firstName, lastName: r.lastName }
    : { row: r.row, kind: "company", domain: r.domain, name: r.name };
}

/** Field values column by column, each keyed by the row's index; only fields some row fills, only rows with a value. */
function columnsOfValues(rows: readonly RowRead[]): Record<string, Record<string, FieldValue>> {
  const out: Record<string, Record<string, FieldValue>> = {};
  rows.forEach((r, i) => {
    for (const [id, v] of Object.entries(r.values)) (out[id] ??= {})[String(i)] = v;
  });
  return out;
}

/** A row's value in a stored column, or null. */
export function valueAt(column: Record<string, FieldValue> | null | undefined, i: number): FieldValue | null {
  return column && Object.hasOwn(column, String(i)) ? (column[String(i)] ?? null) : null;
}

/** The view of a stored card. Null when its rows are gone or can't be read. */
export function batchViewOf(a: AgentAction): PasteBatchView | null {
  const p = PasteProposalSchema.safeParse(a.proposal);
  const b = PasteBasisSchema.safeParse(a.basis);
  if (!p.success || !b.success) return null;
  const { rows, fields, source, columns } = p.data;
  const valuesIn = (i: number) => Object.values(fields).filter((col) => valueAt(col, i) !== null).length;
  const left = LEFT_REASONS.reduce((n, r) => n + b.data.left[r], 0);
  return {
    id: a.id,
    rev: a.rev,
    expiresAt: a.expiresAt,
    source,
    rows: rows.map((r, i) =>
      r.kind === "person"
        ? { row: r.row, kind: "person", name: [r.firstName, r.lastName].filter(Boolean).join(" ") || null, contact: r.email ?? r.phone ?? "", fields: valuesIn(i) }
        : { row: r.row, kind: "company", name: r.name, contact: r.domain, fields: valuesIn(i) },
    ),
    counts: {
      read: b.data.read,
      people: rows.filter((r) => r.kind === "person").length,
      companies: rows.filter((r) => r.kind === "company").length,
      left,
      already: b.data.already.people + b.data.already.companies,
    },
    columns,
    notes: b.data.notes,
  };
}

/** The plan's people warning for adding `people` more (it guides and never blocks). */
async function warningFor(ctx: TenantContext, people: number, usage?: UsageDeps): Promise<string | null> {
  if (!people) return null;
  const use = await checkAllowance(ctx, "people", people, usage).catch(() => null);
  return use && use.used !== null && use.limit !== null ? peopleWarning({ used: use.used, limit: use.limit }) : null;
}

/**
 * Read a pasted list into one card for an admin to add: the rows that would add someone or a firm
 * not yet here, at most 50. Every row left out, or already in People or Companies, is answered by
 * its number and reason and kept nowhere. Nothing to add saves nothing. `from`: the People box or
 * Ask Vizzy, which proposes as "vizzy".
 */
export async function readPaste(ctx: TenantContext, input: { text: string; source: string; from: "box" | "chat" }, deps: PasteDeps = {}): Promise<PasteReadResult> {
  const source = cleanSource(input.source);
  if (!source) return { ok: false, error: "source_needed" };
  const parsed = parseSheet(input.text);
  if (!parsed.ok) {
    // One line of values and nothing else: it is the header that's missing.
    if (parsed.header && !mapColumns(parsed.header, { person: [], company: [] }).isHeader) return { ok: false, error: "no_header" };
    return { ok: false, error: parsed.error };
  }
  const map = mapColumns(parsed.sheet.header, await pasteFieldLists(ctx, deps));
  if (!map.isHeader) return { ok: false, error: "no_header" };
  const read = readRows(parsed.sheet, map);

  // Already here: counted, never stored.
  const repo = forTenant(ctx, deps.db);
  const here = await Promise.all(
    read.rows.map((r) => (r.kind === "person" ? repo.contacts.getById(personIdOf(ctx.tenantId, r.key)) : repo.companies.getById(deterministicCompanyId(ctx.tenantId, r.domain)))),
  );
  const add = read.rows.filter((_, i) => !here[i]);
  const already = read.rows.filter((_, i) => !!here[i]);
  const skipped: Skipped[] = [
    ...read.left,
    ...already.map((r) => ({ row: r.row, reason: (r.kind === "person" ? "in_people" : "in_companies") as RowReason })),
  ].sort((a, b) => a.row - b.row);

  const left = Object.fromEntries(LEFT_REASONS.map((r) => [r, read.left.filter((l) => l.reason === r).length])) as Record<LeftReason, number>;
  const basis: PasteBasis = {
    from: input.from,
    read: parsed.sheet.rows.length,
    left,
    already: { people: already.filter((r) => r.kind === "person").length, companies: already.filter((r) => r.kind === "company").length },
    notes: PASTE_NOTE_CODES.filter((n) => read.notes.includes(n)),
  };
  if (!add.length) {
    return {
      ok: true,
      outcome: "nothing_to_add",
      skipped,
      counts: { read: basis.read, people: 0, companies: 0, left: read.left.length, already: already.length },
    };
  }

  const fields = columnsOfValues(add);
  const proposal: PasteProposal = { v: 1, source, rows: add.map(storedRow), fields, columns: { read: map.read, left: map.left } };
  if (!fitsAgentAction(proposal, basis)) return { ok: false, error: "too_large" };

  const nowMs = deps.nowMs ?? Date.now();
  // A one off: each paste its own key, so a dismissed list never blocks pasting it again.
  const dedupeKey = agentDedupeKey(PASTE_ACTION, randomUUID().replace(/-/g, ""));
  const id = deterministicAgentActionId(ctx.tenantId, dedupeKey);
  const saved = await proposeAgentAction(
    ctx,
    {
      dedupeKey,
      agent: input.from === "chat" ? "vizzy" : "paste",
      action: PASTE_ACTION,
      target: { type: "brand", id: ctx.tenantId },
      personId: null,
      productUserId: null,
      proposal,
      basis,
      fieldIds: Object.keys(fields),
      signals: [],
      draft: null,
      review: { kind: "paste_batch", href: pasteHref(id) },
      requestedBy: { type: "member", id: ctx.userId ?? null },
      expiresAt: new Date(nowMs + PASTE_DAYS * DAY_MS).toISOString(),
      clearDetailsOnClose: true,
      at: new Date(nowMs).toISOString(),
    },
    { db: deps.db },
  );
  const batch = batchViewOf(saved.action);
  if (!batch) throw new Error("paste: the saved list can't be read back");
  const warning = await warningFor(ctx, batch.counts.people, deps.usage);
  return { ok: true, outcome: "ready", batch, skipped, warning };
}

/** This brand's waiting list by id, or null once it is added, dismissed, past its 7 days or emptied. */
export async function openPasteBatch(ctx: TenantContext, id: string, deps: Pick<PasteDeps, "db" | "nowMs"> = {}): Promise<AgentAction | null> {
  if (!isAgentActionId(id)) return null;
  const a = await getAgentAction(ctx, id, { db: deps.db });
  const now = new Date(deps.nowMs ?? Date.now()).toISOString();
  if (!a || !isPasteBatch(ctx, a) || a.state !== "proposed" || !a.proposal || a.expiresAt <= now) return null;
  return a;
}

/** A waiting list as the sheet opens it from Review or Vizzy's card, with the plan's people warning. */
export async function readPasteBatch(ctx: TenantContext, id: string, deps: PasteDeps = {}): Promise<{ batch: PasteBatchView; warning: string | null } | null> {
  const a = await openPasteBatch(ctx, id, deps);
  const batch = a ? batchViewOf(a) : null;
  if (!batch) return null;
  return { batch, warning: await warningFor(ctx, batch.counts.people, deps.usage) };
}

/** Dismiss a waiting list: declined, its rows cleared. `changed` when someone moved it since `rev`. */
export async function dismissPasteBatch(ctx: TenantContext, id: string, rev: number, deps: Pick<PasteDeps, "db" | "nowMs"> = {}): Promise<"dismissed" | "paste_gone" | "changed"> {
  const userId = ctx.userId;
  if (!userId || userId.includes("@")) return "paste_gone";
  const a = await openPasteBatch(ctx, id, deps);
  if (!a) return "paste_gone";
  if (a.rev !== rev) return "changed";
  const at = new Date(deps.nowMs ?? Date.now()).toISOString();
  const r = await transitionAgentAction(ctx, a.id, { to: "declined", reason: "dismissed", by: { type: "member", id: userId }, at, expectRev: rev, clearDetails: true }, { db: deps.db });
  if (r.ok) return "dismissed";
  return r.error === "changed" ? "changed" : "paste_gone";
}
