import { createHash } from "node:crypto";
import {
  blankFieldEvents,
  blankFieldInAgentActions,
  countFieldAgentActions,
  countFieldEvents,
  eraseFieldValuesPage,
  forTenant,
  gcsAuditSink,
  mayMoveBrand,
  recordFieldErase,
  writeAuditObject,
  type AuditObjectSink,
  type FieldEraseAudit,
  type TenantContext,
} from "@/lib/tenant";
import { listAllTenants } from "@/lib/tenant/registry";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { BrandMoveRefusal, VerifiedPerson } from "@/lib/tenant";
import type { enterpriseFeature } from "@/lib/enterprise/registry";
import { readFieldList, saveFieldEraseMark } from "@/lib/audience/fieldList";
import type { UserLookup } from "@/lib/team/names";
import type { Tenant } from "@/lib/types/tenant";
import { FIELD_ERASE_MAX_FAILURES, type FieldEraseCounts, type FieldEraseJob } from "@/lib/types/fieldEraseJob";
import { isFieldId, isRecordFieldObject, type RecordField, type RecordFieldObject } from "@/lib/types/recordField";
import { isSettingsEraseEnabled } from "./flags";
import { legalHoldOn, type HoldReader } from "./holds";
import { fieldErasable } from "./eraseDates";
import { whoNamer, whoOfSaver } from "./sources";

export { ERASE_AFTER_DAYS, erasableFrom, erasedSinceArchive, fieldErasable } from "./eraseDates";

/**
 * An owner erases the values of an archived field (Settings › History, ADR-0021,
 * SETTINGS_ERASE_ENABLED). The one destructive path here, so every step is checked and counted:
 *
 * - **Who:** an owner of the brand's organisation with a real admin row for the brand, both read
 *   live (mayMoveBrand's check, never the session's claims): "home_only" for the brand they first
 *   signed in with and have no row for, "not_admin" for no row.
 * - **When:** archived 30 days or more, counted from its latest `archivedAt`; `erasedAt` missing or
 *   older than that archive, so a field brought back after an erase can be erased again; and no
 *   legal hold (./holds.ts).
 * - **Count first:** a count is a job too, and the erase starts only once a count finished since the
 *   field was last archived, with the field's name typed.
 * - **The erase:** "initiated" goes to the WORM audit store before anything changes (no erase
 *   without a trail), then the field is marked `erasingSince` through the settings log: while marked
 *   it stays archived, Bring back is refused, and a person's move drops its values instead of moving
 *   them. The lifecycle tick's lane (runFieldErase) removes the values and field tags from each
 *   person or company a page at a time, then blanks them in the history and in Vizzy's suggestions,
 *   then stamps `erasedAt` and `erasedBy` on the definition, which keeps its options, and writes
 *   "completed". Each page re-reads the list and stops if the field is in use again.
 * - Switching it off pauses a running job at its cursor, still marked. A step that fails five times
 *   in a row fails the job (audit "failed"); pressing Erase values again carries on from its cursor.
 */

/** A tick holds a job this long, so two never run it at once. */
const LEASE_MS = 60_000;
/** No page starts with less than this left of the lane's budget. */
const PAGE_MIN_MS = 3_000;
/** Running jobs read for one brand per tick. */
const JOBS_PER_BRAND = 5;
const TICK_MS = 120_000;

export type EraseRefusal = "erase_off" | BrandMoveRefusal | "field_not_found" | "not_archived" | "too_soon" | "already_erased" | "legal_hold";

/** `fej_` and a hash of the brand, object and field: one job per field, so a double click starts one. */
export function fieldEraseJobId(tenantId: string, object: RecordFieldObject, fieldId: string): string {
  return `fej_${createHash("sha256").update(`${tenantId}\n${object}\n${fieldId}`).digest("hex").slice(0, 32)}`;
}

export interface EraseDeps {
  db?: FirestoreLike;
  now?: () => number;
  sink?: AuditObjectSink;
  holdReader?: HoldReader;
  /** Names for who archived a field (tests pass their own). */
  lookup?: UserLookup;
  /** The legal hold check's registry answer (tests pass their own). */
  holdFeature?: typeof enterpriseFeature;
}

const nowOf = (deps: EraseDeps) => (deps.now ?? Date.now)();
const isoOf = (ms: number) => new Date(ms).toISOString();

export type EraseCheck = { ok: true; field: RecordField } | { ok: false; why: EraseRefusal; from?: string; field?: RecordField };

/** Who may erase this field's values now, and whether they may yet. Read live, every time. */
export async function checkErase(ctx: TenantContext, person: VerifiedPerson | null, input: { object: RecordFieldObject; fieldId: string }, deps: EraseDeps = {}): Promise<EraseCheck> {
  if (!isSettingsEraseEnabled()) return { ok: false, why: "erase_off" };
  if (!person) return { ok: false, why: "not_admin" };
  // An owner of the brand's organisation with a real admin row for the brand, as moving a brand asks.
  const owner = await mayMoveBrand(person, ctx.tenantId, deps.db);
  if (!owner.ok) return { ok: false, why: owner.why };
  const list = await readFieldList(ctx, input.object, deps.db);
  const field = list.items.find((f) => f.key === input.fieldId);
  if (!field) return { ok: false, why: "field_not_found" };
  const dates = fieldErasable(field, nowOf(deps));
  if (!dates.ok) return { ok: false, why: dates.why, from: dates.from, field };
  const hold = await legalHoldOn(ctx, input, { feature: deps.holdFeature, reader: deps.holdReader });
  if (hold.held) return { ok: false, why: "legal_hold", field };
  return { ok: true, field };
}

export type ApiResult = { status: number; body: unknown };

const REFUSAL_STATUS: Record<EraseRefusal, number> = {
  erase_off: 404,
  no_brand: 403,
  no_organisation: 403,
  not_owner: 403,
  home_only: 403,
  not_admin: 403,
  field_not_found: 404,
  not_archived: 409,
  too_soon: 409,
  already_erased: 409,
  legal_hold: 409,
};

const refused = (c: Extract<EraseCheck, { ok: false }>): ApiResult => ({ status: REFUSAL_STATUS[c.why], body: { error: c.why, ...(c.from ? { from: c.from } : {}) } });

const zero = (): FieldEraseCounts => ({ records: 0, events: 0, agentActions: 0 });

/** A job as the page and Vizzy read it: no lease, no user id. */
export function publicJob(job: FieldEraseJob | null) {
  if (!job) return null;
  return {
    mode: job.mode,
    state: job.state,
    phase: job.cursor.phase,
    counts: job.counts,
    counted: job.counted,
    scanned: job.scanned,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
  };
}

/** Whether a finished count can stand behind an erase: it finished since the field was last archived. */
export function countStands(job: FieldEraseJob | null, field: Pick<RecordField, "archivedAt">): boolean {
  return !!job && job.mode === "count" && job.state === "done" && !!job.finishedAt && !!field.archivedAt && job.finishedAt >= field.archivedAt;
}

/** The field's erase as it stands, and whether this person may start one. */
export async function eraseStatus(ctx: TenantContext, person: VerifiedPerson | null, input: { object: RecordFieldObject; fieldId: string }, deps: EraseDeps = {}): Promise<ApiResult> {
  if (!isSettingsEraseEnabled()) return { status: 404, body: { error: "erase_off" } };
  const check = await checkErase(ctx, person, input, deps);
  const job = await forTenant(ctx, deps.db).fieldEraseJobs.getById(fieldEraseJobId(ctx.tenantId, input.object, input.fieldId));
  if (!check.ok && !check.field) return refused(check);
  const field = check.field!;
  const archivedBy = field.archivedBy ? (await whoNamer(ctx, [whoOfSaver(field.archivedBy)], { db: deps.db, lookup: deps.lookup }))(whoOfSaver(field.archivedBy)) : null;
  return {
    status: 200,
    body: {
      allowed: check.ok,
      ...(check.ok ? {} : { refused: check.why, ...(check.from ? { from: check.from } : {}) }),
      field: { label: field.label, archivedAt: field.archivedAt ?? null, archivedBy, erasedAt: field.erasedAt ?? null, erasing: !!field.erasingSince },
      job: publicJob(job),
      countStands: countStands(job, field),
    },
  };
}

/**
 * Start a count of what holds the field (the first click on Erase values). A running job is
 * returned as it is, so a double click starts one.
 */
export async function startFieldCount(ctx: TenantContext, person: VerifiedPerson | null, input: { object: RecordFieldObject; fieldId: string }, deps: EraseDeps = {}): Promise<ApiResult> {
  const check = await checkErase(ctx, person, input, deps);
  if (!check.ok) return refused(check);
  const nowIso = isoOf(nowOf(deps));
  const id = fieldEraseJobId(ctx.tenantId, input.object, input.fieldId);
  const fresh = (): Omit<FieldEraseJob, "id" | "tenantId"> => ({
    fieldId: input.fieldId,
    object: input.object,
    mode: "count",
    state: "running",
    cursor: { phase: "records", after: null },
    counts: zero(),
    counted: null,
    startedBy: person!.userId,
    startedAt: nowIso,
    finishedAt: null,
    updatedAt: nowIso,
    scanned: 0,
    leaseUntil: null,
    failures: 0,
    error: null,
  });
  const { doc } = await forTenant(ctx, deps.db).fieldEraseJobs.upsert(id, fresh, (cur) => {
    if (cur.state === "running") return null;
    // An erase that failed part way carries on from its cursor; it never starts over as a count.
    if (cur.mode === "erase" && cur.state === "failed" && check.field.erasingSince) return null;
    return fresh();
  });
  return { status: 200, body: { job: publicJob(doc) } };
}

/** Write one audit entry: the WORM store first (it throws), then the index (best effort). */
async function audit(entry: FieldEraseAudit, deps: EraseDeps): Promise<void> {
  await writeAuditObject(entry, deps.sink ?? gcsAuditSink());
  await recordFieldErase(entry, deps.db).catch((err) => console.error(`[erase] audit index write failed for ${entry.tenantId}/${entry.fieldId}`, err instanceof Error ? err.message : "error"));
}

/**
 * Start the erase, after a count that still stands and with the field's name typed: "initiated"
 * to the audit trail first, then the field marked, then the job set running. A failed erase of the
 * same field carries on from its cursor instead.
 */
export async function startFieldErase(
  ctx: TenantContext,
  person: VerifiedPerson | null,
  input: { object: RecordFieldObject; fieldId: string; name: string },
  deps: EraseDeps = {},
): Promise<ApiResult> {
  const check = await checkErase(ctx, person, input, deps);
  if (!check.ok) return refused(check);
  const field = check.field;
  if (input.name.trim() !== field.label) return { status: 400, body: { error: "name_mismatch" } };
  const repo = forTenant(ctx, deps.db).fieldEraseJobs;
  const id = fieldEraseJobId(ctx.tenantId, input.object, input.fieldId);
  const job = await repo.getById(id);
  if (job?.state === "running") return { status: 200, body: { job: publicJob(job) } };
  const nowMs = nowOf(deps);
  const nowIso = isoOf(nowMs);
  const resuming = job?.mode === "erase" && job.state === "failed" && !!field.erasingSince;
  if (!resuming && !countStands(job, field)) return { status: 409, body: { error: "count_first" } };
  if (!resuming) {
    try {
      await audit({ action: "field.erase", actorUid: person!.userId, tenantId: ctx.tenantId, region: ctx.region, fieldId: input.fieldId, object: input.object, status: "initiated", counts: zero(), createdAt: nowIso }, deps);
    } catch (err) {
      console.error(`[erase] audit write failed, nothing erased for ${ctx.tenantId}/${input.fieldId}`, err instanceof Error ? err.message : "error");
      return { status: 503, body: { error: "audit_unavailable" } };
    }
    const marked = await saveFieldEraseMark(ctx, input.object, { key: input.fieldId, step: "start", by: person!.userId, nowIso }, deps.db);
    if (!marked.ok) return { status: 409, body: { error: "fields_changed" } };
  }
  const started = await repo.claim(id, (cur) => {
    if (cur.state === "running") return null;
    if (resuming) return { state: "running", failures: 0, error: null, leaseUntil: null, updatedAt: nowIso };
    return {
      mode: "erase",
      state: "running",
      cursor: { phase: "records", after: null },
      counted: { ...cur.counts, at: cur.finishedAt ?? nowIso },
      counts: zero(),
      startedBy: person!.userId,
      startedAt: nowIso,
      finishedAt: null,
      updatedAt: nowIso,
      scanned: 0,
      leaseUntil: null,
      failures: 0,
      error: null,
    };
  });
  return { status: 200, body: { job: publicJob(started ?? (await repo.getById(id))) } };
}

// --- The lane --------------------------------------------------------------------------------

/** One step of a job: the patch it makes. */
async function onePage(ctx: TenantContext, job: FieldEraseJob, deps: EraseDeps): Promise<Partial<FieldEraseJob>> {
  const nowIso = isoOf(nowOf(deps));
  const counting = job.mode === "count";
  const { phase, after } = job.cursor;
  const counts = { ...job.counts };
  if (phase === "records") {
    const page = await eraseFieldValuesPage(ctx, { object: job.object, fieldId: job.fieldId, after, dryRun: counting, nowIso }, { db: deps.db });
    if (page.stopped) return stopJob(ctx, job, "field_live", deps);
    counts.records += counting ? page.holders : page.erased;
    const next = page.more ? { phase, after: page.last } : { phase: counting ? ("finish" as const) : ("events" as const), after: null };
    return { counts, cursor: next, scanned: job.scanned + page.scanned };
  }
  if (phase === "events") {
    const r = await blankFieldEvents(ctx, job.fieldId, { startAfter: after, nowIso, db: deps.db });
    counts.events += r.blanked;
    return { counts, cursor: r.more ? { phase, after: r.last } : { phase: "actions", after: null } };
  }
  if (phase === "actions") {
    const r = await blankFieldInAgentActions(ctx, job.fieldId, { startAfter: after, nowIso, db: deps.db });
    counts.agentActions += r.blanked;
    return { counts, cursor: r.more ? { phase, after: r.last } : { phase: "finish", after: null } };
  }
  if (counting) {
    const [events, agentActions] = await Promise.all([countFieldEvents(ctx, job.fieldId, { db: deps.db }), countFieldAgentActions(ctx, job.fieldId, { db: deps.db })]);
    return { counts: { ...counts, events: events.toBlank, agentActions }, state: "done", finishedAt: nowIso };
  }
  // The erase is done: the definition says so (its options kept), then the trail.
  const done = await saveFieldEraseMark(ctx, job.object, { key: job.fieldId, step: "done", by: job.startedBy, nowIso }, deps.db);
  if (!done.ok) throw new Error(`erase_mark_${done.error}`);
  await audit({ action: "field.erase", actorUid: job.startedBy, tenantId: ctx.tenantId, region: ctx.region, fieldId: job.fieldId, object: job.object, status: "completed", counts, createdAt: nowIso }, deps);
  return { state: "done", finishedAt: nowIso };
}

/** The field is in use again: the erase stops, the mark goes, and the trail says so. */
async function stopJob(ctx: TenantContext, job: FieldEraseJob, error: string, deps: EraseDeps): Promise<Partial<FieldEraseJob>> {
  const nowIso = isoOf(nowOf(deps));
  if (job.mode === "erase") {
    const list = await readFieldList(ctx, job.object, deps.db);
    if (list.items.find((f) => f.key === job.fieldId)?.erasingSince) await saveFieldEraseMark(ctx, job.object, { key: job.fieldId, step: "stop", by: job.startedBy, nowIso }, deps.db);
    await audit({ action: "field.erase", actorUid: job.startedBy, tenantId: ctx.tenantId, region: ctx.region, fieldId: job.fieldId, object: job.object, status: "failed", counts: job.counts, error, createdAt: nowIso }, deps).catch(() => {});
  }
  return { state: "stopped", error, finishedAt: nowIso };
}

/**
 * Move one running job on until `deadlineMs`, a page at a time, under a lease so two ticks never run
 * it at once. Its place is saved after every page, so it carries on from there next tick.
 */
export async function stepFieldEraseJob(ctx: TenantContext, jobId: string, opts: { deadlineMs: number }, deps: EraseDeps = {}): Promise<{ pages: number; state: FieldEraseJob["state"] | null }> {
  const repo = forTenant(ctx, deps.db).fieldEraseJobs;
  const nowIso = isoOf(nowOf(deps));
  const claimed = await repo.claim(jobId, (cur) => (cur.state === "running" && (!cur.leaseUntil || cur.leaseUntil <= nowIso) ? { leaseUntil: isoOf(nowOf(deps) + LEASE_MS) } : null));
  if (!claimed) return { pages: 0, state: null };
  let job = claimed;
  let pages = 0;
  try {
    while (job.state === "running" && nowOf(deps) < opts.deadlineMs - PAGE_MIN_MS) {
      const patch = { ...(await onePage(ctx, job, deps)), failures: 0, updatedAt: isoOf(nowOf(deps)) };
      await repo.update(job.id, patch);
      job = { ...job, ...patch };
      pages += 1;
    }
  } catch (err) {
    const failures = job.failures + 1;
    const error = err instanceof Error ? err.message.slice(0, 80) : "error";
    console.warn(`[erase] ${ctx.tenantId}/${job.fieldId} step failed (${failures}): ${error}`);
    const failed = failures >= FIELD_ERASE_MAX_FAILURES;
    const patch: Partial<FieldEraseJob> = { failures, error: "step_failed", updatedAt: isoOf(nowOf(deps)), ...(failed ? { state: "failed" as const, finishedAt: isoOf(nowOf(deps)) } : {}) };
    await repo.update(job.id, patch);
    job = { ...job, ...patch };
    if (failed && job.mode === "erase") {
      await audit({ action: "field.erase", actorUid: job.startedBy, tenantId: ctx.tenantId, region: ctx.region, fieldId: job.fieldId, object: job.object, status: "failed", counts: job.counts, error: "step_failed", createdAt: isoOf(nowOf(deps)) }, deps).catch(() => {});
    }
  }
  await repo.update(job.id, { leaseUntil: null });
  return { pages, state: job.state };
}

export interface LaneDeps extends EraseDeps {
  listTenants?: () => Promise<Tenant[]>;
  regionDb?: (region: Tenant["region"]) => FirestoreLike | undefined;
}

/**
 * The lifecycle tick's erase lane (only while SETTINGS_ERASE_ENABLED is on): brands take turns from
 * a rotating start, as the connectors lane does, with one small query each for its running jobs (an
 * equality, no index), and each job moves on until the lane's deadline.
 */
export async function runFieldErase(opts: { deadlineMs: number }, deps: LaneDeps = {}): Promise<{ brands: number; jobs: number; pages: number }> {
  const out = { brands: 0, jobs: 0, pages: 0 };
  if (!isSettingsEraseEnabled()) return out;
  const tenants = (await (deps.listTenants ?? listAllTenants)()).filter((t) => t.status !== "suspended");
  const offset = tenants.length ? Math.floor(nowOf(deps) / TICK_MS) % tenants.length : 0;
  for (const t of [...tenants.slice(offset), ...tenants.slice(0, offset)]) {
    if (nowOf(deps) >= opts.deadlineMs - PAGE_MIN_MS) break;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    const db = deps.regionDb?.(t.region) ?? deps.db;
    out.brands += 1;
    try {
      const running = await forTenant(ctx, db).fieldEraseJobs.find({ where: [["state", "==", "running"]], limit: JOBS_PER_BRAND });
      for (const job of running) {
        if (nowOf(deps) >= opts.deadlineMs - PAGE_MIN_MS) break;
        const r = await stepFieldEraseJob(ctx, job.id, opts, { ...deps, db });
        if (r.state !== null) out.jobs += 1;
        out.pages += r.pages;
      }
    } catch (err) {
      console.warn(`[erase] lane failed for ${t.id}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    }
  }
  return out;
}

/** A request's object and field, or null. */
export function parseEraseTarget(object: unknown, fieldId: unknown): { object: RecordFieldObject; fieldId: string } | null {
  return isRecordFieldObject(object) && isFieldId(fieldId) ? { object, fieldId } : null;
}
