import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import { WORK_LOG, WORK_TASKS } from "@/lib/tenant";
import { addTask, editTask, listTasks, removeTask, taskPage, type ChangeDone } from "./service";
import { filtersOf } from "./inputs";
import type { WorkResult } from "./result";
import { FERNHILL, HEARTH, makeWorld, PEOPLE, type World } from "./testing/world";
import { LUMEN_EU, LUMEN_US, NINA, ORG, OTHER_ORG, SAM } from "./testing/fixtures";
import type { TenantContext } from "@/lib/tenant/types";

let w: World;
beforeEach(() => {
  w = makeWorld("2026-11-20T09:00:00.000Z");
});
afterEach(() => vi.unstubAllEnvs());

function value<T>(r: WorkResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.error} ${JSON.stringify(r.issues ?? [])}`);
  return r.value;
}
const add = async (who: TenantContext, body: Parameters<typeof addTask>[1]) => addTask(await w.scope(who), body, w.deps);
const added = async (who: TenantContext, body: Parameters<typeof addTask>[1]) => value<ChangeDone>(await add(who, body)).task.task;
const list = async (who: TenantContext, q = "") => value(await listTasks(await w.scope(who), filtersOf(new URLSearchParams(q)), w.deps));

describe("adding tasks", () => {
  it("keeps a brand's task in its region and a whole business task in the region it was added from, refs per organisation", async () => {
    const us = await added(PEOPLE.nina, { title: "Credits and pricing page", brandId: LUMEN_US, stage: "market", mustHave: true });
    const eu = await added(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_EU });
    const whole = await added(PEOPLE.ninaEu, { title: "SOC 2 for the Team plan", brandId: null });
    const fern = await added(PEOPLE.priya, { title: "Van insurance" });
    expect([us.ref, eu.ref, whole.ref, fern.ref]).toEqual([1, 2, 3, 1]);
    expect(w.us.raw(WORK_TASKS, us.id)).toMatchObject({ organisationId: ORG, brandId: LUMEN_US, region: "us", addedFrom: LUMEN_US, mustHave: true, closedAt: null, open: true });
    expect(w.eu.raw(WORK_TASKS, eu.id)).toMatchObject({ brandId: LUMEN_EU, region: "eu" });
    expect(w.eu.raw(WORK_TASKS, whole.id)).toMatchObject({ brandId: null, region: "eu", addedFrom: LUMEN_EU });
    expect(w.eu.raw(WORK_TASKS, fern.id)).toMatchObject({ organisationId: OTHER_ORG, brandId: FERNHILL });
    expect(w.us.raw(WORK_TASKS, eu.id)).toBeUndefined();
  });

  it("sets the origin from the path, never from the request: the person who added it", async () => {
    const t = await added(PEOPLE.sam, { title: "Interview 5 team admins" });
    expect(t.origin).toEqual({ kind: "person", by: SAM });
    expect(w.us.dump(WORK_LOG)).toEqual([expect.objectContaining({ kind: "change", field: "added", taskId: t.id, source: { who: { kind: "person", id: SAM }, tool: "work_page", session: null } })]);
  });

  it("tags a member's task with their brand, and refuses another brand or the whole business", async () => {
    expect((await added(PEOPLE.sam, { title: "Mine" })).brandId).toBe(LUMEN_US);
    expect(await add(PEOPLE.sam, { title: "Theirs", brandId: LUMEN_EU })).toMatchObject({ ok: false, status: 403, error: "brand_not_yours" });
    expect(await add(PEOPLE.sam, { title: "Everyone's", brandId: null })).toMatchObject({ ok: false, status: 403, error: "whole_business_owners" });
    expect(await add(PEOPLE.nina, { title: "Elsewhere", brandId: FERNHILL })).toMatchObject({ ok: false, error: "brand_unknown" });
    // An owner's task with no brand is for the whole business; in a one brand organisation, the brand's.
    expect((await added(PEOPLE.nina, { title: "All of us" })).brandId).toBeNull();
    expect((await added(PEOPLE.rosa, { title: "Fernhill's" })).brandId).toBe(FERNHILL);
  });

  it("works for a brand with no organisation yet, under the id the backfill gives it", async () => {
    const t = await added(PEOPLE.hal, { title: "Register the bakery" });
    expect(t).toMatchObject({ organisationId: `org_${HEARTH}`, brandId: HEARTH, region: "asia", ref: 1 });
    expect(w.asia.raw(WORK_TASKS, t.id)).toBeDefined();
  });

  it("refuses past 5,000 tasks in the organisation, counted in every region", async () => {
    for (let i = 0; i < 2500; i++) w.us.seed(WORK_TASKS, `wt_us${String(i).padStart(17, "a")}`, { organisationId: ORG });
    for (let i = 0; i < 2500; i++) w.eu.seed(WORK_TASKS, `wt_eu${String(i).padStart(17, "a")}`, { organisationId: ORG });
    expect(await add(PEOPLE.nina, { title: "One too many" })).toMatchObject({ ok: false, status: 409, error: "tasks_full" });
    expect((await add(PEOPLE.priya, { title: "Fernhill is fine" })).ok).toBe(true);
  });

  it("waits on the tasks it names by ref, the person must see them, and never on itself", async () => {
    const a = await added(PEOPLE.nina, { title: "Pricing first", brandId: LUMEN_US });
    const eu = await added(PEOPLE.nina, { title: "Europe's", brandId: LUMEN_EU });
    const b = value(await add(PEOPLE.nina, { title: "Then G2", brandId: LUMEN_US, blockedBy: [a.ref] }));
    expect(b.task.task.blockedBy).toEqual([a.id]);
    expect(b.task.waiting).toBe(true);
    expect(b.task.blockers).toEqual([{ id: a.id, ref: 1, title: "Pricing first", status: "todo" }]);
    expect(await add(PEOPLE.sam, { title: "Hidden one", blockedBy: [eu.ref] })).toMatchObject({ ok: false, error: "blocker_missing" });
    expect(await add(PEOPLE.nina, { title: "Ghost", blockedBy: [99] })).toMatchObject({ ok: false, error: "blocker_missing" });
    expect(await editTask(await w.scope(PEOPLE.nina), b.task.task.ref, { blockedBy: [b.task.task.ref] }, w.deps)).toMatchObject({ ok: false, error: "blocker_self" });
  });
});

describe("the one list", () => {
  async function seedLumen() {
    const t1 = await added(PEOPLE.nina, { title: "Credits and pricing page", brandId: LUMEN_US, stage: "market" });
    w.at("2026-11-20T10:00:00.000Z");
    const t2 = await added(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_EU, stage: "set_up", mustHave: true });
    w.at("2026-11-20T11:00:00.000Z");
    const t3 = await added(PEOPLE.nina, { title: "SOC 2 for the Team plan", brandId: null, stage: "set_up", check: { kind: "date", day: "2026-11-20" } });
    w.at("2026-11-20T12:00:00.000Z");
    const t4 = await added(PEOPLE.nina, { title: "Register the company", brandId: LUMEN_US, status: "done", measure: { kind: "done" } });
    w.at("2026-11-20T13:00:00.000Z");
    const t5 = await added(PEOPLE.nina, { title: "Interview 5 team admins", brandId: LUMEN_US, status: "in_progress", measure: { kind: "runs_better", what: "speed", look: { days: 7 } } });
    return { t1, t2, t3, t4, t5 };
  }

  it("merges every region into one list for an owner: checks due first, then Must have, then the most recently changed", async () => {
    const { t1, t2, t3, t5 } = await seedLumen();
    const l = await list(PEOPLE.nina);
    expect(l.tasks.map((v) => v.task.id)).toEqual([t3.id, t2.id, t5.id, t1.id]);
    expect(l.tasks[0]!.due).toBe(true);
    expect(l.counts).toEqual({ open: 4, mustHave: 1, due: 1 });
    expect(l.view).toBe("organisation");
    expect(l.regionsDown).toEqual([]);
    expect(l.tasks.find((v) => v.task.id === t2.id)!.brandName).toBe("Lumen Europe");
  });

  it("filters by brand (or whole business), stage, status, Must have, checks due and kind of win", async () => {
    const { t1, t2, t3, t4, t5 } = await seedLumen();
    const ids = async (q: string) => (await list(PEOPLE.nina, q)).tasks.map((v) => v.task.id).sort();
    expect(await ids(`brand=${LUMEN_US}`)).toEqual([t1.id, t5.id].sort());
    expect(await ids("brand=none")).toEqual([t3.id]);
    expect(await ids("stage=set_up")).toEqual([t2.id, t3.id].sort());
    expect(await ids("stage=none")).toEqual([t5.id]);
    expect(await ids("status=done")).toEqual([t4.id]);
    expect(await ids("status=all")).toEqual([t1.id, t2.id, t3.id, t4.id, t5.id].sort());
    expect(await ids("status=closed")).toEqual([t4.id]);
    expect(await ids("must=1")).toEqual([t2.id]);
    expect(await ids("due=1")).toEqual([t3.id]);
    expect(await ids("kind=runs_better")).toEqual([t5.id]);
    expect(await ids("kind=none")).toEqual([t1.id, t2.id, t3.id].sort());
    expect(await listTasks(await w.scope(PEOPLE.nina), filtersOf(new URLSearchParams(`brand=${FERNHILL}`)), w.deps)).toMatchObject({ ok: false, error: "brand_unknown" });
  });

  it("shows a member only their brand's tasks, whatever brand they filter by", async () => {
    const { t1, t5 } = await seedLumen();
    const sam = await list(PEOPLE.sam, `brand=${LUMEN_EU}`);
    expect(sam.view).toBe("brand");
    expect(sam.tasks.map((v) => v.task.id).sort()).toEqual([t1.id, t5.id].sort());
    expect(sam.brands.map((b) => b.id)).toEqual([LUMEN_US]);
    expect((await list(PEOPLE.leo)).tasks.map((v) => v.task.title)).toEqual(["Cookie notice in German"]);
    expect((await list(PEOPLE.priya)).tasks).toEqual([]);
  });

  it("names the region that didn't answer and still shows the others' tasks", async () => {
    const { t1 } = await seedLumen();
    const broken = failingFirestore(w.eu, { collections: [WORK_TASKS] });
    const deps = { ...w.deps, regionDb: (r: string) => (r === "eu" ? broken : w.dbOf(r as "us")) };
    const l = value(await listTasks(await w.scope(PEOPLE.nina), filtersOf(new URLSearchParams()), deps));
    expect(l.regionsDown).toEqual([{ region: "eu", name: "Europe" }]);
    expect(l.tasks.map((v) => v.task.id)).toContain(t1.id);
    expect(l.tasks.some((v) => v.task.brandId === LUMEN_EU)).toBe(false);
  });
});

describe("ready to start (work_ready)", () => {
  it("lists the To do tasks with nothing in their way, Must have first, then stage, then ref, for the tasks the person sees", async () => {
    const pricing = await added(PEOPLE.nina, { title: "Pricing page", brandId: LUMEN_US, stage: "market" });
    await added(PEOPLE.nina, { title: "List on G2", brandId: LUMEN_US, stage: "market", blockedBy: [pricing.ref] });
    await added(PEOPLE.nina, { title: "Register the company", brandId: LUMEN_US, stage: "set_up" });
    await added(PEOPLE.nina, { title: "Cookie notice", brandId: LUMEN_EU, mustHave: true });
    await added(PEOPLE.nina, { title: "Started already", brandId: LUMEN_US, status: "in_progress" });
    await added(PEOPLE.nina, { title: "Later", brandId: LUMEN_US, check: { kind: "date", day: "2026-12-24" } });
    const { readyTasks } = await import("./service");
    expect((await readyTasks(await w.scope(PEOPLE.nina), w.deps)).tasks.map((v) => v.task.title)).toEqual(["Cookie notice", "Register the company", "Pricing page"]);
    expect((await readyTasks(await w.scope(PEOPLE.sam), w.deps)).tasks.map((v) => v.task.title)).toEqual(["Register the company", "Pricing page"]);
    await editTask(await w.scope(PEOPLE.nina), pricing.ref, { status: "done" }, w.deps);
    expect((await readyTasks(await w.scope(PEOPLE.sam), w.deps)).tasks.map((v) => v.task.title)).toEqual(["Register the company", "List on G2"]);
  });
});

describe("one task", () => {
  it("answers not found for a task the person can't see, never which", async () => {
    const eu = await added(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_EU });
    expect(await taskPage(await w.scope(PEOPLE.sam), eu.ref, w.deps)).toMatchObject({ ok: false, status: 404, error: "not_found" });
    expect(await taskPage(await w.scope(PEOPLE.priya), eu.ref, w.deps)).toMatchObject({ ok: false, status: 404 });
    const page = value(await taskPage(await w.scope(PEOPLE.nina), eu.ref, w.deps));
    expect(page.task.id).toBe(eu.id);
    expect(page.names[NINA]).toBe("nina");
    expect(page.can).toEqual({ delete: true, prAndSwitch: false, loopLine: false });
  });
});

describe("changing a task", () => {
  it("writes a change row per field with the value before and after, and the history on the task", async () => {
    const t = await added(PEOPLE.nina, { title: "Credits page", brandId: LUMEN_US });
    w.at("2026-11-21T09:00:00.000Z");
    const r = value(await editTask(await w.scope(PEOPLE.sam), t.ref, { title: "Credits and pricing page", stage: "market", via: "work_list" }, w.deps));
    expect(r.task.task).toMatchObject({ title: "Credits and pricing page", stage: "market", updatedAt: "2026-11-21T09:00:00.000Z" });
    const rows = w.us.dump(WORK_LOG).filter((x) => x.field !== "added");
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "title", before: "Credits page", after: "Credits and pricing page", source: { who: { kind: "person", id: SAM }, tool: "work_list", session: null } }),
        expect.objectContaining({ field: "stage", before: null, after: "market" }),
      ]),
    );
    expect(r.task.task.recent.map((x) => x.field)).toEqual(["stage", "title", "added"]);
  });

  it("refuses a change of brand into another region, so a task never moves database", async () => {
    const t = await added(PEOPLE.nina, { title: "Pricing", brandId: LUMEN_US });
    expect(await editTask(await w.scope(PEOPLE.nina), t.ref, { brandId: LUMEN_EU }, w.deps)).toMatchObject({ ok: false, status: 409, error: "other_region" });
    const whole = await added(PEOPLE.nina, { title: "Team plan", brandId: null });
    expect(value(await editTask(await w.scope(PEOPLE.nina), whole.ref, { brandId: LUMEN_US }, w.deps)).task.task).toMatchObject({ brandId: LUMEN_US, region: "us" });
    expect(value(await editTask(await w.scope(PEOPLE.nina), t.ref, { brandId: null }, w.deps)).task.task).toMatchObject({ brandId: null, region: "us" });
    expect(await editTask(await w.scope(PEOPLE.sam), whole.ref, { brandId: null }, w.deps)).toMatchObject({ ok: false, error: "whole_business_owners" });
  });

  it("refuses an edit made from a task that changed meanwhile, never merging it", async () => {
    const t = await added(PEOPLE.nina, { title: "Pricing", brandId: LUMEN_US });
    const nina = await w.scope(PEOPLE.nina);
    w.us.onBeforeCommit = async () => {
      await editTask(nina, t.ref, { notes: "Someone else's note" }, w.deps);
    };
    expect(await editTask(nina, t.ref, { title: "Pricing page" }, w.deps)).toMatchObject({ ok: false, status: 409, error: "changed" });
    expect(w.us.raw(WORK_TASKS, t.id)).toMatchObject({ title: "Pricing", notes: "Someone else's note" });
  });

  it("links the idea a task became (Make it an idea) only when it exists in a brand the person sees", async () => {
    const t = await added(PEOPLE.nina, { title: "Partner programme", brandId: LUMEN_US });
    w.us.seed("campaigns", "camp_partners", { tenantId: LUMEN_US, name: "Partner programme" });
    expect(await editTask(await w.scope(PEOPLE.nina), t.ref, { idea: { brandId: LUMEN_US, ideaId: "camp_nope" } }, w.deps)).toMatchObject({ ok: false, error: "idea_missing" });
    expect(value(await editTask(await w.scope(PEOPLE.nina), t.ref, { idea: { brandId: LUMEN_US, ideaId: "camp_partners" } }, w.deps)).task.task).toMatchObject({ ideaId: "camp_partners", ideaBrandId: LUMEN_US });
    expect(value(await editTask(await w.scope(PEOPLE.nina), t.ref, { idea: null }, w.deps)).task.task).toMatchObject({ ideaId: null, ideaBrandId: null });
  });
});

describe("deleting a task", () => {
  it("is for admins and owners; its log rows stay, with a deleted row", async () => {
    const t = await added(PEOPLE.sam, { title: "Old idea" });
    expect(await removeTask(await w.scope(PEOPLE.sam), t.ref, w.deps)).toMatchObject({ ok: false, status: 403, error: "forbidden_delete" });
    expect(value(await removeTask(await w.scope(PEOPLE.nina), t.ref, w.deps))).toEqual({ deleted: true, ref: t.ref });
    expect(w.us.raw(WORK_TASKS, t.id)).toBeUndefined();
    expect(w.us.dump(WORK_LOG).map((r) => r.field)).toEqual(["added", "deleted"]);
    expect(await removeTask(await w.scope(PEOPLE.nina), t.ref, w.deps)).toMatchObject({ ok: false, status: 404 });
  });
});
