import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORK_TASKS } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { ReviewItem } from "@/lib/review/summary";
import type { WorkResult } from "./result";
import { workReviewItems, workCheckItem } from "./review";
import { actOnCheck, addTask, editTask } from "./service";
import { proposeWorkSuggestion } from "./suggestions";
import type { SuggestedTask } from "./suggestion";
import { LUMEN_EU, LUMEN_US } from "./testing/fixtures";
import { FERNHILL, makeWorld, PEOPLE, type World } from "./testing/world";
import { aStoredTask } from "./testing/fixtures";

// Work in Review: Checks due today, Ready to start and Tasks Vizzy suggests, as each person sees
// them. Made-up Lumen (Lumen Notes in New York time, Lumen Europe in Berlin time) and Fernhill Plants.
let w: World;
beforeEach(() => {
  w = makeWorld("2026-11-20T15:00:00.000Z");
});
afterEach(() => vi.unstubAllEnvs());

function value<T>(r: WorkResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.error} ${JSON.stringify(r.issues ?? [])}`);
  return r.value;
}
const add = async (body: Parameters<typeof addTask>[1], who: TenantContext = PEOPLE.nina) => value(await addTask(await w.scope(who), body, w.deps)).task.task;
const items = async (who: TenantContext, opts: { count?: boolean } = {}) => workReviewItems(who, { ...w.deps, ...opts });
const kinds = (list: ReviewItem[]) => list.map((i) => `${i.kind} ${i.title}`);
const suggestion = (over: Partial<SuggestedTask> = {}): SuggestedTask => ({
  title: "Answer “Does Lumen work offline?” on your site",
  description: "",
  stage: "market",
  brandId: LUMEN_US,
  typedLinks: [],
  measure: { kind: "moves", meaning: "searchClicks", look: { days: 28 } },
  proposed: { kind: "moves", reason: "It answers a question people search for." },
  from: "from your numbers",
  why: "41 searches asked it last month, and no page of yours answers it.",
  ...over,
});

describe("Checks due today", () => {
  it("shows a date check once it is due, with Done and Tomorrow, and a measure's check with the four reads and what Work counted", async () => {
    const date = await add({ title: "Nightly check of search answers", brandId: LUMEN_US, check: { kind: "date", day: "2026-11-21", note: "After last night's runs." } });
    const crash = await add({ title: "Fix the crash on very long notes", brandId: LUMEN_US, measure: { kind: "runs_better", what: "crashes", look: { days: 7 } } });
    value(await editTask(await w.scope(PEOPLE.nina), crash.ref, { status: "done" }, w.deps));
    expect((await items(PEOPLE.nina)).filter((i) => i.kind === "work_check")).toEqual([]);
    w.at("2026-11-27T14:00:00.000Z");
    const due = (await items(PEOPLE.nina)).filter((i) => i.kind === "work_check");
    expect(due).toEqual([
      expect.objectContaining({ title: `#${crash.ref} Fix the crash on very long notes`, href: `/admin/work/${crash.ref}`, action: "Open", work: { kind: "check", ref: crash.ref, measure: true } }),
      expect.objectContaining({ title: `#${date.ref} Nightly check of search answers`, work: { kind: "check", ref: date.ref, measure: false } }),
    ]);
    expect(due[0]!.detail).toBe("Lumen Notes · Did it work? Runs better: crashes, 7 days after it's done. Work can't count crashes, so your read is the record.");
    expect(due[1]!.detail).toBe("Lumen Notes · After last night's runs.");
    // Read once, it is off Review.
    value(await actOnCheck(await w.scope(PEOPLE.nina), { ref: crash.ref, action: "read", read: "same", via: "review_check" }, w.deps));
    expect((await items(PEOPLE.nina)).filter((i) => i.kind === "work_check").map((i) => i.work)).toEqual([{ kind: "check", ref: date.ref, measure: false }]);
  });

  it("shows a member only their own brand's checks in a multi brand organisation", async () => {
    await add({ title: "Lumen Notes check", brandId: LUMEN_US, check: { kind: "date", day: "2026-11-20", time: "09:00" } });
    await add({ title: "Lumen Europe check", brandId: LUMEN_EU, check: { kind: "date", day: "2026-11-20", time: "09:00" } });
    await add({ title: "Whole business check", brandId: null, check: { kind: "date", day: "2026-11-20", time: "09:00" } });
    const owner = (await items(PEOPLE.nina)).filter((i) => i.kind === "work_check").map((i) => i.title);
    expect(owner).toHaveLength(3);
    expect((await items(PEOPLE.sam)).filter((i) => i.kind === "work_check").map((i) => i.title)).toEqual(["#1 Lumen Notes check"]);
  });

  it("names nothing but the brand and why it is due, never a person's data", () => {
    const t = aStoredTask({ ref: 75, title: "Credits and pricing page", check: { kind: "after_task", at: null, taskId: "wt_aaaaaaaaaaaaaaaaaaab", note: "", setBy: "uid_nina", setAt: "2026-11-20T09:00:00.000Z", which: null, counted: null }, hasCheck: true });
    expect(workCheckItem({ task: t, brandName: null, multiBrand: true, line: null })).toMatchObject({ detail: "Whole business · The task it waited for is done.", work: { kind: "check", ref: 75, measure: false } });
  });
});

describe("Ready to start", () => {
  it("lists To do tasks with nothing in their way, Must have first, with Start", async () => {
    const blocker = await add({ title: "Van insurance", brandId: LUMEN_US });
    await add({ title: "Delivery zones", brandId: LUMEN_US, blockedBy: [blocker.ref] });
    await add({ title: "Register for VAT", brandId: LUMEN_US, stage: "billing_tax", mustHave: true });
    await add({ title: "Later", brandId: LUMEN_US, check: { kind: "date", day: "2026-12-01" } });
    await add({ title: "On it", brandId: LUMEN_US, status: "in_progress" });
    const ready = (await items(PEOPLE.nina)).filter((i) => i.kind === "work_ready");
    expect(ready.map((i) => i.title)).toEqual(["#3 Register for VAT", "#1 Van insurance"]);
    expect(ready[0]).toMatchObject({ detail: "7 Billing and tax · Lumen Notes · To do since 20 Nov. Nothing blocks it.", work: { kind: "ready", ref: 3, title: "Register for VAT" } });
    // Starting one is a change row with the tool review_ready, and it leaves Ready to start.
    value(await editTask(await w.scope(PEOPLE.nina), 3, { status: "in_progress", via: "review_ready" }, w.deps));
    expect((await items(PEOPLE.nina)).filter((i) => i.kind === "work_ready").map((i) => i.title)).toEqual(["#1 Van insurance"]);
    const rows = w.us.dump("work_log").filter((r) => r.field === "status");
    expect(rows).toEqual([expect.objectContaining({ before: "todo", after: "in_progress", source: expect.objectContaining({ tool: "review_ready" }) })]);
  });

  it("in a one brand organisation, shows the whole team every task, with no brand words", async () => {
    await add({ title: "Care card in every order", stage: "support" }, PEOPLE.rosa);
    const ready = (await items(PEOPLE.priya)).filter((i) => i.kind === "work_ready");
    expect(ready).toEqual([expect.objectContaining({ title: "#1 Care card in every order", detail: "8 Support · To do since 20 Nov. Nothing blocks it." })]);
    expect((w.eu.dump(WORK_TASKS)[0] as { brandId: string }).brandId).toBe(FERNHILL);
  });
});

describe("Tasks Vizzy suggests", () => {
  it("draws each open suggestion with its stage, brand, where it came from, why and how we'll know it worked", async () => {
    const r = value(await proposeWorkSuggestion(await w.scope(PEOPLE.nina), { task: suggestion() }, w.deps));
    const list = (await items(PEOPLE.nina)).filter((i) => i.kind === "work_suggestion");
    expect(list).toEqual([
      expect.objectContaining({
        id: `aa:${r.action!.id}`,
        title: "Answer “Does Lumen work offline?” on your site",
        href: `/admin/work/new?suggestion=${r.action!.id}`,
        work: {
          kind: "suggestion",
          actionId: r.action!.id,
          rev: 1,
          title: "Answer “Does Lumen work offline?” on your site",
          stage: { n: 5, label: "Market" },
          brand: "Lumen Notes",
          ideas: [],
          from: "From your numbers",
          why: "41 searches asked it last month, and no page of yours answers it.",
          measure: { text: "Moves a number: search clicks up, 28 days after it's done.", why: "It answers a question people search for." },
          editHref: `/admin/work/new?suggestion=${r.action!.id}`,
        },
      }),
    ]);
  });

  it("shows a member only their brand's suggestions in a multi brand organisation, never the whole business's", async () => {
    await proposeWorkSuggestion(await w.scope(PEOPLE.nina), { task: suggestion() }, w.deps);
    await proposeWorkSuggestion(await w.scope(PEOPLE.nina), { task: suggestion({ title: "Agree how the team names its plans", brandId: null }) }, w.deps);
    expect(kinds((await items(PEOPLE.nina)).filter((i) => i.kind === "work_suggestion"))).toHaveLength(2);
    expect(kinds((await items(PEOPLE.sam)).filter((i) => i.kind === "work_suggestion"))).toEqual(["work_suggestion Answer “Does Lumen work offline?” on your site"]);
  });

  it("leaves out a suggestion that expired, or one another brand's chat made", async () => {
    await proposeWorkSuggestion(await w.scope(PEOPLE.nina), { task: suggestion() }, w.deps);
    // Lumen Europe's Review reads Lumen Europe's suggestions only.
    expect((await items(PEOPLE.ninaEu)).filter((i) => i.kind === "work_suggestion")).toEqual([]);
    w.at("2026-12-21T09:00:00.000Z");
    expect((await items(PEOPLE.nina)).filter((i) => i.kind === "work_suggestion")).toEqual([]);
  });
});

describe("when Work can't read", () => {
  it("gives no rows for a brand with no organisation of its own to show, and never fails Review", async () => {
    w.control.seed("organisations", "org_ten_lumen", { ...w.control.raw("organisations", "org_ten_lumen")!, brandIds: [LUMEN_EU] });
    expect(await items(PEOPLE.nina)).toEqual([]);
    expect(await workReviewItems({ tenantId: LUMEN_US, region: "us", source: "system" }, w.deps)).toEqual([]);
  });
});
