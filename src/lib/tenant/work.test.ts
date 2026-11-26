import { beforeEach, describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { failingFirestore } from "./testing/failingFirestore";
import { shapeRecordingFirestore } from "./testing/queryShape";
import { TenantIsolationError, TenantValidationError } from "./errors";
import {
  appendWorkLog,
  changeWorkTask,
  countBrandWork,
  countWorkLog,
  countWorkTasks,
  createSuggestedWorkTask,
  createWorkTask,
  deleteWorkTask,
  eraseOrganisationWork,
  findWorkTask,
  findWorkTaskByRef,
  getWorkTask,
  listTaskDecisions,
  listTaskLog,
  listWorkChecks,
  listWorkLog,
  listWorkTasks,
  newWorkImportId,
  newWorkLogId,
  newWorkTaskId,
  repointBrandWork,
  WORK_LOG,
  WORK_TASKS,
  type NewWorkLogRow,
  type WorkStores,
} from "./work";
import { allocateWorkRefs, deleteWorkRefs, peekWorkRefs, raiseWorkRefs, WORK_REFS } from "./workRefs";
import { proposeAgentAction } from "./agentActions";
import { readsFirst } from "./testing/readsFirst";
import type { TenantContext } from "./types";
import type { Region } from "@/lib/types/tenant";
import { aTask, aWrite, LUMEN_EU, LUMEN_US, NINA, ORG, OTHER_ORG, PERSON, SAM, T0, T1 } from "@/lib/work/testing/fixtures";
import { PLAN_APPROVAL_OPTIONS, PLAN_APPROVAL_QUESTION, WORK_LIMITS, type WorkCheckRow } from "@/lib/work/types";

let us: FakeFirestore;
let eu: FakeFirestore;
let asia: FakeFirestore;
let control: FakeFirestore;
let stores: WorkStores;
const by = (eu_: FakeFirestore, us_: FakeFirestore, asia_: FakeFirestore) => (r: Region) => (r === "eu" ? eu_ : r === "us" ? us_ : asia_);

beforeEach(() => {
  us = new FakeFirestore();
  eu = new FakeFirestore();
  asia = new FakeFirestore();
  control = new FakeFirestore();
  stores = { regionDb: by(eu, us, asia), controlDb: control };
});

const rowsOf = (db: FakeFirestore) => db.dump(WORK_LOG);

describe("ids", () => {
  it("are random and shaped wt_, wl_ and wi_", () => {
    expect(newWorkTaskId()).toMatch(/^wt_[a-z2-7]{20}$/);
    expect(newWorkTaskId()).not.toBe(newWorkTaskId());
    expect(newWorkLogId()).toMatch(/^wl_[0-9a-f]{24}$/);
    expect(newWorkImportId()).toMatch(/^wi_[0-9a-f]{16}$/);
  });
});

describe("making a task", () => {
  it("keeps it in its region with its added row, in one transaction, and works out open and hasCheck itself", async () => {
    const input = aTask({ region: "eu", brandId: LUMEN_EU, addedFrom: LUMEN_EU });
    const { task, rows } = await createWorkTask({ ...input, open: false, hasCheck: true } as never, aWrite(), stores);
    expect(task).toMatchObject({ open: true, hasCheck: false, createdAt: T0, updatedAt: T0, closedAt: null });
    expect(eu.raw(WORK_TASKS, task.id)).toMatchObject({ organisationId: ORG, brandId: LUMEN_EU, region: "eu", ref: 1, open: true, closedAt: null });
    expect(us.dump(WORK_TASKS)).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rowsOf(eu)).toEqual([
      expect.objectContaining({ kind: "change", field: "added", taskId: task.id, before: null, after: expect.objectContaining({ ref: 1, title: "Add a G2 listing", origin: "person", stage: "market" }), day: "2026-11-20" }),
    ]);
    expect(task.recent).toEqual([{ at: T0, field: "added", who: PERSON.who }]);
  });

  it("refuses an id that exists, a coding agent's origin or source, and a bad shape, writing nothing", async () => {
    const t = aTask();
    await createWorkTask(t, aWrite(), stores);
    await expect(createWorkTask({ ...t, title: "Again" }, aWrite(), stores)).rejects.toThrow(TenantIsolationError);
    expect(us.dump(WORK_TASKS)).toHaveLength(1);
    await expect(createWorkTask(aTask({ origin: { kind: "coding_agent", tool: "claude_code", session: "s1", keyId: "k1" } }), aWrite(), stores)).rejects.toThrow(TenantValidationError);
    await expect(createWorkTask(aTask(), aWrite({ source: { who: { kind: "coding_agent", id: "k1" }, tool: "mcp", session: null } }), stores)).rejects.toThrow(TenantValidationError);
    await expect(createWorkTask(aTask({ id: "wt_short" }), aWrite(), stores)).rejects.toThrow(TenantValidationError);
    await expect(createWorkTask(aTask({ title: "" }), aWrite(), stores)).rejects.toThrow(TenantValidationError);
    expect(us.dump(WORK_TASKS)).toHaveLength(1);
    expect(rowsOf(us)).toHaveLength(1);
  });
});

describe("changing a task", () => {
  it("writes one change row per field that changed, with the value before and after, and keeps the short ones on the task", async () => {
    const { task } = await createWorkTask(aTask(), aWrite(), stores);
    const long = "Step one. ".repeat(300);
    const r = await changeWorkTask(ORG, task.id, "us", () => ({ patch: { status: "in_progress", stage: "build", description: long, title: task.title } }), aWrite({ at: T1, day: "2026-11-21" }), stores);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.kind === "change" && x.field)).toEqual(["status", "stage", "description"]);
    const desc = rowsOf(us).find((x) => x.field === "description")!;
    expect(desc).toMatchObject({ before: "", after: long, day: "2026-11-21" });
    expect(r.task.recent.slice(0, 3)).toEqual([
      expect.objectContaining({ field: "description", before: "", after: expect.stringMatching(/…$/) }),
      expect.objectContaining({ field: "stage", before: "market", after: "build" }),
      expect.objectContaining({ field: "status", before: "todo", after: "in_progress" }),
    ]);
    expect(us.raw(WORK_TASKS, task.id)).toMatchObject({ status: "in_progress", stage: "build", updatedAt: T1 });
  });

  it("writes nothing when nothing changed, and never changes the identity fields", async () => {
    const { task } = await createWorkTask(aTask(), aWrite(), stores);
    const before = us.writeCountFor(WORK_TASKS, task.id);
    expect(await changeWorkTask(ORG, task.id, "us", () => ({ patch: { title: task.title } }), aWrite(), stores)).toMatchObject({ ok: false, why: "unchanged" });
    expect(await changeWorkTask(ORG, task.id, "us", () => null, aWrite(), stores)).toMatchObject({ ok: false, why: "unchanged" });
    const sneaky = { organisationId: OTHER_ORG, ref: 99, region: "eu", origin: { kind: "import" }, open: false } as never;
    expect(await changeWorkTask(ORG, task.id, "us", () => ({ patch: sneaky }), aWrite(), stores)).toMatchObject({ ok: false, why: "unchanged" });
    expect(us.writeCountFor(WORK_TASKS, task.id)).toBe(before);
    expect(us.raw(WORK_TASKS, task.id)).toMatchObject({ organisationId: ORG, ref: 1, region: "us" });
    expect(rowsOf(us)).toHaveLength(1);
  });

  it("closes a Done task, but keeps it open while its measure's check waits for a read", async () => {
    const { task } = await createWorkTask(aTask(), aWrite(), stores);
    const done = await changeWorkTask(ORG, task.id, "us", () => ({ patch: { status: "done", closedAt: T1 } }), aWrite({ at: T1 }), stores);
    expect(done).toMatchObject({ ok: true, task: { open: false, closedAt: T1 } });
    // closedAt goes with the status: one row.
    expect(rowsOf(us).filter((x) => x.kind === "change" && x.field !== "added").map((x) => x.field)).toEqual(["status"]);

    const measured = await createWorkTask(aTask({ ref: 2, measure: { kind: "used", counts: { none: "" }, look: { days: 14 }, setBy: NINA, setAt: T0 } }), aWrite(), stores);
    const check = { kind: "date" as const, at: "2026-12-05T08:00:00.000Z", taskId: null, note: "", setBy: "measure", setAt: T1, which: "first" as const };
    const r = await changeWorkTask(ORG, measured.task.id, "us", () => ({ patch: { status: "done", closedAt: T1, check } }), aWrite({ at: T1 }), stores);
    expect(r).toMatchObject({ ok: true, task: { open: true, hasCheck: true, status: "done" } });
    expect(us.raw(WORK_TASKS, measured.task.id)).toMatchObject({ open: true, hasCheck: true });
  });

  it("records a check marked or read as a check row, not a change of the check field", async () => {
    const check = { kind: "date" as const, at: T1, taskId: null, note: "Look again", setBy: NINA, setAt: T0, which: null };
    const { task } = await createWorkTask(aTask({ check }), aWrite(), stores);
    const row: WorkCheckRow = { action: "checked", kind: "date", at: T1, next: null, measureKind: null, which: null, counted: null, read: null };
    const r = await changeWorkTask(ORG, task.id, "us", () => ({ patch: { check: null }, checkRow: row }), aWrite({ at: T1 }), stores);
    expect(r).toMatchObject({ ok: true, task: { check: null, hasCheck: false } });
    const rows = rowsOf(us).filter((x) => x.field !== "added");
    expect(rows).toEqual([expect.objectContaining({ kind: "check", taskId: task.id, check: row })]);
    expect(r.ok && r.task.recent[0]).toMatchObject({ field: "check", after: "checked" });
  });

  it("refuses a change the task can't hold, and reads another organisation's task as not found", async () => {
    const { task } = await createWorkTask(aTask(), aWrite(), stores);
    await expect(changeWorkTask(ORG, task.id, "us", () => ({ patch: { status: "done" } }), aWrite(), stores)).rejects.toThrow(TenantValidationError);
    await expect(changeWorkTask(ORG, task.id, "us", () => ({ patch: { colour: "red" } as never }), aWrite(), stores)).rejects.toThrow(TenantValidationError);
    expect(await changeWorkTask(OTHER_ORG, task.id, "us", () => ({ patch: { title: "Mine now" } }), aWrite(), stores)).toEqual({ ok: false, why: "not_found" });
    expect(await changeWorkTask(ORG, task.id, "eu", () => ({ patch: { title: "Wrong region" } }), aWrite(), stores)).toEqual({ ok: false, why: "not_found" });
    expect(us.raw(WORK_TASKS, task.id)).toMatchObject({ title: "Add a G2 listing" });
  });

  it("keeps the last 20 changes on the task and every change in the log", async () => {
    const { task } = await createWorkTask(aTask(), aWrite(), stores);
    for (let i = 0; i < 25; i++) await changeWorkTask(ORG, task.id, "us", () => ({ patch: { notes: `note ${i}` } }), aWrite(), stores);
    const stored = (await getWorkTask(ORG, task.id, "us", stores))!;
    expect(stored.recent).toHaveLength(WORK_LIMITS.recent);
    expect(stored.recent[0]).toMatchObject({ field: "notes", after: "note 24" });
    expect(rowsOf(us)).toHaveLength(26);
  });

  it("stores what the schema read, never a key it doesn't know", async () => {
    const { task } = await createWorkTask(aTask(), aWrite(), stores);
    const measure = { kind: "done", setBy: NINA, setAt: T0, look: { days: 7 }, secret: "x" } as never;
    await changeWorkTask(ORG, task.id, "us", () => ({ patch: { measure } }), aWrite(), stores);
    expect(us.raw(WORK_TASKS, task.id)!.measure).toEqual({ kind: "done", setBy: NINA, setAt: T0 });
  });

  it("files a change of brand under the brand the task names now", async () => {
    const { task } = await createWorkTask(aTask({ brandId: null }), aWrite(), stores);
    await changeWorkTask(ORG, task.id, "us", () => ({ patch: { brandId: LUMEN_US } }), aWrite(), stores);
    expect(rowsOf(us).find((x) => x.field === "brandId")).toMatchObject({ brandId: LUMEN_US, before: null, after: LUMEN_US });
  });
});

describe("deleting a task", () => {
  it("removes the task and keeps its log, with a deleted row", async () => {
    const { task } = await createWorkTask(aTask(), aWrite(), stores);
    expect(await deleteWorkTask(OTHER_ORG, task.id, "us", aWrite(), stores)).toEqual({ ok: false, why: "not_found" });
    const r = await deleteWorkTask(ORG, task.id, "us", aWrite({ at: T1 }), stores);
    expect(r.ok).toBe(true);
    expect(us.raw(WORK_TASKS, task.id)).toBeUndefined();
    expect(rowsOf(us).map((x) => x.field)).toEqual(["added", "deleted"]);
    expect(rowsOf(us)[1]).toMatchObject({ before: expect.objectContaining({ ref: 1, title: "Add a G2 listing" }), after: null });
  });
});

describe("the log", () => {
  const entry = (over: Partial<NewWorkLogRow> = {}): NewWorkLogRow =>
    ({ organisationId: ORG, brandId: LUMEN_US, region: "us", day: "2026-11-20", at: T0, source: PERSON, kind: "entry", taskId: null, workstream: "Onboarding emails", state: "doing", note: "", links: [], ...over }) as NewWorkLogRow;

  it("appends entries and decisions, create only, each in its region", async () => {
    const { task } = await createWorkTask(aTask({ region: "eu", brandId: LUMEN_EU, addedFrom: LUMEN_EU }), aWrite(), stores);
    const decision = {
      organisationId: ORG,
      brandId: LUMEN_EU,
      region: "eu" as const,
      day: "2026-11-20",
      at: T1,
      source: PERSON,
      kind: "decision" as const,
      taskId: task.id,
      decision: { question: PLAN_APPROVAL_QUESTION, options: [...PLAN_APPROVAL_OPTIONS], recommended: null, chosen: { option: "b" as const, by: NINA }, agreed: null, why: "Needs the import first.", replaces: null, plan: { url: "https://docs.example.com/plan", version: "v1" } },
    };
    const rows = await appendWorkLog([entry(), decision], stores);
    expect(rows.map((r) => r.id)).toEqual([expect.stringMatching(/^wl_/), expect.stringMatching(/^wl_/)]);
    expect(rowsOf(us)).toEqual([expect.objectContaining({ kind: "entry", workstream: "Onboarding emails" })]);
    expect(rowsOf(eu).map((r) => r.kind)).toEqual(["change", "decision"]);
    expect(await listTaskDecisions(ORG, "eu", task.id, stores)).toEqual([expect.objectContaining({ kind: "decision", decision: expect.objectContaining({ plan: { url: "https://docs.example.com/plan", version: "v1" } }) })]);

    // A decision's task must be in its region and organisation.
    await expect(appendWorkLog([{ ...decision, region: "us" }], stores)).rejects.toThrow(TenantValidationError);
    await expect(appendWorkLog([{ ...decision, organisationId: OTHER_ORG }], stores)).rejects.toThrow(TenantValidationError);
    // Changes and checks go only with their task.
    await expect(appendWorkLog([{ ...entry(), kind: "change", taskId: task.id, field: "title", before: "a", after: "b" } as never], stores)).rejects.toThrow(TenantValidationError);
    // Append only: an id given that exists is refused, never overwritten.
    const id = rows[0]!.id;
    await expect(appendWorkLog([{ ...entry({ workstream: "Rewritten" }), id }], stores)).rejects.toThrow(TenantIsolationError);
    expect(us.raw(WORK_LOG, id)).toMatchObject({ workstream: "Onboarding emails" });
  });

  it("reads a day across regions, newest first, through (organisationId, at)", async () => {
    await appendWorkLog([entry({ at: "2026-11-20T08:00:00.000Z" }), entry({ region: "eu", brandId: LUMEN_EU, at: "2026-11-20T10:00:00.000Z" }), entry({ at: "2026-11-21T08:00:00.000Z", day: "2026-11-21" })], stores);
    await appendWorkLog([entry({ organisationId: OTHER_ORG })], stores);
    const ops: string[] = [];
    const recorded = { regionDb: by(eu, shapeRecordingFirestore(us, ops), asia), controlDb: control };
    const day = await listWorkLog(ORG, { from: "2026-11-20T00:00:00.000Z", to: "2026-11-21T00:00:00.000Z" }, recorded);
    expect(day.rows.map((r) => r.at)).toEqual(["2026-11-20T10:00:00.000Z", "2026-11-20T08:00:00.000Z"]);
    expect(day.unanswered).toEqual([]);
    expect(ops).toEqual(["where organisationId ==", "where at >=", "where at <", "orderBy at"]);
    expect(await countWorkLog(ORG, { day: "2026-11-20", kind: "entry" }, stores)).toEqual({ count: 2, unanswered: [] });
  });

  it("names a region that didn't answer, and still reads the others", async () => {
    await appendWorkLog([entry(), entry({ region: "eu", brandId: LUMEN_EU })], stores);
    const down = { regionDb: by(failingFirestore(eu, { collections: [WORK_LOG] }), us, asia), controlDb: control };
    const day = await listWorkLog(ORG, { from: "2026-11-20T00:00:00.000Z", to: "2026-11-21T00:00:00.000Z" }, down);
    expect(day.rows).toHaveLength(1);
    expect(day.unanswered).toEqual(["eu"]);
  });

  it("has no time to live on any row", async () => {
    const { task } = await createWorkTask(aTask(), aWrite(), stores);
    await changeWorkTask(ORG, task.id, "us", () => ({ patch: { status: "in_progress" } }), aWrite(), stores);
    await appendWorkLog([entry()], stores);
    await deleteWorkTask(ORG, task.id, "us", aWrite(), stores);
    expect(rowsOf(us).length).toBe(4);
    for (const r of rowsOf(us)) {
      expect(r).not.toHaveProperty("ttlAt");
      expect(r).not.toHaveProperty("ttl");
    }
    const t2 = await createWorkTask(aTask({ ref: 2 }), aWrite(), stores);
    expect(us.raw(WORK_TASKS, t2.task.id)).not.toHaveProperty("ttlAt");
  });

  it("reads one task's rows by equality alone, oldest first", async () => {
    const { task } = await createWorkTask(aTask(), aWrite(), stores);
    await changeWorkTask(ORG, task.id, "us", () => ({ patch: { status: "in_progress" } }), aWrite({ at: T1 }), stores);
    const ops: string[] = [];
    const recorded = { regionDb: by(eu, shapeRecordingFirestore(us, ops), asia) };
    const { rows } = await listTaskLog(ORG, "us", task.id, {}, recorded);
    expect(rows.map((r) => r.kind === "change" && r.field)).toEqual(["added", "status"]);
    expect(ops.filter((o) => o.startsWith("where") || o.startsWith("orderBy"))).toEqual(["where organisationId ==", "where taskId ==", "orderBy __name__"]);
  });
});

describe("the list across regions", () => {
  async function seed() {
    const a = await createWorkTask(aTask({ ref: 1, title: "US task" }), aWrite(), stores);
    const b = await createWorkTask(aTask({ ref: 2, title: "EU task", region: "eu", brandId: LUMEN_EU, addedFrom: LUMEN_EU }), aWrite(), stores);
    const c = await createWorkTask(aTask({ ref: 3, title: "Whole business", brandId: null }), aWrite(), stores);
    const d = await createWorkTask(aTask({ ref: 4, title: "Shipped", status: "done", closedAt: T1 }), aWrite(), stores);
    await createWorkTask(aTask({ ref: 1, organisationId: OTHER_ORG, title: "Fernhill's" }), aWrite(), stores);
    return { a: a.task, b: b.task, c: c.task, d: d.task };
  }

  it("merges every region's open tasks through (organisationId, open, closedAt), and never another organisation's", async () => {
    await seed();
    const ops: string[] = [];
    const recorded = { regionDb: by(shapeRecordingFirestore(eu, ops), us, asia) };
    const open = await listWorkTasks(ORG, { open: true }, recorded);
    expect(open.rows.map((t) => t.title).sort()).toEqual(["EU task", "US task", "Whole business"]);
    expect(ops).toEqual(["where organisationId ==", "where open ==", "orderBy closedAt"]);
    expect((await listWorkTasks(ORG, { open: false }, stores)).rows.map((t) => t.title)).toEqual(["Shipped"]);
  });

  it("filters by brand, or whole business, by equality alone", async () => {
    await seed();
    const ops: string[] = [];
    const recorded = { regionDb: by(eu, shapeRecordingFirestore(us, ops), asia) };
    expect((await listWorkTasks(ORG, { open: true, brandId: LUMEN_US }, recorded)).rows.map((t) => t.title)).toEqual(["US task"]);
    expect(ops.filter((o) => o.startsWith("orderBy"))).toEqual(["orderBy __name__"]);
    expect(ops.filter((o) => o.startsWith("where"))).toEqual(["where organisationId ==", "where brandId ==", "where open =="]);
    expect((await listWorkTasks(ORG, { open: true, brandId: null }, stores)).rows.map((t) => t.title)).toEqual(["Whole business"]);
    expect((await listWorkTasks(ORG, { open: true, brandId: LUMEN_EU }, stores)).rows.map((t) => t.title)).toEqual(["EU task"]);
  });

  it("names a region that didn't answer and lists the rest, and counts a row it can't read", async () => {
    await seed();
    us.seed(WORK_TASKS, "wt_zzzzzzzzzzzzzzzzzzzz", { organisationId: ORG, open: true, closedAt: null, title: 42 });
    const down = { regionDb: by(failingFirestore(eu, { collections: [WORK_TASKS] }), us, asia) };
    const r = await listWorkTasks(ORG, { open: true }, down);
    expect(r.rows.map((t) => t.title).sort()).toEqual(["US task", "Whole business"]);
    expect(r.unanswered).toEqual(["eu"]);
    expect(r.unreadable).toBe(1);
    const noIndex = { regionDb: by(failingFirestore(eu, { ordered: [WORK_TASKS] }), us, asia) };
    expect((await listWorkTasks(ORG, { open: true }, noIndex)).unanswered).toEqual(["eu"]);
  });

  it("finds a task by id or by ref in whichever region keeps it", async () => {
    const { b } = await seed();
    expect((await findWorkTask(ORG, b.id, stores)).task?.title).toBe("EU task");
    expect((await findWorkTask(OTHER_ORG, b.id, stores)).task).toBeNull();
    expect((await findWorkTaskByRef(ORG, 2, stores)).task?.id).toBe(b.id);
    expect((await findWorkTaskByRef(ORG, 9, stores)).task).toBeNull();
    expect((await findWorkTaskByRef(OTHER_ORG, 1, stores)).task?.title).toBe("Fernhill's");
    const down = { regionDb: by(failingFirestore(eu, { collections: [WORK_TASKS] }), us, asia) };
    expect(await findWorkTaskByRef(ORG, 2, down)).toEqual({ task: null, unanswered: ["eu"] });
  });

  it("counts the organisation's tasks in every region, for the 5,000 cap", async () => {
    await seed();
    expect(await countWorkTasks(ORG, stores)).toEqual({ count: 4, unanswered: [] });
    expect(await countWorkTasks(OTHER_ORG, stores)).toEqual({ count: 1, unanswered: [] });
  });

  it("lists the tasks with a check by equality alone, for the caller to decide which are due", async () => {
    await seed();
    const check = { kind: "date" as const, at: T1, taskId: null, note: "", setBy: NINA, setAt: T0, which: null };
    const t = await createWorkTask(aTask({ ref: 5, region: "eu", brandId: LUMEN_EU, addedFrom: LUMEN_EU, check }), aWrite(), stores);
    const ops: string[] = [];
    const r = await listWorkChecks(ORG, {}, { regionDb: by(shapeRecordingFirestore(eu, ops), us, asia) });
    expect(r.rows.map((x) => x.id)).toEqual([t.task.id]);
    expect(ops).toEqual(["where organisationId ==", "where hasCheck ==", "orderBy __name__"]);
    expect((await listWorkChecks(ORG, { brandId: LUMEN_US }, stores)).rows).toEqual([]);
  });
});

describe("refs", () => {
  it("are taken in order per organisation, never twice, and raised past an import's highest", async () => {
    expect(await allocateWorkRefs(ORG, 1, control)).toBe(1);
    expect(await allocateWorkRefs(ORG, 3, control)).toBe(2);
    expect(await allocateWorkRefs(ORG, 1, control)).toBe(5);
    expect(await allocateWorkRefs(OTHER_ORG, 1, control)).toBe(1);
    expect(await raiseWorkRefs(ORG, 73, control)).toBe(74);
    expect(await raiseWorkRefs(ORG, 10, control)).toBe(74);
    expect(await peekWorkRefs(ORG, control)).toBe(74);
    expect(await allocateWorkRefs(ORG, 1, control)).toBe(74);
    expect(control.raw(WORK_REFS, ORG)).toMatchObject({ organisationId: ORG, next: 75 });
    await expect(allocateWorkRefs("ten_lumen", 1, control)).rejects.toThrow(TenantValidationError);
    await expect(allocateWorkRefs(ORG, 0, control)).rejects.toThrow(TenantValidationError);
  });

  it("gives two writers racing for one ref a ref each", async () => {
    let raced: number | undefined;
    control.onBeforeCommit = async () => {
      raced = await allocateWorkRefs(ORG, 1, control);
    };
    const mine = await allocateWorkRefs(ORG, 1, control);
    expect(new Set([mine, raced]).size).toBe(2);
    expect(await peekWorkRefs(ORG, control)).toBe(3);
  });

  it("are forgotten with the organisation's Work", async () => {
    await allocateWorkRefs(ORG, 2, control);
    expect(await deleteWorkRefs(ORG, control)).toBe(true);
    expect(await deleteWorkRefs(ORG, control)).toBe(false);
    expect(await peekWorkRefs(ORG, control)).toBe(1);
  });
});

describe("erasing an organisation's Work (an empty id taken up again)", () => {
  it("removes its tasks, log rows and counter in every region, and leaves other organisations alone", async () => {
    await createWorkTask(aTask(), aWrite(), stores);
    await createWorkTask(aTask({ ref: 2, region: "eu", brandId: LUMEN_EU, addedFrom: LUMEN_EU }), aWrite(), stores);
    const other = await createWorkTask(aTask({ organisationId: OTHER_ORG }), aWrite(), stores);
    await allocateWorkRefs(ORG, 2, control);
    await allocateWorkRefs(OTHER_ORG, 1, control);
    expect(await eraseOrganisationWork(ORG, NINA, stores)).toEqual({ tasks: 2, rows: 2, refs: true });
    expect(us.dump(WORK_TASKS).map((d) => d.organisationId)).toEqual([OTHER_ORG]);
    expect(eu.dump(WORK_TASKS)).toEqual([]);
    expect(eu.dump(WORK_LOG)).toEqual([]);
    expect(rowsOf(us).map((r) => r.taskId)).toEqual([other.task.id]);
    expect(control.raw(WORK_REFS, ORG)).toBeUndefined();
    expect(control.raw(WORK_REFS, OTHER_ORG)).toBeDefined();
    expect(await eraseOrganisationWork(ORG, NINA, stores)).toEqual({ tasks: 0, rows: 0, refs: false });
  });

  it("tries every region and then throws for one that failed, so the id is not taken up", async () => {
    await createWorkTask(aTask(), aWrite(), stores);
    await createWorkTask(aTask({ ref: 2, region: "eu", brandId: LUMEN_EU, addedFrom: LUMEN_EU }), aWrite(), stores);
    await allocateWorkRefs(ORG, 2, control);
    const down = { regionDb: by(failingFirestore(eu, { collections: [WORK_TASKS] }), us, asia), controlDb: control };
    await expect(eraseOrganisationWork(ORG, NINA, down)).rejects.toThrow(/work_erase_failed:eu/);
    expect(us.dump(WORK_TASKS)).toEqual([]);
    expect(eu.dump(WORK_TASKS)).toHaveLength(1);
    // The counter stays until every region is clear.
    expect(control.raw(WORK_REFS, ORG)).toBeDefined();
  });
});

describe("a brand moving to another organisation", () => {
  it("takes its tasks and their log along, each with a new ref there, and leaves whole business tasks behind", async () => {
    // Fernhill already has tasks 1 and 2.
    await allocateWorkRefs(OTHER_ORG, 2, control);
    const mine = await createWorkTask(aTask({ ref: 7, title: "Lumen US task" }), aWrite(), stores);
    const whole = await createWorkTask(aTask({ ref: 8, brandId: null, title: "Whole business" }), aWrite(), stores);
    const eu1 = await createWorkTask(aTask({ ref: 9, region: "eu", brandId: LUMEN_EU, addedFrom: LUMEN_EU, title: "EU task" }), aWrite(), stores);
    // A task added whole business, then tagged with the brand: its first rows name no brand.
    const tagged = await createWorkTask(aTask({ ref: 10, brandId: null, title: "Tagged later" }), aWrite(), stores);
    await changeWorkTask(ORG, tagged.task.id, "us", () => ({ patch: { brandId: LUMEN_US } }), aWrite(), stores);
    await appendWorkLog([{ organisationId: ORG, brandId: LUMEN_US, region: "us", day: "2026-11-20", at: T0, source: PERSON, kind: "entry", taskId: null, workstream: "Launch prep", state: "doing", note: "", links: [] }], stores);

    expect(await countBrandWork({ tenantId: LUMEN_US, region: "us" }, ORG, stores)).toBe(2);
    const r = await repointBrandWork({ tenantId: LUMEN_US, region: "us" }, ORG, OTHER_ORG, SAM, stores, new Date(T1));
    expect(r).toEqual({ tasks: 2, rows: 4 });

    expect(us.raw(WORK_TASKS, mine.task.id)).toMatchObject({ organisationId: OTHER_ORG, ref: 3 });
    expect(us.raw(WORK_TASKS, tagged.task.id)).toMatchObject({ organisationId: OTHER_ORG, ref: 4 });
    expect(us.raw(WORK_TASKS, whole.task.id)).toMatchObject({ organisationId: ORG, ref: 8 });
    expect(eu.raw(WORK_TASKS, eu1.task.id)).toMatchObject({ organisationId: ORG, ref: 9 });
    expect(await peekWorkRefs(OTHER_ORG, control)).toBe(5);

    // Every row of a moved task, and the brand's own entries, went too, with the move's own rows.
    const moved = rowsOf(us).filter((x) => x.taskId === mine.task.id || x.taskId === tagged.task.id || x.kind === "entry");
    expect(moved.every((x) => x.organisationId === OTHER_ORG)).toBe(true);
    expect(rowsOf(us).filter((x) => x.taskId === whole.task.id).every((x) => x.organisationId === ORG)).toBe(true);
    expect(rowsOf(us).filter((x) => x.taskId === mine.task.id && x.kind === "change").map((x) => [x.field, x.before, x.after])).toEqual([
      ["added", null, expect.anything()],
      ["organisationId", ORG, OTHER_ORG],
      ["ref", 7, 3],
    ]);
    expect(rowsOf(us).find((x) => x.field === "ref" && x.taskId === mine.task.id)).toMatchObject({ source: { who: { kind: "person", id: SAM }, tool: "brand_move" } });
    expect((await findWorkTaskByRef(OTHER_ORG, 3, stores)).task?.id).toBe(mine.task.id);
  });

  it("does nothing, and takes no refs, for a brand with no tasks or a move to the same organisation", async () => {
    expect(await repointBrandWork({ tenantId: LUMEN_US, region: "us" }, ORG, OTHER_ORG, "script:ops", stores)).toEqual({ tasks: 0, rows: 0 });
    expect(control.dump(WORK_REFS)).toEqual([]);
    expect(await repointBrandWork({ tenantId: LUMEN_US, region: "us" }, ORG, ORG, NINA, stores)).toEqual({ tasks: 0, rows: 0 });
  });
});

describe("a task from a Vizzy suggestion", () => {
  const ctx: TenantContext = { tenantId: LUMEN_US, region: "us", source: "idtoken", userId: NINA, role: "admin" };
  async function suggested(id: string) {
    const { action } = await proposeAgentAction(
      ctx,
      {
        dedupeKey: "work_task.suggest|ten_lumen|t1|r0",
        agent: "vizzy",
        action: "work_task.suggest",
        target: { type: "work_task", id },
        personId: null,
        proposal: { task: { title: "Add a G2 listing" } },
        basis: null,
        signals: [],
        review: { kind: "work_suggestion", href: "/admin/work/new" },
        requestedBy: { type: "member", id: NINA },
        expiresAt: "2026-12-20T09:00:00.000Z",
        clearDetailsOnClose: false,
        at: T0,
      },
      { db: us },
    );
    return action;
  }
  const accept = (id: string, expectRev = 1) => ({ id: id as `aa_${string}`, by: { type: "member" as const, id: NINA }, expectRev, result: (t: { ref: number }) => ({ task: { ref: t.ref }, edited: [] }) });
  const input = (id: string, actionId: string, over = {}) => aTask({ id, origin: { kind: "suggestion", agent: "vizzy", agentActionId: actionId as `aa_${string}`, evidence: [], by: NINA }, ...over });

  it("writes the task, its added row and the suggestion's move together, reading first", async () => {
    const id = newWorkTaskId();
    const a = await suggested(id);
    const r = await createSuggestedWorkTask(ctx, input(id, a.id), aWrite({ at: T1 }), accept(a.id), { regionDb: () => readsFirst(us) });
    expect(r).toMatchObject({ ok: true, task: { id }, action: { state: "acted", result: { task: { ref: 1 }, edited: [] }, proposal: { task: { title: "Add a G2 listing" } } } });
    expect(us.raw(WORK_TASKS, id)).toMatchObject({ origin: { kind: "suggestion", agentActionId: a.id } });
    expect(us.dump(WORK_LOG)).toEqual([expect.objectContaining({ field: "added", taskId: id })]);
    expect(us.raw("agent_actions", a.id)).toMatchObject({ state: "acted", rev: 3 });
  });

  it("refuses a task kept in another region than the suggestion, a changed suggestion, and a second accept", async () => {
    const id = newWorkTaskId();
    const a = await suggested(id);
    expect(await createSuggestedWorkTask(ctx, input(id, a.id, { brandId: LUMEN_EU, region: "eu" }), aWrite(), accept(a.id), stores)).toEqual({ ok: false, error: "other_region" });
    expect(await createSuggestedWorkTask(ctx, input(id, a.id), aWrite(), accept(a.id, 2), stores)).toEqual({ ok: false, error: "changed" });
    expect(us.dump(WORK_TASKS)).toEqual([]);
    expect((await createSuggestedWorkTask(ctx, input(id, a.id), aWrite(), accept(a.id), stores)).ok).toBe(true);
    expect(await createSuggestedWorkTask(ctx, input(id, a.id), aWrite(), accept(a.id, 3), stores)).toEqual({ ok: false, error: "exists" });
    // Another task id than the suggestion's target is not the suggestion's task.
    expect(await createSuggestedWorkTask(ctx, input(newWorkTaskId(), a.id), aWrite(), accept(a.id, 3), stores)).toEqual({ ok: false, error: "not_found" });
  });

  it("needs an origin that names the suggestion", async () => {
    const id = newWorkTaskId();
    const a = await suggested(id);
    await expect(createSuggestedWorkTask(ctx, aTask({ id }), aWrite(), accept(a.id), stores)).rejects.toThrow(TenantValidationError);
  });
});
