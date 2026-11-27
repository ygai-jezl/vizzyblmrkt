import { appendEvents, clearAgentActionDetails, forTenant, transitionAgentAction, type TenantContext } from "@/lib/tenant";
import { addPerson, type PastedPerson } from "@/lib/audience/addPerson";
import { setFieldValues } from "@/lib/audience/fields";
import { deterministicCompanyId, domainFromEmail } from "@/lib/crm/identifiers";
import { buildSearchTokens } from "@/lib/crm/searchTokens";
import { isPublicEmailProvider } from "@/lib/domains/registrableDomain";
import { actorOf, type EventActor } from "@/lib/ontology/events";
import { recordCreatedEvent } from "@/lib/ontology/eventBuilders";
import { getAgentAction } from "@/lib/ontology/agentActions";
import type { Company } from "@/lib/types/company";
import type { ContactAddedBy } from "@/lib/types/contact";
import { isAgentActionId, type AgentActionId } from "@/lib/types/agentAction";
import { checkFieldValue, type FieldValue, type RecordField } from "@/lib/types/recordField";
import { fillable } from "./columns";
import { PasteProposalSchema, pasteFieldLists, valueAt, type PasteDeps, type PasteRow } from "./batch";
import { isPasteBatch } from "./review";

/**
 * Paste a list (RAISE_PASTE_ENABLED): an admin adds a waiting list. Each person is added exactly
 * as New person adds someone (addPerson): keyed by their address or phone, consent at Not yet,
 * tagged as added by hand, with where the list is from on their record and their record.created
 * row. Each firm becomes a company by its web address, kept as typed (`manual`, so a later
 * sign-up's enrichment never renames it), with its row and its company fields.
 *
 * Every add is idempotent: someone already here is never changed and counts as already, so a
 * second press, a retry after a crash, or two admins at once never add anyone twice. A company a
 * stopped add made from this list (same source) but left without its record.created row is
 * finished on the next press: its row is written at the company's own time, so its key is the
 * first attempt's, and its fields are set if it has none. Last, the card is acted with the counts
 * and its rows are cleared in the same commit. That move is tried twice; if it still fails the add
 * throws, the route answers `failed`, and a press again closes it. If someone moved the card
 * meanwhile (another admin's add, a dismiss, the expiry), that move cleared the rows too, which is
 * checked, and the answer is the counts this add saw.
 */

export interface AddPasteCounts {
  added: { people: number; companies: number };
  already: { people: number; companies: number };
  /** Rows added whose field values (or some of them) didn't save. */
  fieldsNotSaved: number;
}

export type AddPasteResult = ({ ok: true } & AddPasteCounts) | { ok: false; error: "paste_gone" | "changed" | "no_user" };

/** Rows added at once. */
const AT_ONCE = 4;

/** Run `fn` over the items, `limit` at a time, keeping their order. */
async function inOrder<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

type RowOutcome = { kind: "person" | "company"; added: boolean; fieldsNotSaved: boolean; companyId: string | null };

/** Run `fn`, and once more if it throws. */
async function twice<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return fn();
  }
}

/** Whether a company was made from a pasted list with this source: a stopped add of this list may have left it unfinished. */
function madeFromPaste(company: Company, source: string): boolean {
  return company.addedBy?.kind === "member" && company.addedBy.via === "paste" && company.addedBy.source === source;
}

/**
 * Close the card as acted with its counts, rows cleared in the same commit. Tried twice, then
 * throws. When it moved meanwhile, that move cleared its rows too; if somehow they are still there,
 * they are cleared now.
 */
async function closeBatch(
  ctx: TenantContext,
  id: AgentActionId,
  t: { by: EventActor; at: string; rev: number; result: Record<string, unknown> },
  db: PasteDeps["db"],
): Promise<void> {
  const moved = await twice(() => transitionAgentAction(ctx, id, { to: "acted", by: t.by, at: t.at, expectRev: t.rev, result: t.result, clearDetails: true }, { db }));
  if (moved.ok) return;
  const now = await twice(() => getAgentAction(ctx, id, { db }));
  if (now && (now.proposal || now.basis)) await twice(() => clearAgentActionDetails(ctx, id, { at: t.at, db }));
}

/**
 * Add a waiting list, by the admin in `ctx` (the route checks the role). `rev`: the card as the
 * admin saw it; another move since answers `changed`.
 */
export async function addPasteBatch(ctx: TenantContext, id: string, rev: number, deps: PasteDeps = {}): Promise<AddPasteResult> {
  const userId = ctx.userId;
  if (!userId || userId.includes("@")) return { ok: false, error: "no_user" };
  if (!isAgentActionId(id)) return { ok: false, error: "paste_gone" };
  const a = await getAgentAction(ctx, id, { db: deps.db });
  if (!a || !isPasteBatch(ctx, a) || a.state !== "proposed" || !a.proposal) return { ok: false, error: "paste_gone" };
  const nowMs = deps.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const by = { type: "member" as const, id: userId };
  if (a.expiresAt <= nowIso) {
    // Out of time and not yet swept: set it aside now, rows and all.
    await transitionAgentAction(ctx, a.id, { to: "declined", reason: "expired", by: { type: "system", id: "agent_action_expiry" }, at: nowIso, expectRev: a.rev }, { db: deps.db }).catch(() => null);
    return { ok: false, error: "paste_gone" };
  }
  if (a.rev !== rev) return { ok: false, error: "changed" };
  const parsed = PasteProposalSchema.safeParse(a.proposal);
  if (!parsed.success) return { ok: false, error: "paste_gone" };
  const { rows, fields, source } = parsed.data;

  // The field lists as they are now: a value whose field is gone, archived or no longer fits is left out.
  const lists = await pasteFieldLists(ctx, deps);
  const live = { person: new Map(lists.person.map((f) => [f.key, f])), company: new Map(lists.company.map((f) => [f.key, f])) };
  const valuesFor = (row: PasteRow, i: number): { values: Record<string, FieldValue>; dropped: boolean } => {
    const byId: Map<string, RecordField> = row.kind === "person" ? live.person : live.company;
    const values: Record<string, FieldValue> = {};
    let dropped = false;
    for (const [fieldId, column] of Object.entries(fields)) {
      const v = valueAt(column, i);
      if (v === null) continue;
      const field = byId.get(fieldId);
      // A value for the other object's field belongs to the other kind of row.
      if (!field && (row.kind === "person" ? live.company : live.person).has(fieldId)) continue;
      const check = field && fillable(field) ? checkFieldValue(field, v) : null;
      if (check?.ok && check.value !== null) values[fieldId] = check.value;
      else dropped = true;
    }
    return { values, dropped };
  };

  const repo = forTenant(ctx, deps.db);
  const actor = actorOf(ctx);
  const addedBy: ContactAddedBy = { kind: "member", id: userId, at: nowIso, via: "paste", source };

  const outcomes = await inOrder(rows, AT_ONCE, async (row, i): Promise<RowOutcome> => {
    const { values, dropped } = valuesFor(row, i);
    const hasValues = Object.keys(values).length > 0;
    if (row.kind === "person") {
      if (!row.email && !row.phone) return { kind: "person", added: false, fieldsNotSaved: false, companyId: null };
      const input: PastedPerson = {
        email: row.email,
        phone: row.phone,
        firstName: row.firstName,
        lastName: row.lastName,
        fields: values,
        via: "paste",
        agreed: null,
        draftId: null,
        source,
        agentActionId: a.id,
      };
      let r = await addPerson(ctx, input, { db: deps.db, nowIso, fields: hasValues });
      let notSaved = dropped;
      if (r.outcome === "rejected" && r.error !== "no_user") {
        // A field changed in the moment between the check and the add: add them without it.
        r = await addPerson(ctx, { ...input, fields: {} }, { db: deps.db, nowIso, fields: false });
        notSaved = true;
      }
      if (r.outcome === "rejected") return { kind: "person", added: false, fieldsNotSaved: false, companyId: null };
      const email = row.email;
      const domain = email ? domainFromEmail(email) : null;
      const companyId = email && domain && !isPublicEmailProvider(email) ? deterministicCompanyId(ctx.tenantId, domain) : null;
      if (r.outcome === "existing") return { kind: "person", added: false, fieldsNotSaved: false, companyId: null };
      return { kind: "person", added: true, fieldsNotSaved: notSaved || r.fields === "not_saved", companyId };
    }

    const companyId = deterministicCompanyId(ctx.tenantId, row.domain);
    const createdRow = (at: string) =>
      recordCreatedEvent({ subject: { type: "company", id: companyId }, personId: null, via: "paste", source, agentActionId: a.id, actor, at });
    const setValues = async (): Promise<boolean> => {
      if (!hasValues) return true;
      const set = await setFieldValues(ctx, { object: "company", recordId: companyId, changes: values, by: actor, source: "import" }, { db: deps.db }).catch(() => null);
      return !!set?.ok;
    };
    const existing = await repo.companies.getById(companyId);
    if (existing) {
      const already: RowOutcome = { kind: "company", added: false, fieldsNotSaved: false, companyId };
      if (!madeFromPaste(existing, source)) return already;
      // Made from a list with this source: if its row is missing, an add stopped part way, so finish it.
      // At the company's own time the row's key is the first attempt's, so it is never written twice.
      const wrote = await appendEvents(ctx, [createdRow(existing.createdAt)], { db: deps.db, nowIso }).catch(() => null);
      if (!wrote?.written.length) return already;
      // Its fields are set only if it has none: a value there now is kept as it is.
      const filled = !!existing.fields && Object.keys(existing.fields).length > 0;
      return { kind: "company", added: true, fieldsNotSaved: dropped || (!filled && !(await setValues())), companyId };
    }
    const company: Omit<Company, "id" | "tenantId"> = {
      domain: row.domain,
      name: row.name,
      // Kept as the admin added it: a later sign-up's enrichment never renames it, and Re-enrich still can.
      enrichmentStatus: "manual",
      profile: null,
      source: "import",
      contactCount: 0,
      searchTokens: buildSearchTokens([row.name, row.domain]),
      addedBy,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    try {
      await repo.companies.create(companyId, company);
    } catch (err) {
      // Made a moment ago by someone else (an enrichment, another admin): already here, never overwritten.
      if (await repo.companies.getById(companyId)) return { kind: "company", added: false, fieldsNotSaved: false, companyId };
      throw err;
    }
    // Tried twice. If it still fails, the next press of this list finishes the company (above).
    await twice(() => appendEvents(ctx, [createdRow(nowIso)], { db: deps.db, nowIso })).catch((err) =>
      console.warn(`[paste] company row failed tenant=${ctx.tenantId} code=${err instanceof Error ? err.name : "error"}`),
    );
    return { kind: "company", added: true, fieldsNotSaved: dropped || !(await setValues()), companyId };
  });

  // Each company the list made, or whose domain an added person's work address shares, counts its people again.
  const recount = [...new Set(outcomes.flatMap((o) => (o.added && o.companyId ? [o.companyId] : [])))];
  await inOrder(recount, AT_ONCE, async (companyId) => {
    try {
      const company = await repo.companies.getById(companyId);
      if (!company) return;
      const contactCount = await repo.contacts.count([["companyId", "==", companyId]]);
      if (company.contactCount !== contactCount) await repo.companies.update(companyId, { contactCount, updatedAt: nowIso });
    } catch {
      // A count that didn't save is put right by the next one; the people are added either way.
    }
  });

  const counts: AddPasteCounts = {
    added: { people: outcomes.filter((o) => o.kind === "person" && o.added).length, companies: outcomes.filter((o) => o.kind === "company" && o.added).length },
    already: { people: outcomes.filter((o) => o.kind === "person" && !o.added).length, companies: outcomes.filter((o) => o.kind === "company" && !o.added).length },
    fieldsNotSaved: outcomes.filter((o) => o.fieldsNotSaved).length,
  };
  await closeBatch(
    ctx,
    a.id,
    {
      by,
      at: nowIso,
      rev,
      result: { people: { added: counts.added.people, already: counts.already.people }, companies: { added: counts.added.companies, already: counts.already.companies }, fieldsNotSaved: counts.fieldsNotSaved },
    },
    deps.db,
  );
  return { ok: true, ...counts };
}
