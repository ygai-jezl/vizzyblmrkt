import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORK_TASKS } from "@/lib/tenant";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { filtersOf } from "./inputs";
import type { WorkResult } from "./result";
import { listFiltersOf, listScreen, openRow, taskScreen } from "./screens";
import { addTask, editTask, taskPage } from "./service";
import { sharedReads, type WorkDeps } from "./scope";
import { makeWorld, PEOPLE, type World } from "./testing/world";
import { LUMEN_EU, LUMEN_US } from "./testing/fixtures";

// Quick edit on Work's list (WORK_QUICK_EDIT_ENABLED), on the server: the task opened in place
// beside the list, the row kept when the filters leave it out, and one page load's shared read.
// Lumen [made up] has Lumen Notes in the United States and Lumen Europe; Nina owns it, Sam is a
// member of Lumen Notes and Leo an admin of Lumen Europe.

let w: World;
beforeEach(() => {
  w = makeWorld("2026-11-20T15:00:00.000Z");
});
afterEach(() => vi.unstubAllEnvs());

function value<T>(r: WorkResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.error}`);
  return r.value;
}
const add = async (who: TenantContext, body: Parameters<typeof addTask>[1]) => value(await addTask(await w.scope(who), body, w.deps)).task.task;
const open = async (who: TenantContext, ref: number, q = "", deps: WorkDeps = w.deps) => {
  const scope = await w.scope(who);
  return openRow(scope, ref, listFiltersOf(scope, new URLSearchParams(q)), deps);
};

describe("the open row on the server", () => {
  it("is the task's screen, as its page has it, with its row, not kept while the filters show it", async () => {
    const t = await add(PEOPLE.nina, { title: "Credits and pricing page", brandId: LUMEN_US, mustHave: true, stage: "billing_tax" });
    const r = await open(PEOPLE.nina, t.ref);
    if (r.kind !== "task") throw new Error(r.kind);
    const page = (await taskScreen(await w.scope(PEOPLE.nina), t.ref, w.deps))!;
    expect(r.screen).toEqual(page);
    expect(r.screen.draftedDecision).toBeNull();
    expect(r.kept).toBe(false);
    expect(r.row).toMatchObject({ ref: t.ref, title: "Credits and pricing page", mustHave: true, brand: "Lumen Notes", stage: { n: 7, label: "Billing and tax" } });
  });

  it("keeps the row of a task set Done under Status Open, or moved to another brand under one brand", async () => {
    const t = await add(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_US });
    value(await editTask(await w.scope(PEOPLE.nina), t.ref, { status: "done" }, w.deps));
    const done = await open(PEOPLE.nina, t.ref);
    expect(done).toMatchObject({ kind: "task", kept: true, row: { status: "done", closed: true } });
    expect(await open(PEOPLE.nina, t.ref, "status=all")).toMatchObject({ kind: "task", kept: false });
    expect(await open(PEOPLE.nina, t.ref, `status=all&brand=${LUMEN_EU}`)).toMatchObject({ kind: "task", kept: true });
    expect(await open(PEOPLE.nina, t.ref, "status=all&must=1")).toMatchObject({ kind: "task", kept: true });
  });

  it("is none for another brand's ref in the brand view, and for a ref that isn't there", async () => {
    const eu = await add(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_EU });
    expect(await open(PEOPLE.sam, eu.ref)).toEqual({ kind: "none", ref: eu.ref });
    expect(await open(PEOPLE.nina, 999)).toEqual({ kind: "none", ref: 999 });
  });

  it("is unread when the region that holds it didn't answer, where the task page says not found", async () => {
    const eu = await add(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_EU });
    const broken = failingFirestore(w.eu, { collections: [WORK_TASKS] });
    const deps: WorkDeps = { ...w.deps, regionDb: (r) => (r === "eu" ? broken : w.dbOf(r)) };
    expect(await open(PEOPLE.nina, eu.ref, "", deps)).toEqual({ kind: "unread", ref: eu.ref, regions: ["Europe"] });
    expect(await taskPage(await w.scope(PEOPLE.nina), eu.ref, deps)).toMatchObject({ ok: false, error: "not_found" });
    // A task found in a region that answered still opens, saying another region didn't.
    const us = await add(PEOPLE.nina, { title: "Credits and pricing page", brandId: LUMEN_US });
    const r = await open(PEOPLE.nina, us.ref, "", deps);
    expect(r.kind === "task" && r.screen.page.regionsDown).toEqual([{ region: "eu", name: "Europe" }]);
  });
});

describe("one page load's shared read", () => {
  async function seed() {
    const a = await add(PEOPLE.nina, { title: "Template gallery page", brandId: LUMEN_US });
    const b = await add(PEOPLE.nina, { title: "Write the help page", brandId: LUMEN_US });
    const t = await add(PEOPLE.nina, { title: "Templates for team notes", brandId: LUMEN_US, blockedBy: [a.ref, b.ref] });
    return { a, b, t };
  }

  it("runs once on the default view for the list, the pickers and the blockers, and gives what each reads alone", async () => {
    const { t } = await seed();
    const scope = await w.scope(PEOPLE.nina);
    const shared = sharedReads();
    const deps = { ...w.deps, shared };
    const params = new URLSearchParams("");
    const [list, row] = await Promise.all([listScreen(scope, params, deps), openRow(scope, t.ref, listFiltersOf(scope, params), deps)]);
    expect(shared.reads).toBe(1);
    expect(list).toEqual(await listScreen(scope, params, w.deps));
    if (row.kind !== "task") throw new Error(row.kind);
    expect(row.screen).toEqual(await taskScreen(scope, t.ref, w.deps));
    expect(row.screen.page.blockers.map((b) => ("ref" in b ? b.title : "?"))).toEqual(["Template gallery page", "Write the help page"]);
  });

  it("runs once more under a brand or status filter, since the pickers need every brand's open tasks", async () => {
    const { t } = await seed();
    const scope = await w.scope(PEOPLE.nina);
    for (const q of [`brand=${LUMEN_US}`, "status=all"]) {
      const shared = sharedReads();
      const deps = { ...w.deps, shared };
      const params = new URLSearchParams(q);
      await Promise.all([listScreen(scope, params, deps), openRow(scope, t.ref, listFiltersOf(scope, params), deps)]);
      expect(shared.reads, q).toBe(2);
    }
  });

  it("is the brand view's own under Open, once, for a member", async () => {
    const t = await add(PEOPLE.sam, { title: "Interview 5 team admins" });
    const scope = await w.scope(PEOPLE.sam);
    const shared = sharedReads();
    const deps = { ...w.deps, shared };
    const params = new URLSearchParams(`brand=${LUMEN_EU}`);
    await Promise.all([listScreen(scope, params, deps), openRow(scope, t.ref, listFiltersOf(scope, params), deps)]);
    expect(shared.reads).toBe(1);
  });

  it("looks the blockers up in it, not one by one in each region", async () => {
    const { t } = await seed();
    const scope = await w.scope(PEOPLE.nina);
    const reads = () => w.us.collectionCalls(WORK_TASKS) + w.eu.collectionCalls(WORK_TASKS) + w.asia.collectionCalls(WORK_TASKS);
    const shared = sharedReads();
    const deps = { ...w.deps, shared };
    await listScreen(scope, new URLSearchParams(""), deps);
    const before = reads();
    await openRow(scope, t.ref, filtersOf(new URLSearchParams("")), deps);
    const withShared = reads() - before;
    const alone = reads();
    await openRow(scope, t.ref, filtersOf(new URLSearchParams("")), w.deps);
    const withoutShared = reads() - alone;
    // Shared: only the read for the task by its ref, in each region. Alone: that, the pickers' own
    // read (3 queries in each region) and each of the 2 blockers in each region.
    expect(withShared).toBe(3);
    expect(withoutShared).toBe(3 + 9 + 6);
  });
});

describe("the task page's team names", () => {
  it("are read for every brand side by side, and are the same names one after another gave", async () => {
    const t = await add(PEOPLE.nina, { title: "Whole business pricing", brandId: null });
    const eu = await add(PEOPLE.leo, { title: "Cookie notice in German" });
    value(await editTask(await w.scope(PEOPLE.nina), eu.ref, { notes: "Leo checks the German first" }, w.deps));
    const page = value(await taskPage(await w.scope(PEOPLE.nina), eu.ref, w.deps));
    expect(page.names).toEqual({ uid_nina: "nina", uid_leo: "leo" });
    expect(value(await taskPage(await w.scope(PEOPLE.nina), t.ref, w.deps)).names).toEqual({ uid_nina: "nina" });
  });
});
