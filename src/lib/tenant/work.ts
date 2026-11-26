import { randomBytes } from "node:crypto";
import { isAlreadyExists } from "./firestore";
import { TenantIsolationError, TenantValidationError } from "./errors";
import { provisionedRegions, regionStore, type OrganisationStores } from "./organisationConnections";
import { allocateWorkRefs, deleteWorkRefs } from "./workRefs";
import { planAgentTransition, readAgentActionTx, stageAgentTransition, type TransitionError } from "./agentActions";
import { retryOnceOnExists } from "./ontologyEvents";
import type { CollectionLike, DocRefLike, FirestoreLike, QueryLike, TenantContext, TransactionLike } from "./types";
import type { EventActor } from "@/lib/ontology/events";
import type { AgentAction, AgentActionId } from "@/lib/types/agentAction";
import type { Region } from "@/lib/types/tenant";
import {
  WORK_CHANGE_FIELDS,
  WORK_LIMITS,
  WORK_LOG_ID,
  WORK_TASK_ID,
  WorkLogRowSchema,
  WorkTaskSchema,
  workTaskOpen,
  type WorkChangeField,
  type WorkCheckRow,
  type WorkLogRow,
  type WorkLogRowOf,
  type WorkRecent,
  type WorkSource,
  type WorkTask,
  type WorkWho,
} from "@/lib/work/types";

/**
 * Work's only writer and reader (ADR-0020): `work_tasks` and `work_log`, in regional databases.
 *
 * Where things are kept (the Connectors 3 pattern, src/lib/tenant/organisationConnections.ts):
 * - A task lives in the regional database of the brand it names, or for a whole business task of
 *   the brand it was added from, and never moves database. Its log rows are kept beside it. An
 *   organisation has no region, so every read by organisation reads every provisioned region.
 * - A read by organisation names the regions that didn't answer (`unanswered`) instead of failing
 *   or taking silence for "none", so the list can say which region's tasks are hidden. Erasing
 *   is the exception: a region that fails throws, after the others are done.
 *
 * Every change to a task writes its log rows in the same transaction: one change row per field
 * changed, with the value before and after, or a check row for a check marked, moved or read. The
 * task keeps its last 20 changes in `recent`. Log rows are append only and have no time to live;
 * the one change ever made to one is its organisation, when its brand moves (repointBrandWork).
 * The store works `open` and `hasCheck` out itself, never from the caller.
 *
 * Queries: (organisationId, open, closedAt desc) for the list across brands, (organisationId, at
 * desc) for the Log; every other read is by id or by equality alone (in document id order), so it
 * needs no composite index. Refs come from src/lib/tenant/workRefs.ts, in the control plane.
 */

export const WORK_TASKS = "work_tasks";
export const WORK_LOG = "work_log";
const ORG_FIELD = "organisationId";
/** One page of an equality read; reads take every page. */
const PAGE = 300;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Each region's database (tests pass a fake per region), and the control plane's for refs. */
export interface WorkStores extends OrganisationStores {
  controlDb?: FirestoreLike;
}

/** `wt_` and 20 random base32 characters. */
export function newWorkTaskId(): string {
  const bytes = randomBytes(20);
  let out = "wt_";
  for (let i = 0; i < 20; i++) out += BASE32[bytes[i]! & 31];
  return out;
}

/** `wl_` and 24 random hex. */
export function newWorkLogId(): string {
  return `wl_${randomBytes(12).toString("hex")}`;
}

/** `wi_` and 16 random hex: one import, shared by every task it made. */
export function newWorkImportId(): string {
  return `wi_${randomBytes(8).toString("hex")}`;
}

function invalid(message: string): never {
  throw new TenantValidationError(`bad_work:${message}`);
}

function firstIssue(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.map(String).join(".")}:${issue.message}` : "invalid";
}

// --- Writes ------------------------------------------------------------------------------------

/** What a write says about itself: who, with which tool, when, and the day in the brand's time zone. */
export interface WorkWrite {
  source: WorkSource;
  at: string;
  /** YYYY-MM-DD in the time zone of the brand it is written from. */
  day: string;
}

/** A new task: the store works out open, hasCheck and recent, and stamps createdAt and updatedAt. */
export type NewWorkTask = Omit<WorkTask, "open" | "hasCheck" | "recent" | "createdAt" | "updatedAt">;

/** What a change may set: never the identity fields, which are stripped whatever a plan returns. */
export type WorkTaskPatch = Partial<Omit<WorkTask, "id" | "organisationId" | "region" | "addedFrom" | "ref" | "origin" | "recent" | "open" | "hasCheck" | "createdAt" | "updatedAt">>;

export interface WorkChangePlan {
  patch: WorkTaskPatch;
  /** A check marked, moved on or read: written as a check row, so the check field itself writes no change row. */
  checkRow?: WorkCheckRow;
}

export type WorkChangeResult =
  | { ok: true; task: WorkTask; rows: WorkLogRow[] }
  | { ok: false; why: "not_found" }
  | { ok: false; why: "unchanged"; task: WorkTask };

const FIXED = ["id", ORG_FIELD, "region", "addedFrom", "ref", "origin", "recent", "open", "hasCheck", "createdAt", "updatedAt"] as const;
/** Fields that change with another and write no row of their own (closedAt goes with status). */
const QUIET = new Set<string>(["closedAt"]);
const CHANGE_FIELDS = new Set<string>(WORK_CHANGE_FIELDS.filter((f) => f !== "added" && f !== "deleted"));

function checkSource(s: WorkSource): void {
  // A coding agent writes to Work only once piece K gives it a key of its own.
  if (s.who.kind === "coding_agent") invalid("source:coding agents write to Work after piece K");
}

/** JSON with sorted keys, so two values read from different places compare equal. */
function stable(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

/** A value short enough to keep on the task's recent list, or undefined (lists, maps, long text). */
function shortOf(v: unknown): string | number | boolean | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length <= WORK_LIMITS.recentValue ? v : `${v.slice(0, WORK_LIMITS.recentValue - 1)}…`;
  return undefined;
}

function recentOf(row: WorkLogRow): WorkRecent | null {
  const who = row.source.who;
  if (row.kind === "change") {
    const before = row.field === "added" ? undefined : shortOf(row.before);
    const after = row.field === "added" ? undefined : shortOf(row.after);
    return { at: row.at, field: row.field, who, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) };
  }
  if (row.kind === "check") return { at: row.at, field: "check", who, after: row.check.read ?? row.check.action };
  return null;
}

function withRecent(current: readonly WorkRecent[], rows: readonly WorkLogRow[]): WorkRecent[] {
  const added = rows.map(recentOf).filter((r): r is WorkRecent => r !== null);
  return [...added.reverse(), ...current].slice(0, WORK_LIMITS.recent);
}

/** A log row checked against its schema, ready to store (without its id). */
function parsedRow(row: Record<string, unknown>): WorkLogRow {
  const parsed = WorkLogRowSchema.safeParse(row);
  if (!parsed.success) invalid(`log:${firstIssue(parsed.error)}`);
  return parsed.data;
}

function stageRow(txn: TransactionLike, store: FirestoreLike, row: WorkLogRow): void {
  const { id, ...doc } = row;
  txn.create(store.collection(WORK_LOG).doc(id), doc as unknown as Record<string, unknown>);
}

function changeRow(task: Pick<WorkTask, "id" | "organisationId" | "brandId" | "region">, write: WorkWrite, field: WorkChangeField, before: unknown, after: unknown): WorkLogRow {
  return parsedRow({
    id: newWorkLogId(),
    organisationId: task.organisationId,
    brandId: task.brandId,
    region: task.region,
    day: write.day,
    at: write.at,
    source: write.source,
    kind: "change",
    taskId: task.id,
    field,
    before: before ?? null,
    after: after ?? null,
  });
}

/** The stored task, parsed; null when missing or another organisation's. Throws on one that doesn't parse. */
function parseStored(organisationId: string | null, id: string, data: Record<string, unknown> | undefined): WorkTask | null {
  if (!data) return null;
  if (organisationId !== null && data[ORG_FIELD] !== organisationId) return null;
  const parsed = WorkTaskSchema.safeParse({ ...data, id });
  if (!parsed.success) throw new TenantValidationError(`bad_work:stored:${firstIssue(parsed.error)}`);
  return parsed.data;
}

const taskRef = (store: FirestoreLike, id: string): DocRefLike => store.collection(WORK_TASKS).doc(id);

/** The "added" row's after: what the loops count a task by when it is added. */
function addedSnapshot(t: WorkTask): Record<string, unknown> {
  return { ref: t.ref, title: t.title, origin: t.origin.kind, status: t.status, stage: t.stage, brandId: t.brandId, mustHave: t.mustHave, measure: t.measure?.kind ?? null };
}

/**
 * Make a task and its "added" row in one transaction in its region. The id and the ref are the
 * caller's (newWorkTaskId, allocateWorkRefs); an id that exists already is refused
 * (TenantIsolationError), never overwritten. A coding agent's origin waits for piece K.
 */
export async function createWorkTask(input: NewWorkTask, write: WorkWrite, stores: WorkStores = {}): Promise<{ task: WorkTask; rows: WorkLogRow[] }> {
  if (!WORK_TASK_ID.test(input.id)) invalid("id");
  if (input.origin?.kind === "coding_agent") invalid("origin:coding agents add tasks after piece K");
  checkSource(write.source);
  const candidate = {
    ...input,
    open: workTaskOpen(input),
    hasCheck: input.check != null,
    recent: [] as WorkRecent[],
    createdAt: write.at,
    updatedAt: write.at,
  };
  const first = WorkTaskSchema.safeParse(candidate);
  if (!first.success) invalid(firstIssue(first.error));
  const added = changeRow(first.data, write, "added", null, addedSnapshot(first.data));
  const task: WorkTask = { ...first.data, recent: withRecent([], [added]) };
  const store = regionStore(task.region, stores);
  const { id, ...doc } = task;
  try {
    await store.runTransaction(async (txn) => {
      txn.create(taskRef(store, id), doc as unknown as Record<string, unknown>);
      stageRow(txn, store, added);
    });
  } catch (err) {
    if (isAlreadyExists(err)) throw new TenantIsolationError(`${WORK_TASKS}/${id} already exists; refusing to overwrite`);
    throw err;
  }
  return { task, rows: [added] };
}

/** How a person's Add to Work or Edit then add moves the suggestion, written with the task. */
export interface SuggestionAccept {
  id: AgentActionId;
  by: EventActor;
  /** Refuse with "changed" unless the suggestion is still at this rev. */
  expectRev: number;
  /** The action's result, from the task as it is stored: `{ task, edited }`, never under `fields`. */
  result: (task: WorkTask) => Record<string, unknown>;
}

export type SuggestedTaskResult =
  | { ok: true; task: WorkTask; rows: WorkLogRow[]; action: AgentAction }
  | { ok: false; error: TransitionError | "exists" | "other_region" };

/**
 * Add a task from a Vizzy suggestion (Review's Add to Work, or Edit then add): the task, its
 * "added" row and the suggestion's move to acted with its result, in ONE transaction. That holds
 * only where the task and the suggestion share a database, so the task must be kept in the region
 * of the brand whose chat made the suggestion (other_region otherwise); Firestore runs no
 * transaction across databases (ADR-0002). The task takes the suggestion's target id, so a second
 * accept finds it (exists) or finds the suggestion decided (wrong_state), and nothing is written
 * twice. Reads first: the suggestion, then the task's id.
 */
export async function createSuggestedWorkTask(ctx: TenantContext, input: NewWorkTask, write: WorkWrite, accept: SuggestionAccept, stores: WorkStores = {}): Promise<SuggestedTaskResult> {
  if (!WORK_TASK_ID.test(input.id)) invalid("id");
  if (input.origin?.kind !== "suggestion" || input.origin.agentActionId !== accept.id) invalid("origin:a suggested task's origin names its suggestion");
  checkSource(write.source);
  if (input.region !== ctx.region) return { ok: false, error: "other_region" };
  const candidate = { ...input, open: workTaskOpen(input), hasCheck: input.check != null, recent: [] as WorkRecent[], createdAt: write.at, updatedAt: write.at };
  const first = WorkTaskSchema.safeParse(candidate);
  if (!first.success) invalid(firstIssue(first.error));
  const added = changeRow(first.data, write, "added", null, addedSnapshot(first.data));
  const task: WorkTask = { ...first.data, recent: withRecent([], [added]) };
  const store = regionStore(task.region, stores);
  const { id, ...doc } = task;
  return retryOnceOnExists(() =>
    store.runTransaction(async (txn): Promise<SuggestedTaskResult> => {
      const action = await readAgentActionTx(txn, store, ctx, accept.id);
      const existing = await txn.get(taskRef(store, id));
      if (!action || action.target.type !== "work_task" || action.target.id !== id) return { ok: false, error: "not_found" };
      if (existing.exists) return { ok: false, error: "exists" };
      const plan = planAgentTransition(action, { to: "acted", by: accept.by, at: write.at, expectRev: accept.expectRev, result: accept.result(task), clearDetails: false });
      if (!plan.ok) return { ok: false, error: plan.error };
      txn.create(taskRef(store, id), doc as unknown as Record<string, unknown>);
      stageRow(txn, store, added);
      stageAgentTransition(txn, store, ctx, plan);
      return { ok: true, task, rows: [added], action: plan.next };
    }),
  );
}

/**
 * Change a task with the rows that record it, in one transaction in its region. `plan` sees the
 * freshest task and returns the fields to set (and a check row, for a check marked, moved or
 * read); the store writes one change row per field whose value changed, with its value before and
 * after. A plan that changes nothing writes nothing. Another organisation's task reads as not found.
 */
export async function changeWorkTask(
  organisationId: string,
  id: string,
  region: Region,
  plan: (current: WorkTask) => WorkChangePlan | null,
  write: WorkWrite,
  stores: WorkStores = {},
): Promise<WorkChangeResult> {
  if (!WORK_TASK_ID.test(id) || !organisationId) return { ok: false, why: "not_found" };
  checkSource(write.source);
  const store = regionStore(region, stores);
  return store.runTransaction(async (txn): Promise<WorkChangeResult> => {
    const snap = await txn.get(taskRef(store, id));
    const current = snap.exists ? parseStored(organisationId, id, snap.data()) : null;
    if (!current) return { ok: false, why: "not_found" };
    const planned = plan(current);
    if (!planned) return { ok: false, why: "unchanged", task: current };
    const patch: Record<string, unknown> = { ...planned.patch };
    for (const k of FIXED) delete patch[k];
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete patch[k];
    for (const k of Object.keys(patch)) if (!QUIET.has(k) && !CHANGE_FIELDS.has(k)) invalid(`patch:${k}`);
    const merged = { ...current, ...patch } as WorkTask;
    const read = WorkTaskSchema.safeParse({ ...merged, open: workTaskOpen(merged), hasCheck: merged.check !== null, updatedAt: write.at });
    if (!read.success) invalid(firstIssue(read.error));
    // What is stored, and what the rows say it became, is what the schema read: a key it doesn't
    // know never reaches the record.
    const parsed = read.data as unknown as Record<string, unknown>;
    const rows: WorkLogRow[] = [];
    for (const k of Object.keys(patch)) {
      if (QUIET.has(k) || (k === "check" && planned.checkRow)) continue;
      const before = (current as Record<string, unknown>)[k];
      const after = parsed[k] ?? null;
      // The row follows the task: a change of brand is filed under the brand it names now.
      if (stable(before) !== stable(after)) rows.push(changeRow({ ...current, brandId: read.data.brandId }, write, k as WorkChangeField, before, after));
    }
    if (planned.checkRow) {
      rows.push(
        parsedRow({ id: newWorkLogId(), organisationId, brandId: read.data.brandId, region: current.region, day: write.day, at: write.at, source: write.source, kind: "check", taskId: id, check: planned.checkRow }),
      );
    }
    if (rows.length === 0) return { ok: false, why: "unchanged", task: current };
    const next: WorkTask = { ...read.data, recent: withRecent(current.recent, rows) };
    const update: Record<string, unknown> = Object.fromEntries(Object.keys(patch).map((k) => [k, parsed[k] ?? null]));
    Object.assign(update, { open: next.open, hasCheck: next.hasCheck, recent: next.recent, updatedAt: write.at });
    txn.update(taskRef(store, id), update);
    for (const r of rows) stageRow(txn, store, r);
    return { ok: true, task: next, rows };
  });
}

/**
 * Delete a task (admins and owners), leaving its "deleted" row and every earlier row in the log.
 * Not found for another organisation's task.
 */
export async function deleteWorkTask(organisationId: string, id: string, region: Region, write: WorkWrite, stores: WorkStores = {}): Promise<{ ok: true; row: WorkLogRow } | { ok: false; why: "not_found" }> {
  if (!WORK_TASK_ID.test(id) || !organisationId) return { ok: false, why: "not_found" };
  checkSource(write.source);
  const store = regionStore(region, stores);
  return store.runTransaction(async (txn) => {
    const snap = await txn.get(taskRef(store, id));
    const current = snap.exists ? parseStored(organisationId, id, snap.data()) : null;
    if (!current) return { ok: false as const, why: "not_found" as const };
    const row = changeRow(current, write, "deleted", addedSnapshot(current), null);
    txn.delete(taskRef(store, id));
    stageRow(txn, store, row);
    return { ok: true as const, row };
  });
}

/** A log entry or a decision, as a caller writes it: the id is minted unless given. */
export type NewWorkLogRow = Omit<WorkLogRowOf<"entry">, "id"> | Omit<WorkLogRowOf<"decision">, "id">;

/**
 * Append log entries and decisions, create only, each in its region. A decision's task must be in
 * that region and the organisation's; changes and checks are written only with their task
 * (changeWorkTask). An id given that exists already is refused (TenantIsolationError).
 */
export async function appendWorkLog(rows: ReadonlyArray<NewWorkLogRow & { id?: string }>, stores: WorkStores = {}): Promise<WorkLogRow[]> {
  const parsed = rows.map((r) => {
    if ((r as { kind: string }).kind !== "entry" && (r as { kind: string }).kind !== "decision") invalid("log:only entries and decisions are appended; changes go with their task");
    if (r.id !== undefined && !WORK_LOG_ID.test(r.id)) invalid("log:id");
    checkSource(r.source);
    return parsedRow({ ...r, id: r.id ?? newWorkLogId() });
  });
  const byRegion = new Map<Region, WorkLogRow[]>();
  for (const r of parsed) byRegion.set(r.region, [...(byRegion.get(r.region) ?? []), r]);
  for (const [region, list] of byRegion) {
    const store = regionStore(region, stores);
    try {
      await store.runTransaction(async (txn) => {
        const tasks = [...new Set(list.filter((r) => r.kind === "decision").map((r) => r.taskId!))];
        for (const taskId of tasks) {
          const snap = await txn.get(taskRef(store, taskId));
          const orgs = new Set(list.filter((r) => r.taskId === taskId).map((r) => r.organisationId));
          if (!snap.exists || orgs.size !== 1 || snap.data()?.[ORG_FIELD] !== [...orgs][0]) invalid("log:a decision's task is in its region and organisation");
        }
        for (const r of list) stageRow(txn, store, r);
      });
    } catch (err) {
      if (isAlreadyExists(err)) throw new TenantIsolationError(`${WORK_LOG} row already exists; refusing to overwrite`);
      throw err;
    }
  }
  return parsed;
}

/** How a person's save of a note or decision Vizzy drafted moves the draft, written with the row. */
export interface DraftAccept {
  id: AgentActionId;
  by: EventActor;
  /** Refuse with "changed" unless the draft is still at this rev. */
  expectRev: number;
  /** The draft's result, from the row as it is stored: `{ logId, ... }`, never under `fields`. */
  result: (row: WorkLogRow) => Record<string, unknown>;
}

export type DraftedRowResult = { ok: true; row: WorkLogRow; action: AgentAction } | { ok: false; error: TransitionError };

/**
 * Save a log entry or a decision a person made from a draft of Vizzy's (draft_work_log,
 * draft_work_decision): the row, under the id the draft named as its target, and the draft's move
 * to acted with its result.
 *
 * - Where the row is kept in the region of the brand whose chat made the draft, both go in ONE
 *   transaction, reads first: the draft, the row's id, and a decision's task.
 * - Elsewhere (a decision on a task kept in another region) Firestore runs no transaction across
 *   databases (ADR-0002), so the draft is checked, the row is written, then the draft moves. Only
 *   this draft names the row's id, so a retry finds the row it wrote and only moves the draft.
 *
 * A draft decided already answers wrong_state, one that moved since it was read answers changed,
 * and nothing is written twice.
 */
export async function saveDraftedWorkLog(ctx: TenantContext, input: NewWorkLogRow & { id: string }, accept: DraftAccept, stores: WorkStores = {}): Promise<DraftedRowResult> {
  if ((input as { kind: string }).kind !== "entry" && (input as { kind: string }).kind !== "decision") invalid("log:a draft saves an entry or a decision");
  if (!WORK_LOG_ID.test(input.id)) invalid("log:id");
  checkSource(input.source);
  const row = parsedRow({ ...input });
  const actionStore = regionStore(ctx.region, stores);
  const rowStore = regionStore(row.region, stores);
  const ref = rowStore.collection(WORK_LOG).doc(row.id);

  const planFor = async (txn: TransactionLike, kept: WorkLogRow) => {
    const action = await readAgentActionTx(txn, actionStore, ctx, accept.id);
    if (!action || action.target.type !== "work_log" || action.target.id !== kept.id) return { ok: false as const, error: "not_found" as const };
    return planAgentTransition(action, { to: "acted", by: accept.by, at: kept.at, expectRev: accept.expectRev, result: accept.result(kept), clearDetails: false });
  };
  const checkTask = async (txn: TransactionLike): Promise<void> => {
    if (row.kind !== "decision") return;
    const snap = await txn.get(taskRef(rowStore, row.taskId));
    if (!snap.exists || snap.data()?.[ORG_FIELD] !== row.organisationId) invalid("log:a decision's task is in its region and organisation");
  };
  const storedRow = (snap: { exists: boolean; data(): Record<string, unknown> | undefined }): WorkLogRow => {
    const data = snap.data() ?? {};
    if (data[ORG_FIELD] !== row.organisationId) throw new TenantIsolationError(`${WORK_LOG}/${row.id} belongs to another organisation`);
    return parsedRow({ ...data, id: row.id });
  };

  if (row.region === ctx.region) {
    return retryOnceOnExists(() =>
      rowStore.runTransaction(async (txn): Promise<DraftedRowResult> => {
        const plan = await planFor(txn, row);
        const existing = await txn.get(ref);
        await checkTask(txn);
        if (!plan.ok) return { ok: false, error: plan.error };
        if (existing.exists) return { ok: false, error: "wrong_state" };
        stageRow(txn, rowStore, row);
        stageAgentTransition(txn, actionStore, ctx, plan);
        return { ok: true, row, action: plan.next };
      }),
    );
  }

  // Another region: the draft must still be open, at its rev, before the row is written.
  const first = await actionStore.runTransaction(async (txn) => planFor(txn, row));
  if (!first.ok) return { ok: false, error: first.error };
  const kept = await rowStore.runTransaction(async (txn): Promise<WorkLogRow> => {
    const existing = await txn.get(ref);
    await checkTask(txn);
    if (existing.exists) return storedRow(existing);
    stageRow(txn, rowStore, row);
    return row;
  });
  return retryOnceOnExists(() =>
    actionStore.runTransaction(async (txn): Promise<DraftedRowResult> => {
      const plan = await planFor(txn, kept);
      if (!plan.ok) return { ok: false, error: plan.error };
      stageAgentTransition(txn, actionStore, ctx, plan);
      return { ok: true, row: kept, action: plan.next };
    }),
  );
}

// --- Reads -------------------------------------------------------------------------------------

/** Rows read across regions: the regions that didn't answer, and how many stored rows didn't parse. */
export interface WorkRead<T> {
  rows: T[];
  unanswered: Region[];
  unreadable: number;
}

/** Every page of an equality read in one region, in document id order. */
async function allPages(build: () => QueryLike, limit: number = WORK_LIMITS.tasks): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const out: Array<{ id: string; data: Record<string, unknown> }> = [];
  let after: string | null = null;
  for (;;) {
    let q = build().orderBy("__name__", "asc");
    if (after) q = q.startAfter(after);
    const snap = await q.limit(Math.min(PAGE, limit - out.length)).get();
    for (const d of snap.docs) out.push({ id: d.id, data: d.data() });
    if (snap.docs.length < PAGE || out.length >= limit) break;
    after = snap.docs[snap.docs.length - 1]!.id;
  }
  return out;
}

/** Read every provisioned region, naming the ones that didn't answer. */
async function acrossRegions<T>(read: (region: Region) => Promise<{ rows: T[]; unreadable: number }>): Promise<WorkRead<T>> {
  const regions = provisionedRegions();
  const settled = await Promise.allSettled(regions.map((r) => read(r)));
  const out: WorkRead<T> = { rows: [], unanswered: [], unreadable: 0 };
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      out.rows.push(...s.value.rows);
      out.unreadable += s.value.unreadable;
    } else {
      console.warn(`[work] reading ${regions[i]} failed:`, s.reason instanceof Error ? s.reason.message.slice(0, 200) : "unknown");
      out.unanswered.push(regions[i]!);
    }
  });
  return out;
}

function tasksOf(organisationId: string, docs: ReadonlyArray<{ id: string; data: Record<string, unknown> }>): { rows: WorkTask[]; unreadable: number } {
  const rows: WorkTask[] = [];
  let unreadable = 0;
  for (const d of docs) {
    try {
      const t = parseStored(organisationId, d.id, d.data);
      if (t) rows.push(t);
    } catch {
      // A row this build can't read (a newer build's, after a rollback) is counted, never decided on.
      unreadable += 1;
    }
  }
  return { rows, unreadable };
}

function logRowsOf(organisationId: string, docs: ReadonlyArray<{ id: string; data: Record<string, unknown> }>): { rows: WorkLogRow[]; unreadable: number } {
  const rows: WorkLogRow[] = [];
  let unreadable = 0;
  for (const d of docs) {
    if (d.data[ORG_FIELD] !== organisationId) continue;
    const parsed = WorkLogRowSchema.safeParse({ ...d.data, id: d.id });
    if (parsed.success) rows.push(parsed.data);
    else unreadable += 1;
  }
  return { rows, unreadable };
}

/** A task by id in one region; null when missing or another organisation's. */
export async function getWorkTask(organisationId: string, id: string, region: Region, stores: WorkStores = {}): Promise<WorkTask | null> {
  if (!WORK_TASK_ID.test(id) || !organisationId) return null;
  const snap = await taskRef(regionStore(region, stores), id).get();
  return snap.exists ? parseStored(organisationId, id, snap.data()) : null;
}

/** A task by id wherever it is kept, with the regions that couldn't be read. */
export async function findWorkTask(organisationId: string, id: string, stores: WorkStores = {}): Promise<{ task: WorkTask | null; unanswered: Region[] }> {
  if (!WORK_TASK_ID.test(id) || !organisationId) return { task: null, unanswered: [] };
  const found = await acrossRegions(async (region) => {
    const t = await getWorkTask(organisationId, id, region, stores);
    return { rows: t ? [t] : [], unreadable: 0 };
  });
  return { task: found.rows[0] ?? null, unanswered: found.unanswered };
}

/** A log row by id wherever it is kept (the evidence Vizzy names on a suggestion); null when missing, another organisation's or unreadable. */
export async function findWorkLogRow(organisationId: string, id: string, stores: WorkStores = {}): Promise<{ row: WorkLogRow | null; unanswered: Region[] }> {
  if (!WORK_LOG_ID.test(id) || !organisationId) return { row: null, unanswered: [] };
  const found = await acrossRegions(async (region) => {
    const snap = await regionStore(region, stores).collection(WORK_LOG).doc(id).get();
    return snap.exists ? logRowsOf(organisationId, [{ id, data: snap.data() ?? {} }]) : { rows: [], unreadable: 0 };
  });
  return { row: found.rows[0] ?? null, unanswered: found.unanswered };
}

/** A task by its ref (equality on organisationId and ref, in every region), with the regions that couldn't be read. */
export async function findWorkTaskByRef(organisationId: string, ref: number, stores: WorkStores = {}): Promise<{ task: WorkTask | null; unanswered: Region[] }> {
  if (!organisationId || !Number.isInteger(ref) || ref < 1) return { task: null, unanswered: [] };
  const found = await acrossRegions(async (region) => {
    const snap = await regionStore(region, stores).collection(WORK_TASKS).where(ORG_FIELD, "==", organisationId).where("ref", "==", ref).limit(5).get();
    return tasksOf(
      organisationId,
      snap.docs.map((d) => ({ id: d.id, data: d.data() })),
    );
  });
  // Two with one ref can only follow a failed write: the first made is the one.
  const task = found.rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
  return { task, unanswered: found.unanswered };
}

/**
 * The organisation's tasks, open or not, in every region, with the regions that didn't answer.
 * - With no brand: (organisationId, open, closedAt desc), the list across brands, up to `limit`
 *   in each region, newest closed first.
 * - With a brand id, or null for whole business tasks: equality alone (organisationId, brandId,
 *   open), every page up to `limit`; the caller sorts.
 */
export async function listWorkTasks(
  organisationId: string,
  opts: { open: boolean; brandId?: string | null; limit?: number },
  stores: WorkStores = {},
): Promise<WorkRead<WorkTask>> {
  if (!organisationId) return { rows: [], unanswered: [], unreadable: 0 };
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? WORK_LIMITS.tasks)), WORK_LIMITS.tasks);
  return acrossRegions(async (region) => {
    const col = () => regionStore(region, stores).collection(WORK_TASKS).where(ORG_FIELD, "==", organisationId);
    if (opts.brandId === undefined) {
      const snap = await col().where("open", "==", opts.open).orderBy("closedAt", "desc").limit(limit).get();
      return tasksOf(
        organisationId,
        snap.docs.map((d) => ({ id: d.id, data: d.data() })),
      );
    }
    const docs = await allPages(() => col().where("brandId", "==", opts.brandId).where("open", "==", opts.open), limit);
    return tasksOf(organisationId, docs);
  });
}

/** The organisation's tasks with a check (equality on hasCheck, and on brandId when given); the caller decides which are due. */
export async function listWorkChecks(organisationId: string, opts: { brandId?: string | null } = {}, stores: WorkStores = {}): Promise<WorkRead<WorkTask>> {
  if (!organisationId) return { rows: [], unanswered: [], unreadable: 0 };
  return acrossRegions(async (region) => {
    const docs = await allPages(() => {
      let q: QueryLike = regionStore(region, stores).collection(WORK_TASKS).where(ORG_FIELD, "==", organisationId).where("hasCheck", "==", true);
      if (opts.brandId !== undefined) q = q.where("brandId", "==", opts.brandId);
      return q;
    });
    return tasksOf(organisationId, docs);
  });
}

/** How many tasks the organisation has, in every region (the 5,000 cap), with the regions that didn't answer. */
export async function countWorkTasks(organisationId: string, stores: WorkStores = {}): Promise<{ count: number; unanswered: Region[] }> {
  const r = await acrossRegions(async (region) => {
    const snap = await regionStore(region, stores).collection(WORK_TASKS).where(ORG_FIELD, "==", organisationId).count().get();
    return { rows: [snap.data().count], unreadable: 0 };
  });
  return { count: r.rows.reduce((a, b) => a + b, 0), unanswered: r.unanswered };
}

/**
 * The organisation's log between two times, newest first, in every region (organisationId, at
 * desc), up to `limit` in each, with the regions that didn't answer. Brand view filters by brand
 * in memory.
 */
export async function listWorkLog(organisationId: string, opts: { from: string; to: string; limit?: number }, stores: WorkStores = {}): Promise<WorkRead<WorkLogRow>> {
  if (!organisationId) return { rows: [], unanswered: [], unreadable: 0 };
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 2000)), 5000);
  const r = await acrossRegions(async (region) => {
    const snap = await regionStore(region, stores)
      .collection(WORK_LOG)
      .where(ORG_FIELD, "==", organisationId)
      .where("at", ">=", opts.from)
      .where("at", "<", opts.to)
      .orderBy("at", "desc")
      .limit(limit)
      .get();
    return logRowsOf(
      organisationId,
      snap.docs.map((d) => ({ id: d.id, data: d.data() })),
    );
  });
  r.rows.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  return r;
}

/** One task's log rows in its region, of one kind when given (equality alone), oldest first. */
export async function listTaskLog(organisationId: string, region: Region, taskId: string, opts: { kind?: WorkLogRow["kind"] } = {}, stores: WorkStores = {}): Promise<{ rows: WorkLogRow[]; unreadable: number }> {
  if (!organisationId || !WORK_TASK_ID.test(taskId)) return { rows: [], unreadable: 0 };
  const docs = await allPages(() => {
    let q: QueryLike = regionStore(region, stores).collection(WORK_LOG).where(ORG_FIELD, "==", organisationId).where("taskId", "==", taskId);
    if (opts.kind) q = q.where("kind", "==", opts.kind);
    return q;
  }, 20_000);
  const out = logRowsOf(organisationId, docs);
  out.rows.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return out;
}

/** A task's decisions (the 50 cap), oldest first. */
export async function listTaskDecisions(organisationId: string, region: Region, taskId: string, stores: WorkStores = {}): Promise<WorkLogRowOf<"decision">[]> {
  const { rows } = await listTaskLog(organisationId, region, taskId, { kind: "decision" }, stores);
  return rows.filter((r): r is WorkLogRowOf<"decision"> => r.kind === "decision");
}

/** How many rows of one kind the organisation wrote on one day, in every region (the 500 entries a day cap). */
export async function countWorkLog(organisationId: string, opts: { day: string; kind: WorkLogRow["kind"] }, stores: WorkStores = {}): Promise<{ count: number; unanswered: Region[] }> {
  const r = await acrossRegions(async (region) => {
    const snap = await regionStore(region, stores).collection(WORK_LOG).where(ORG_FIELD, "==", organisationId).where("day", "==", opts.day).where("kind", "==", opts.kind).count().get();
    return { rows: [snap.data().count], unreadable: 0 };
  });
  return { count: r.rows.reduce((a, b) => a + b, 0), unanswered: r.unanswered };
}

// --- Erase and moves ---------------------------------------------------------------------------

export interface WorkEraseCounts {
  tasks: number;
  rows: number;
  /** The organisation's task counter was there and is gone. */
  refs: boolean;
}

/** Delete every document of one organisation in one collection, a page at a time. */
async function deleteAllWhere(store: FirestoreLike, col: () => CollectionLike, organisationId: string): Promise<number> {
  let n = 0;
  for (;;) {
    const page = await col().where(ORG_FIELD, "==", organisationId).limit(PAGE).get();
    if (page.empty) break;
    await store.runTransaction(async (txn) => {
      for (const d of page.docs) txn.delete(col().doc(d.id));
    });
    n += page.docs.length;
  }
  return n;
}

/**
 * Erase an organisation's Work: every task and log row under its id in every provisioned region,
 * then its task counter. Run when an empty organisation id is taken up again (Connectors 3's take
 * up: a new brand, the backfill, move-brand --to new and Move out), so the new owners start with no
 * Work, whatever WORK_ENABLED says. Every region is tried; one that fails throws at the end, so a
 * take up never goes ahead on silence.
 */
export async function eraseOrganisationWork(organisationId: string, by: string, stores: WorkStores = {}): Promise<WorkEraseCounts> {
  if (!organisationId || !organisationId.startsWith("org_")) invalid("organisationId");
  const out: WorkEraseCounts = { tasks: 0, rows: 0, refs: false };
  const failed: Region[] = [];
  for (const region of provisionedRegions()) {
    try {
      const store = regionStore(region, stores);
      out.tasks += await deleteAllWhere(store, () => store.collection(WORK_TASKS), organisationId);
      out.rows += await deleteAllWhere(store, () => store.collection(WORK_LOG), organisationId);
    } catch (err) {
      console.warn(`[work] erasing ${organisationId} in ${region} failed:`, err instanceof Error ? err.message.slice(0, 200) : "unknown");
      failed.push(region);
    }
  }
  if (failed.length) throw new Error(`work_erase_failed:${failed.join(",")}`);
  out.refs = await deleteWorkRefs(organisationId, stores.controlDb);
  if (out.tasks || out.rows) console.log(`[work] erased ${out.tasks} tasks and ${out.rows} log rows of ${organisationId} (by ${by.slice(0, 80)})`);
  return out;
}

/** Who a move is by: a member's user id, or an operator's label (script:<label>). */
function moveWho(by: string): WorkWho {
  const id = by.slice(0, 128).replace(/[^A-Za-z0-9_.:-]/g, "_") || "system";
  return by.startsWith("script:") || by === "system" ? { kind: "system", id } : { kind: "person", id };
}

/**
 * After a brand moved from one organisation to another (move-brand, Bring in, Move out): its
 * tasks, and the log rows of its tasks and its entries, move with it, in the brand's own region (a
 * move never changes a brand's region). Each task takes a new ref from the organisation it joins,
 * so two never share one, with change rows for its organisation and ref. Whole business tasks stay
 * with the organisation, and so do their rows, even those filed under the brand before a change of
 * brand. Equality reads only. Whatever WORK_ENABLED says.
 */
export async function repointBrandWork(
  brand: { tenantId: string; region: Region },
  fromOrganisationId: string,
  toOrganisationId: string,
  by: string,
  stores: WorkStores = {},
  now: Date = new Date(),
): Promise<{ tasks: number; rows: number }> {
  if (!fromOrganisationId || !toOrganisationId || fromOrganisationId === toOrganisationId) return { tasks: 0, rows: 0 };
  if (!toOrganisationId.startsWith("org_")) invalid("toOrganisationId");
  const store = regionStore(brand.region, stores);
  const at = now.toISOString();
  const write: WorkWrite = { source: { who: moveWho(by), tool: "brand_move", session: null }, at, day: at.slice(0, 10) };
  const docs = await allPages(() => store.collection(WORK_TASKS).where(ORG_FIELD, "==", fromOrganisationId).where("brandId", "==", brand.tenantId));
  const { rows: tasks } = tasksOf(fromOrganisationId, docs);
  tasks.sort((a, b) => a.ref - b.ref);
  let moved = 0;
  if (tasks.length) {
    const first = await allocateWorkRefs(toOrganisationId, tasks.length, stores.controlDb, now);
    for (const [i, t] of tasks.entries()) {
      const ref = first + i;
      const done = await store.runTransaction(async (txn) => {
        const snap = await txn.get(taskRef(store, t.id));
        const current = snap.exists ? parseStored(fromOrganisationId, t.id, snap.data()) : null;
        if (!current || current.brandId !== brand.tenantId) return false;
        const moveRows = [
          changeRow({ ...current, organisationId: toOrganisationId }, write, "organisationId", fromOrganisationId, toOrganisationId),
          changeRow({ ...current, organisationId: toOrganisationId }, write, "ref", current.ref, ref),
        ];
        txn.update(taskRef(store, t.id), { [ORG_FIELD]: toOrganisationId, ref, recent: withRecent(current.recent, moveRows), updatedAt: at });
        for (const r of moveRows) stageRow(txn, store, r);
        return true;
      });
      if (done) moved += 1;
    }
  }
  // The tasks that stay: every task still in the organisation in this region (whole business, or
  // tagged with another brand). Rows about them stay too, even those filed under this brand from
  // before a change of brand, so their history and decisions never leave the organisation.
  const staying = new Set(
    (await allPages(() => store.collection(WORK_TASKS).where(ORG_FIELD, "==", fromOrganisationId))).map((d) => d.id),
  );
  // Their rows: the brand's own, and every row of a task that moved (rows written before it named the brand).
  const rowIds = new Set<string>();
  for (const d of await allPages(() => store.collection(WORK_LOG).where(ORG_FIELD, "==", fromOrganisationId).where("brandId", "==", brand.tenantId), 50_000)) {
    const about = d.data.taskId;
    if (typeof about === "string" && staying.has(about)) continue;
    rowIds.add(d.id);
  }
  for (const t of tasks) {
    for (const d of await allPages(() => store.collection(WORK_LOG).where(ORG_FIELD, "==", fromOrganisationId).where("taskId", "==", t.id), 50_000)) rowIds.add(d.id);
  }
  const ids = [...rowIds];
  for (let i = 0; i < ids.length; i += PAGE) {
    const page = ids.slice(i, i + PAGE);
    await store.runTransaction(async (txn) => {
      for (const id of page) txn.update(store.collection(WORK_LOG).doc(id), { [ORG_FIELD]: toOrganisationId });
    });
  }
  return { tasks: moved, rows: ids.length };
}

/** How many of a brand's tasks a move would take along (move-brand's dry run). */
export async function countBrandWork(brand: { tenantId: string; region: Region }, organisationId: string, stores: WorkStores = {}): Promise<number> {
  const snap = await regionStore(brand.region, stores).collection(WORK_TASKS).where(ORG_FIELD, "==", organisationId).where("brandId", "==", brand.tenantId).count().get();
  return snap.data().count;
}
