import { beforeEach, describe, expect, it } from "vitest";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import { flakyFirestore } from "@/lib/tenant/testing/flakyFirestore";
import { allocateWorkRefs, createWorkTask, WORK_LOG, WORK_TASKS } from "@/lib/tenant";
import { addTask, editTask, importTasks, previewImport } from "./service";
import type { ImportBody } from "./inputs";
import type { WorkResult } from "./result";
import { FERNHILL, makeWorld, PEOPLE, type World } from "./testing/world";
import { aTask, aWrite, LUMEN_EU, LUMEN_US, NINA, ORG } from "./testing/fixtures";
import type { WorkTask } from "./types";

// A made-up Backlog tab, the 12 rows of the plan's walk for Fernhill Plants, pasted from Google Sheets.
const FERNHILL_TAB = [
  "MVP\tRef\tBacklog item\tDescription\tNotes\tStatus\tClippings",
  "Yes\t3\tRegister the business name\t\t\tDone\t",
  "Yes\t4\tBuy fernhill.example\t\t\tDone\t",
  "Yes\t9\tVan insurance\tCover for deliveries too\tTwo quotes so far\tNot started\t",
  "Yes\t14\tPlant health certificate for imports\tFor the plants from our grower abroad\tKeep the paperwork by the till\tDoing\tRules for bringing in plants",
  "\t16\tDelivery zones for the online shop\tPostcodes, days and a price per zone\tAfter the van insurance\tBlocked\t",
  "\t18\tWorkshops in store\tSaturday mornings, 8 people a time\t\tIdea\t",
  "\t20\tAsk 20 customers about Saturday workshops\t\t14 of 20 asked\tDoing\t",
  '\t21\tChristmas gift guide\t"Small gifts, big gifts, and plants for people who have every plant"\tPhotos on Thursday\tDoing\t',
  "\t22\tPhotos of the winter stock\t\t\tNot started\t",
  "\t24\tStamp card for regulars\t\t\tNot started\t",
  "\t25\tRegister for VAT\t\tWhen sales near the limit\tNot started\t",
  "\t27\tCare card in every order\t\t\tNot started\t",
].join("\n");

let w: World;
beforeEach(() => {
  w = makeWorld("2026-11-20T15:00:00.000Z");
});

function value<T>(r: WorkResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.error} ${JSON.stringify(r.issues ?? [])}`);
  return r.value;
}
const body = (text: string, extra: Partial<ImportBody> = {}): ImportBody => ({ mode: "import", text, file: "Backlog.csv", ...extra });
const tasksIn = (db: World["eu"]) => [...(db.cols.get(WORK_TASKS)?.entries() ?? [])].map(([id, d]) => ({ ...d, id }) as unknown as WorkTask);

describe("importing a Backlog tab", () => {
  it("previews what each column fills, the first 20 rows, the statuses Work doesn't know and where new refs start, writing nothing", async () => {
    const p = value(await previewImport(await w.scope(PEOPLE.priya), body(FERNHILL_TAB, { mode: "preview" }), w.deps));
    expect(p.columns.map((c) => c.field)).toEqual(["mustHave", "ref", "title", "description", "notes", "status", "clipping"]);
    expect(p.total).toBe(12);
    expect(p.rows).toHaveLength(12);
    expect(p.rows[5]).toMatchObject({ ref: 18, title: "Workshops in store", status: "todo", statusLabel: "To do", unknownStatus: "Idea" });
    expect(p.unknownText).toBe("1 status isn't one of Work's, so Idea comes in as To do.");
    expect(p.refHint).toBe("Your refs are kept. New tasks start at #28.");
    expect(p.refused).toEqual([]);
    expect(tasksIn(w.eu)).toEqual([]);
  });

  it("adds every row with its sheet ref, the import and its row as origin, and new refs after the highest", async () => {
    const r = value(await importTasks(await w.scope(PEOPLE.priya), body(FERNHILL_TAB), w.deps));
    expect(r).toMatchObject({ imported: 12, refused: [], unknownStatuses: ["Idea"], nextRef: 28 });
    const all = tasksIn(w.eu);
    const van = all.find((t) => t.ref === 9)!;
    expect(van).toMatchObject({ title: "Van insurance", mustHave: true, status: "todo", brandId: FERNHILL, description: "Cover for deliveries too", notes: "Two quotes so far" });
    expect(van.origin).toEqual({ kind: "import", by: "uid_priya", importId: r.importId, row: 4, file: "Backlog.csv" });
    expect(all.find((t) => t.ref === 3)).toMatchObject({ status: "done", open: false, closedAt: "2026-11-20T15:00:00.000Z" });
    expect(all.find((t) => t.ref === 14)!.notes).toBe("Keep the paperwork by the till\nClipping: Rules for bringing in plants");
    expect(all.find((t) => t.ref === 21)!.description).toBe("Small gifts, big gifts, and plants for people who have every plant");
    const next = value(await addTask(await w.scope(PEOPLE.rosa), { title: "Christmas market stall" }, w.deps)).task.task;
    expect(next.ref).toBe(28);
  });

  it("refuses a row whose ref is taken already, keeps the rest, and gives rows with no ref new ones", async () => {
    const scope = await w.scope(PEOPLE.nina);
    value(await addTask(scope, { title: "Pricing page", brandId: LUMEN_US }, w.deps));
    const text = ["Ref,Backlog item,Status,Brand,Check", "1,Taken already,,,", "12,Register the company,Done,Lumen Notes,", ",Check sign ups,Not started,lumen europe,2026-12-09", ",After the company,,,#12", "15,Fernhill's,,Fernhill Plants,"].join("\n");
    const r = value(await importTasks(scope, body(text, { brandId: LUMEN_US }), w.deps));
    expect(r.imported).toBe(3);
    expect(r.refused).toEqual([
      { row: 2, problem: "ref_taken", message: "Its ref is taken already." },
      { row: 6, problem: "brand_unknown", message: "Its brand isn't one you can tag." },
    ]);
    const us = tasksIn(w.us).filter((t) => t.organisationId === ORG);
    const eu = tasksIn(w.eu).filter((t) => t.organisationId === ORG);
    expect(us.map((t) => t.ref).sort((a, b) => a - b)).toEqual([1, 12, 14]);
    const company = us.find((t) => t.ref === 12)!;
    expect(us.find((t) => t.ref === 14)!.check).toMatchObject({ kind: "after_task", taskId: company.id });
    expect(eu).toEqual([expect.objectContaining({ ref: 13, brandId: LUMEN_EU, check: expect.objectContaining({ kind: "date", at: "2026-12-09T07:00:00.000Z" }) })]);
  });

  it("is for admins and owners", async () => {
    expect(await importTasks(await w.scope(PEOPLE.sam), body(FERNHILL_TAB), w.deps)).toMatchObject({ ok: false, status: 403, error: "forbidden_import" });
    expect(await previewImport(await w.scope(PEOPLE.rosa), body(FERNHILL_TAB, { mode: "preview" }), w.deps)).toMatchObject({ ok: false, status: 403 });
    // A member's brand view admin imports only for the brand.
    const leo = await w.scope(PEOPLE.leo);
    const r = value(await importTasks(leo, body("Backlog item,Brand\nOurs,Lumen Europe\nTheirs,Lumen Notes"), w.deps));
    expect(r.imported).toBe(1);
    expect(r.refused.map((x) => x.problem)).toEqual(["brand_unknown"]);
  });

  it("waits only on a task the person sees: a whole business task hidden from a brand view admin is left out, as on the add page", async () => {
    const whole = value(await addTask(await w.scope(PEOPLE.nina), { title: "SOC 2 for the whole business", brandId: null }, w.deps)).task.task;
    const leo = await w.scope(PEOPLE.leo);
    const r = value(await importTasks(leo, body(`Backlog item,Check\nWait on it,when #${whole.ref} is done`), w.deps));
    expect(r.imported).toBe(1);
    const mine = tasksIn(w.eu).find((t) => t.title === "Wait on it")!;
    expect(mine.check).toBeNull();
    expect(await addTask(leo, { title: "Wait on it too", check: { kind: "after_task", ref: whole.ref } }, w.deps)).toMatchObject({ ok: false, error: "check_task_missing" });
    // Nina sees it, so her import waits on it.
    value(await importTasks(await w.scope(PEOPLE.nina), body(`Backlog item,Check\nNina waits,when #${whole.ref} is done`), w.deps));
    expect(tasksIn(w.us).find((t) => t.title === "Nina waits")!.check).toMatchObject({ kind: "after_task", taskId: whole.id });
  });

  it("refuses an empty sheet, one with no task column, more than 1,000 rows, and a whole business tag from a member", async () => {
    const priya = await w.scope(PEOPLE.priya);
    expect(await importTasks(priya, body("Backlog item"), w.deps)).toMatchObject({ ok: false, error: "import_empty" });
    expect(await importTasks(priya, body("Owner,Notes\nPriya,Hello"), w.deps)).toMatchObject({ ok: false, error: "import_no_title" });
    expect(await importTasks(priya, body(["Backlog item", ...Array.from({ length: 1001 }, (_, i) => `Task ${i}`)].join("\n")), w.deps)).toMatchObject({ ok: false, error: "import_too_many" });
    // The largest body the route takes, nearly all line breaks: refused, with no row kept for each line.
    expect(await previewImport(priya, { mode: "preview", text: `Backlog item\n${"\n".repeat(1_500_000)}` }, w.deps)).toMatchObject({ ok: false, error: "import_empty" });
    expect(await previewImport(priya, { mode: "preview", text: `Backlog item\n${"a\n".repeat(1_500_000)}` }, w.deps)).toMatchObject({ ok: false, error: "import_too_many" });
    expect(await importTasks(await w.scope(PEOPLE.leo), body("Backlog item\nA", { brandId: null }), w.deps)).toMatchObject({ ok: false, error: "whole_business_owners" });
  });

  it("proposes a kind of win by the rule once a measure is set on an imported task", async () => {
    value(await importTasks(await w.scope(PEOPLE.priya), body(FERNHILL_TAB), w.deps));
    const r = value(await editTask(await w.scope(PEOPLE.rosa), 9, { measure: { kind: "runs_better", what: "cost", look: { days: 30 } } }, w.deps));
    expect(r.task.task.origin.kind).toBe("import");
    expect(r.task.task.measure).toMatchObject({ kind: "runs_better", setBy: "uid_rosa", proposed: { kind: "done", by: "rule", reason: "It reads like legal or compliance work, which is finished once it is done." } });
  });

  it("takes the person's column picks", async () => {
    const r = value(await importTasks(await w.scope(PEOPLE.priya), body("Thing,Words\nVan insurance,Two quotes", { mapping: { Thing: "title", Words: "notes" } }), w.deps));
    expect(r.imported).toBe(1);
    expect(tasksIn(w.eu)[0]).toMatchObject({ title: "Van insurance", notes: "Two quotes", ref: 1 });
  });

  it("refuses past 5,000 tasks in the organisation, writing no task and no log row", async () => {
    for (let i = 0; i < 4995; i++) w.us.seed(WORK_TASKS, `wt_us${String(i).padStart(17, "a")}`, { organisationId: ORG });
    const rows = ["Backlog item", ...Array.from({ length: 10 }, (_, i) => `Task ${i}`)].join("\n");
    expect(await importTasks(await w.scope(PEOPLE.nina), body(rows, { brandId: LUMEN_US }), w.deps)).toMatchObject({ ok: false, status: 409, error: "tasks_full" });
    expect(tasksIn(w.us).filter((t) => typeof t.title === "string")).toEqual([]);
    expect(w.us.dump(WORK_LOG)).toEqual([]);
    expect(w.eu.dump(WORK_LOG)).toEqual([]);
  });

  it("refuses a sheet ref far past Work's refs, so one row can't use them up, and refuses rather than fails once refs run out", async () => {
    const priya = await w.scope(PEOPLE.priya);
    const p = value(await previewImport(priya, body("ID,Task\n999999,Ship the pricing page\n5000,Care cards\n5001,Stamp cards\n,Window display", { mode: "preview" }), w.deps));
    expect(p.refused).toEqual([
      { row: 2, problem: "ref_far", message: "Its ref is more than 5,000 past the highest ref in Work. Renumber it, or leave the Ref column out so Work numbers it." },
      { row: 4, problem: "ref_far", message: expect.any(String) },
    ]);
    expect(p.nextRef).toBe(5001);
    const r = value(await importTasks(priya, body("ID,Task\n999999,Ship the pricing page\n5000,Care cards\n,Window display"), w.deps));
    expect(r).toMatchObject({ imported: 2, nextRef: 5002 });
    expect(tasksIn(w.eu).map((t) => t.ref).sort((a, b) => a - b)).toEqual([5000, 5001]);
    // The counter at its last ref: adding and importing are refused in words, never a 500.
    w.control.seed("work_refs", "org_ten_fernhill", { organisationId: "org_ten_fernhill", next: 1_000_000, updatedAt: "2026-11-20T15:00:00.000Z" });
    expect(await addTask(priya, { title: "One more" }, w.deps)).toMatchObject({ ok: false, status: 409, error: "refs_full" });
    expect(await importTasks(priya, body("Task\nOne more"), w.deps)).toMatchObject({ ok: false, status: 409, error: "refs_full" });
  });

  it("never gives two tasks one ref when a quick add takes a number while the sheet is read", async () => {
    const priya = await w.scope(PEOPLE.priya);
    const control = w.deps.controlDb as World["control"];
    // A quick add lands between the import reading the counter and claiming it.
    const racing = flakyFirestore(control, {
      before: async (n) => {
        if (n === 1) await addTask(priya, { title: "Quick add" }, w.deps);
      },
    });
    const sheet = body("ID,Task\n1,Register the business name\n2,Van insurance\n3,Care cards");
    const r = await importTasks(priya, sheet, { ...w.deps, controlDb: racing });
    expect(r).toMatchObject({ ok: false, status: 409, error: "import_busy" });
    expect(tasksIn(w.eu).map((t) => [t.ref, t.title])).toEqual([[1, "Quick add"]]);
    // Imported again, the row whose ref the quick add took is left out, with why.
    const again = value(await importTasks(priya, sheet, w.deps));
    expect(again).toMatchObject({ imported: 2, refused: [expect.objectContaining({ row: 2, problem: "ref_taken" })] });
    const refs = tasksIn(w.eu).map((t) => t.ref);
    expect(new Set(refs).size).toBe(refs.length);
    // The import let go of the counter.
    expect(w.control.raw("work_refs", "org_ten_fernhill")?.importHold).toBeUndefined();
  });

  it("never gives two tasks one ref when a number taken before the sheet was read has no task yet", async () => {
    // A quick add took #1 from the counter, and its task is still on its way when the import reads.
    const ref = await allocateWorkRefs("org_ten_fernhill", 1, w.control);
    const r = value(await importTasks(await w.scope(PEOPLE.priya), body("ID,Task\n1,Register the business name\n2,Van insurance"), w.deps));
    expect(r).toMatchObject({ imported: 1, refused: [{ row: 2, problem: "ref_taken", message: "Its ref is taken already." }] });
    // Then the quick add's task lands.
    await createWorkTask(aTask({ organisationId: "org_ten_fernhill", brandId: FERNHILL, addedFrom: FERNHILL, region: "eu", ref, title: "Quick add" }), aWrite(), w.deps);
    expect(tasksIn(w.eu).map((t) => [t.ref, t.title]).sort()).toEqual([
      [1, "Quick add"],
      [2, "Van insurance"],
    ]);
  });

  it("never gives two tasks one ref when the same sheet is imported twice at once", async () => {
    const [a, b] = await Promise.all([importTasks(await w.scope(PEOPLE.priya), body(FERNHILL_TAB), w.deps), importTasks(await w.scope(PEOPLE.priya), body(FERNHILL_TAB), w.deps)]);
    const refs = tasksIn(w.eu).map((t) => t.ref);
    expect(refs).toHaveLength(12);
    expect(new Set(refs).size).toBe(12);
    const done = [a, b].filter((x) => x.ok && x.value.imported > 0);
    expect(done).toHaveLength(1);
    const other = [a, b].find((x) => x !== done[0])!;
    // Refused while the first held the counter, or read after it finished, with every ref taken.
    expect(other.ok ? other.value.imported : other.error).toEqual(other.ok ? 0 : "import_busy");
  });

  it("waits for no import that stopped without letting go, once its hold has passed", async () => {
    w.control.seed("work_refs", "org_ten_fernhill", { organisationId: "org_ten_fernhill", next: 1, rev: 3, importHold: { id: "wi_0000000000000000", until: "2026-11-20T14:00:00.000Z" }, updatedAt: "2026-11-20T13:50:00.000Z" });
    expect(value(await importTasks(await w.scope(PEOPLE.priya), body(FERNHILL_TAB), w.deps)).imported).toBe(12);
    w.control.seed("work_refs", "org_ten_fernhill", { organisationId: "org_ten_fernhill", next: 28, rev: 4, importHold: { id: "wi_0000000000000000", until: "2026-11-20T15:05:00.000Z" }, updatedAt: "2026-11-20T14:55:00.000Z" });
    expect(await importTasks(await w.scope(PEOPLE.priya), body("ID,Task\n40,Window display"), w.deps)).toMatchObject({ ok: false, error: "import_busy" });
    // A sheet with no refs of its own takes new numbers and waits for nothing.
    expect(value(await importTasks(await w.scope(PEOPLE.priya), body("Task\nWindow display"), w.deps)).imported).toBe(1);
  });

  it("refuses to import while a region can't be read, since it can't be sure the refs are free", async () => {
    const broken = failingFirestore(w.us, { collections: [WORK_TASKS] });
    const deps = { ...w.deps, regionDb: (r: string) => (r === "us" ? broken : w.dbOf(r as "eu")) };
    expect(await importTasks(await w.scope(PEOPLE.priya), body(FERNHILL_TAB), deps)).toMatchObject({ ok: false, status: 409, error: "regions_down" });
    expect(tasksIn(w.eu)).toEqual([]);
    expect(NINA).toBeTruthy();
  });
});
