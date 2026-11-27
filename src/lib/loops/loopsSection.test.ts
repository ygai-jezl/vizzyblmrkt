import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { FLEET_CELLS, FLEET_READ_MAX } from "@/lib/tenant/fleetCells";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike } from "@/lib/tenant/types";
import { brandWeekReport, creditMark, FleetBuffer } from "./heartbeat";
import { LOOPS_COPY, loopsData, loopsSection, loopsWeeks, planLabel, readLoopsWeeks, weekLabel, type LoopsData, type LoopsSectionView } from "./loopsSection";
import { ROW_KINDS } from "./stages";

/** Every batched read of fleet_cells, by the ids it asked for. */
const fleetReads = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("@/lib/tenant/fleetCells", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/lib/tenant/fleetCells")>();
  return {
    ...m,
    readFleetCells: (ids: readonly string[], db?: FirestoreLike) => {
      fleetReads.calls.push([...ids]);
      return m.readFleetCells(ids, db);
    },
  };
});

/**
 * Settings › Loops (learning loops step 5, screen 6): what the people who run the copy see of the
 * counts across brands. Made up organisations: twelve bakeries on Free (Hearth Bakery among them)
 * making post images, three teams on Pro (Lumen among them) whose Edit mode can't learn on their
 * plan, and two on Ultra whose Edit mode learns.
 */

const NOW = new Date("2027-05-12T09:00:00.000Z");
const W = "2027-W18"; // the week of 3 May 2027, the last closed week on 12 May
const W0 = "2027-W17"; // the week of 26 Apr

type Window = unknown[];
interface Org {
  plan: string;
  window: Window;
  oldCopy?: boolean;
}

const fourWeeks = (week: unknown): Window => [week, week, week, week];

/** A bakery making Natural photo post images and voting on them; a learner refuses for too little, unless it learned. */
const bakery = (learned: boolean): Org => ({
  plan: "free",
  window: fourWeeks({
    c: {
      "image_style.natural_photo": {
        post_image: { v1: { learned: { made: 6, voted: 4, liked: 2, "disliked.mood": 1 }, holdback: { made: 1, voted: 1, liked: 0 } } },
      },
    },
    u: { post_image: { own_image: 1 } },
    r: { loop_learn: learned ? { learned: 1 } : { floor: 1 } },
  }),
});

/** A team using Vizzy in Edit mode: refused on its plan, or learning. */
const editTeam = (plan: string, learned: boolean): Org => ({
  plan,
  window: fourWeeks({ c: { edit_mode: { edit_mode: { v0: { none: { made: 3 } } } } }, r: { edit_mode: learned ? { learned: 1 } : { plan: 1 } } }),
});

/** The rows the lane would write for these organisations' reports of a week, each through its own mark. */
function seedWeek(db: FakeFirestore, week: string, orgs: Org[], listed = orgs.length): void {
  const buffer = new FleetBuffer();
  for (const o of orgs) {
    const report = brandWeekReport({ week, window: o.window, looks: [], plan: o.plan, industry: "unknown", calls: {}, oldCopy: o.oldCopy ?? false });
    const c = creditMark(null, report, NOW.toISOString());
    if (c.late) continue;
    for (const k of c.orgCells) buffer.add(week, k, 1);
    for (const [k, n] of Object.entries(c.things)) buffer.add(week, k, n);
    for (const [k, n] of Object.entries(report.plain)) buffer.add(week, k, n);
    // The heartbeat counts each brand it visited for the week.
    buffer.add(week, "_orgs/visited", 1);
  }
  buffer.add(week, "_orgs/listed", listed);
  for (const cell of buffer.cells()) db.seed(FLEET_CELLS, cell.id, { n: cell.n });
}

const copy = (): Org[] => [
  ...Array.from({ length: 10 }, () => bakery(false)),
  bakery(true),
  { ...bakery(true), oldCopy: true },
  ...Array.from({ length: 3 }, () => editTeam("pro", false)),
  editTeam("ultra", true),
  { ...editTeam("ultra", true), oldCopy: true },
];

/** Every string a view holds. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

const open = async (db: FakeFirestore, week?: string): Promise<LoopsSectionView> => loopsSection({ week, now: NOW, db: db as unknown as FirestoreLike });
const dataOf = (v: LoopsSectionView): LoopsData => {
  if (v.state !== "data") throw new Error(`no data: ${v.state}`);
  return v.data;
};

afterEach(() => vi.unstubAllEnvs());

describe("the read", () => {
  it("reads only the fh: rows of the last 2 closed weeks, by id, in one batched read within the bound", async () => {
    const fake = new FakeFirestore();
    seedWeek(fake, W, copy());
    fleetReads.calls = [];
    await open(fake);
    expect(loopsWeeks(NOW)).toEqual([W, W0]);
    expect(fleetReads.calls.length).toBe(1);
    const ids = fleetReads.calls[0]!;
    expect(ids.length).toBe(2 * (1 + ROW_KINDS.length));
    expect(ids.length).toBeLessThanOrEqual(FLEET_READ_MAX);
    expect(ids.every((id) => id.startsWith("fh:") && (id.endsWith(`:${W}`) || id.endsWith(`:${W0}`)))).toBe(true);
    expect(ids).toContain(`fh:_orgs:${W}`);
    // Work's rows are never read here, and nothing but fleet_cells is opened.
    expect(ids.some((id) => id.includes(":_types:") || id.includes(":_calls:"))).toBe(false);
    expect(fake.collectionCalls(FLEET_CELLS)).toBe(1);
    expect(fake.collectionCalls("tenants")).toBe(0);
  });

  it("names each week by its Monday, and splits the rows by week", async () => {
    expect(weekLabel(W)).toBe("Week of 3 May");
    expect(weekLabel(W0)).toBe("Week of 26 Apr");
    const fake = new FakeFirestore();
    seedWeek(fake, W0, copy());
    const [w, w0] = await readLoopsWeeks([W, W0], fake as unknown as FirestoreLike);
    expect(w!.orgs).toBeUndefined();
    expect(w0!.orgs).toMatchObject({ orgs: 17 });
  });
});

describe("the weeks and the empty first week", () => {
  it("before a week is counted: Counts start after the first closed week, and no week is a link", async () => {
    const v = await open(new FakeFirestore());
    expect(v.state).toBe("empty");
    expect(v.weeks.map((w) => [w.label, w.on, w.off])).toEqual([
      ["Week of 3 May", true, true],
      ["Week of 26 Apr", false, true],
    ]);
    expect(LOOPS_COPY.empty).toBe("Counts start after the first closed week.");
  });

  it("opens the newest week with counts, and the week asked for when it is one of the two", async () => {
    const fake = new FakeFirestore();
    seedWeek(fake, W0, copy());
    expect((await open(fake)).weeks.find((w) => w.on)?.week).toBe(W0);
    seedWeek(fake, W, copy());
    const v = await open(fake);
    expect(v.weeks.map((w) => [w.week, w.on, w.href])).toEqual([
      [W, true, `/admin/account/loops?week=${W}`],
      [W0, false, `/admin/account/loops?week=${W0}`],
    ]);
    expect((await open(fake, W0)).weeks.find((w) => w.on)?.week).toBe(W0);
    // A week that isn't one of the two falls back to the newest with counts.
    expect((await open(fake, "2026-W01")).weeks.find((w) => w.on)?.week).toBe(W);
  });

  it("says the counts didn't load when the read fails", async () => {
    const broken = { collection: () => ({ doc: () => ({ get: () => Promise.reject(new Error("unavailable")) }) }) } as unknown as FirestoreLike;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const v = await loopsSection({ now: NOW, db: broken });
    expect(v.state).toBe("error");
    expect(LOOPS_COPY.error).toBe("The counts didn't load. Try again in a minute.");
    warn.mockRestore();
  });
});

describe("a closed week, every block of screen 6", () => {
  it("shows coverage: brands visited, the fold, the usage meter and organisations by plan", async () => {
    vi.stubEnv("USAGE_METER_ENABLED", "true");
    const fake = new FakeFirestore();
    seedWeek(fake, W, copy(), 19);
    const d = dataOf(await open(fake));
    expect(d.coverage).toEqual([
      { k: "Brands visited", v: "17 of 19 this week", amber: true },
      { k: "Oldest week not yet added up", v: "None", amber: false },
      { k: "Usage meter", v: "On", amber: false },
      { k: "Organisations", v: "17: Free 12, Pro 3, Ultra 2", amber: false },
    ]);
    expect(d.behind).toBe(true);
    vi.stubEnv("USAGE_METER_ENABLED", "false");
    const fake2 = new FakeFirestore();
    seedWeek(fake2, W, copy());
    const d2 = dataOf(await open(fake2));
    expect(d2.behind).toBe(false);
    expect(d2.coverage[2]).toEqual({ k: "Usage meter", v: "Off: calls by purpose aren't counted", amber: false });
  });

  it("compares brands visited with brands listed, so an opted out brand, visited but not reported, never reads behind", () => {
    const d = loopsData({ week: W, orgs: { orgs: 1, p: { open: 1 }, reported: 1, visited: 2, listed: 2 }, rows: new Map() }, { meterOn: true, today: NOW, docsUrl: "" });
    expect(d.behind).toBe(false);
    expect(d.coverage[0]).toEqual({ k: "Brands visited", v: "2 of 2 this week", amber: false });
  });

  it("shows how far each kind gets by plan, the Memory Bank stall in amber, and Free with no Vizzy in Edit mode", async () => {
    const fake = new FakeFirestore();
    seedWeek(fake, W, copy());
    const d = dataOf(await open(fake));
    const cells = (c: Array<{ v: string }>) => c.map((x) => x.v);
    const [image, edit, posts] = d.stages;
    expect(image).toMatchObject({ label: "Image style", note: "the 5 image kinds" });
    expect(cells(image!.cells)).toEqual(["17", "12", "12", "2", "0"]);
    expect(edit).toMatchObject({ label: "Edit mode", note: "Memory Bank, learns its own way" });
    expect(cells(edit!.cells)).toEqual(["17", "5", "5", "2", "No check"]);
    expect(posts).toMatchObject({ label: "Writing posts", note: "LinkedIn and X posts, learns its own way" });
    const pro = edit!.plans.find((p) => p.label === "Pro")!;
    expect(cells(pro.cells)).toEqual(["3", "3", "3", "0", "No check"]);
    expect(pro.cells[3]).toEqual({ v: "0", tone: "amber" });
    const free = edit!.plans.find((p) => p.label === "Free")!;
    expect(free).toMatchObject({ note: "no Vizzy in Edit mode" });
    expect(cells(free.cells)).toEqual(["12", "0", "0", "0", "No check"]);
    expect(edit!.plans.map((p) => p.label)).toEqual(["Free", "Pro", "Ultra"]);
    // A partial stall is never amber.
    expect(image!.plans.find((p) => p.label === "Free")!.cells.some((c) => c.tone === "amber")).toBe(false);
  });

  it("groups the other lines: Own, Gap, None and Fleet only, each line with its Declared and Stamped", async () => {
    const fake = new FakeFirestore();
    seedWeek(fake, W, copy());
    const d = dataOf(await open(fake));
    expect(d.groups.map((g) => g.label.replace(/\d+/, "N"))).toEqual(["Own, N more lines", "Gap, N lines", "None, N lines", "Fleet only, N lines"]);
    expect(d.groups[3]).toMatchObject({ label: "Fleet only, 0 lines", note: "None yet", lines: [] });
    const sendTime = d.groups[1]!.lines.find((l) => l.label === "Send time")!;
    expect(sendTime).toEqual({ label: "Send time", cells: [{ v: "17", tone: "plain" }, { v: "0", tone: "plain" }], span: "Should learn, not yet" });
    // A none line that counts with the image pool says so rather than repeat its numbers.
    const learner = d.groups[2]!.lines.find((l) => l.label === "Learning and checking it helps")!;
    expect(learner.cells[1]).toEqual({ v: "With Image style", tone: "faint" });
  });

  it("says where brands get stuck: a whole plan in amber, a partial stall in one plan, the rule", async () => {
    const fake = new FakeFirestore();
    seedWeek(fake, W, copy());
    const d = dataOf(await open(fake));
    expect(d.stalls).toEqual([
      { amber: true, text: "Edit mode, Pro: all 3 organisations that reached Signalled are stuck there, none Learning for 28 days. Top reason: not in the brand's plan (3)." },
      { amber: false, text: "Image style, Free: 10 of the 12 organisations that reached Signalled are stuck there. Top reason: not enough to learn from yet (10)." },
    ]);
    expect(LOOPS_COPY.stuckRule).toBe(
      "A brand is stuck when it stays at Stamped or at Signalled for 28 days, or while 10 more things are made there, whichever comes first. Amber means every organisation on that plan is stuck at that step. Declared to Stamped is use, not learning, and Learning to Checked is a wait.",
    );
  });

  it("adds up stuck organisations across plans, with their top reason", () => {
    const row = (stuck: Record<string, Record<string, number>>, why: Record<string, Record<string, Record<string, number>>>, reached: Record<string, Record<string, number>>) => ({
      orgs: 20,
      st: Object.fromEntries(Object.entries(reached).map(([s, p]) => [s, { p }])),
      stuck: Object.fromEntries(Object.entries(stuck).map(([step, p]) => [step, { p, why: why[step] ?? {} }])),
    });
    const n = row(
      { stamped: { free: 9, pro: 4, ultra: 1 }, signalled: { free: 2, pro: 1 } },
      { signalled: { free: { floor: 2 }, pro: { floor: 1 } } },
      { stamped: { free: 12, pro: 6, ultra: 2 }, signalled: { free: 3, pro: 2, ultra: 1 }, learning: { free: 1, pro: 1, ultra: 1 } },
    );
    const d = loopsData({ week: W, orgs: { orgs: 20, p: { free: 12, pro: 6, ultra: 2 } }, rows: new Map([["image_style", n]]) }, { meterOn: true, today: NOW, docsUrl: "https://example.test/docs" });
    expect(d.stalls).toEqual([
      { amber: false, text: "Image style: 14 organisations stuck at Stamped with no votes (Free 9, Pro 4, Ultra 1), and 3 at Signalled (Free 2, Pro 1). Top reason at Signalled: not enough to learn from yet (3)." },
    ]);
  });

  it("never says none are stuck at a step where a plan is stuck whole, and counts an organisation on two plans once", () => {
    const data = (n: Record<string, unknown>) =>
      loopsData({ week: W, orgs: { orgs: 20, p: { free: 12, pro: 6, ultra: 2 } }, rows: new Map([["image_style", n]]) }, { meterOn: true, today: NOW, docsUrl: "https://example.test/docs" });
    // Pro is stuck whole at Signalled; one Pro and one Ultra organisation only made.
    const amber = data({
      orgs: 11,
      st: { stamped: { p: { pro: 9, ultra: 2 } }, signalled: { p: { pro: 8, ultra: 1 } }, learning: { p: { ultra: 1 } } },
      stuck: { stamped: { p: { pro: 1, ultra: 1 } }, signalled: { p: { pro: 8 }, why: { pro: { plan: 8 } } } },
    });
    expect(amber.stalls).toEqual([
      { amber: true, text: "Image style, Pro: all 8 organisations that reached Signalled are stuck there, none Learning for 28 days. Top reason: not in the brand's plan (8)." },
      { amber: false, text: "Image style: 2 organisations stuck at Stamped with no votes (Pro 1, Ultra 1). No other plan stuck at Signalled." },
    ]);
    // Acme has a Pro brand and a granted brand that only made: one organisation, in two plans' counts.
    const twoPlans = data({
      orgs: 6,
      st: { stamped: { all: 5, p: { free: 2, pro: 2, granted: 2 } }, signalled: { all: 3, p: { free: 1, pro: 1, granted: 1 } } },
      stuck: { stamped: { all: 2, p: { free: 1, pro: 1, granted: 1 } } },
    });
    expect(twoPlans.stalls).toHaveLength(1);
    expect(twoPlans.stalls[0]!.text).toMatch(/^Image style: 2 organisations stuck at Stamped with no votes \(.*\)\. None stuck at Signalled\.$/);
  });

  it("lists why learners didn't learn, in organisations, in plain words", async () => {
    const fake = new FakeFirestore();
    seedWeek(fake, W, copy());
    expect(dataOf(await open(fake)).reasons).toEqual([
      { k: "Not enough to learn from yet", v: "10" },
      { k: "Not in the brand's plan", v: "3" },
    ]);
  });

  it("counts thumbs down by reason from 10 organisations, with those given no reason, and the notes never", async () => {
    const fake = new FakeFirestore();
    seedWeek(fake, W, copy());
    const d = dataOf(await open(fake));
    expect(d.downs).toEqual([
      {
        kind: "Image style, all 5 kinds",
        pool: true,
        orgs: "12",
        reasons: [
          { k: "Wrong mood or style", v: "12" },
          { k: "No reason given", v: "24", none: true },
        ],
      },
    ]);
    expect(LOOPS_COPY.downsFoot).toBe("Only image thumbs ask why. The notes people add stay with their brand and are never counted.");
  });

  it("shows stamp coverage from 10 organisations, and fewer than 10 below", async () => {
    const fake = new FakeFirestore();
    seedWeek(fake, W, copy());
    const d = dataOf(await open(fake));
    expect(d.stamps[0]).toEqual({ kind: "Image style", cells: { orgs: "12", made: "about 84", pct: "87%", not: "a person's own image 12", lost: "0" } });
    expect(d.stamps.find((s) => s.kind === "Edit mode")).toEqual({ kind: "Edit mode", cells: null });
  });

  it("shows the Go back cards, when the holdback could read, industries and the clean up", async () => {
    const fake = new FakeFirestore();
    seedWeek(fake, W, copy());
    const d = dataOf(await open(fake));
    // Edit mode's 5 organisations are below the floor, so their declines can't show and "none" isn't said of them.
    expect(d.cards).toEqual([
      "Organisations with a Go back card in the last 28 days: none.",
      "Declines by reason: none from kinds with 10 or more organisations; other kinds have fewer than 10 organisations.",
    ]);
    expect(d.holdback[0]).toMatch(/^Natural photo: about \d+ months at 260 votes a month \(the remake check alone: (?:about \d+ months?|under a month)\)\.$/);
    expect(d.holdback[1]).toBe("From this week's counts across 12 organisations, at their pace; a style shows only from 10 of them.");
    expect(d.industries).toEqual([{ k: "Unknown", v: "17", faint: false }]);
    expect(d.differs).toEqual([LOOPS_COPY.differsNone]);
    expect(d.cleanup).toBe("Brands still holding a look in the old place: 2. It stays there for switching back: a brand's Forget or Reset clears its own, and there is no step yet to clear the rest.");
  });

  it("lists every line that doesn't learn by its label, with its reason, gaps open and the overdue ones marked", async () => {
    const fake = new FakeFirestore();
    seedWeek(fake, W, copy());
    const d = dataOf(await open(fake));
    const gap = d.notLearning.find((g) => g.label.startsWith("Gap"))!;
    expect(gap.open).toBe(true);
    expect(gap.note).toBe("Should learn, not yet: each with its reason and a date to look again.");
    expect(gap.lines[0]).toMatchObject({ when: "Overdue, 31 Jan 2027", over: true });
    expect(gap.lines.find((l) => l.label === "Image style suggestion")).toMatchObject({ when: "Overdue, 31 Jan 2027", over: true });
    expect(gap.over).toBe(`${gap.lines.filter((l) => l.over).length} overdue`);
    const own = d.notLearning.find((g) => g.label.startsWith("Own"))!;
    expect(own.open).toBe(false);
    expect(own.note).toBe("Learn in their own way, such as the brand map's dismissed names. Edit mode and Writing posts are above.");
    expect(own.lines.some((l) => l.label === "Edit mode")).toBe(false);
    expect(d.docsUrl).toMatch(/\/blob\/main\/docs\/ONTOLOGY\.md#learning$/);
    // Before a gap's date, it isn't overdue.
    const early = loopsData({ week: W, orgs: { orgs: 1 }, rows: new Map() }, { meterOn: true, today: new Date("2026-12-01T00:00:00.000Z"), docsUrl: "" });
    expect(early.notLearning.find((g) => g.label.startsWith("Gap"))!.over).toBe("");
  });

  it("keeps the floor below 10 organisations: numbers of things hidden, counts of organisations shown", async () => {
    const fake = new FakeFirestore();
    seedWeek(fake, W, Array.from({ length: 9 }, () => bakery(false)));
    const d = dataOf(await open(fake));
    expect(d.stages[0]!.cells.map((c) => c.v)).toEqual(["9", "9", "9", "0", "0"]);
    expect(d.downs).toEqual([{ kind: "Image style, all 5 kinds", pool: true, orgs: null, reasons: [] }]);
    expect(d.stamps[0]).toEqual({ kind: "Image style", cells: null });
    expect(d.reasons).toEqual([{ k: "Not enough to learn from yet", v: "9" }]);
    expect(d.holdback).toEqual(["Fewer than 10 organisations made images, so this can't be worked out yet."]);
    expect(d.cards).toContain(`Declines by reason: ${LOOPS_COPY.fewer}.`);
    // Industries keep the floor too.
    expect(d.industries).toEqual([{ k: "Unknown", v: "fewer than 10", faint: true }]);
    expect(d.stalls[0]).toEqual({ amber: true, text: "Image style, Free: all 9 organisations that reached Signalled are stuck there, none Learning for 28 days. Top reason: not enough to learn from yet (9)." });
  });

  it("says where an industry differs once an industry and the rest each have 10 organisations", () => {
    const n = { orgs: 24, st: { stamped: { all: 24, p: { free: 24 }, i: { food_and_drink: 12, software: 12 } }, learning: { all: 11, p: { free: 11 }, i: { food_and_drink: 9, software: 2 } } } };
    const d = loopsData(
      { week: W, orgs: { orgs: 24, p: { free: 24 }, i: { food_and_drink: 12, software: 12 } }, rows: new Map([["image_style", n]]) },
      { meterOn: true, today: NOW, docsUrl: "" },
    );
    expect(d.industries).toEqual([
      { k: "Food and drink", v: "12", faint: false },
      { k: "Software", v: "12", faint: false },
    ]);
    expect(d.differs[0]).toBe("Where an industry differs: Food and drink, Image style, Learning in 9 of 12 organisations, against 2 of 12 for the rest.");
  });

  it("counts an organisation once per refusal reason, however many kinds refused it", async () => {
    const fake = new FakeFirestore();
    const both: Org = { plan: "pro", window: fourWeeks({ c: { edit_mode: { edit_mode: { v0: { none: { made: 2 } } } } }, r: { edit_mode: { plan: 1 }, content_write: { plan: 1 } } }) };
    seedWeek(fake, W, [both]);
    expect(dataOf(await open(fake)).reasons).toEqual([{ k: "Not in the brand's plan", v: "1" }]);
  });

  it("shows when the holdback could read only for a style with 10 organisations behind it", async () => {
    const fake = new FakeFirestore();
    const collage: Org = {
      plan: "free",
      window: fourWeeks({ c: { "image_style.paper_collage": { post_image: { v1: { learned: { made: 6, voted: 4, liked: 2 } } } } } }),
    };
    seedWeek(fake, W, [...Array.from({ length: 11 }, () => bakery(false)), collage]);
    const d = dataOf(await open(fake));
    expect(d.holdback[0]).toMatch(/^Natural photo: /);
    expect(d.holdback.some((l) => l.startsWith("Paper collage"))).toBe(false);
    expect(d.holdback).toContain("Other styles: fewer than 10 organisations each.");
  });

  it("names a stall at Stamped that comes from posts with no AI draft kept to compare", () => {
    const posts = { orgs: 4, st: { stamped: { all: 4, p: { pro: 4 } } }, stuck: { stamped: { p: { pro: 4 }, nodraft: 4 } } };
    const d = loopsData({ week: W, orgs: { orgs: 4, p: { pro: 4 } }, rows: new Map([["content_write", posts]]) }, { meterOn: true, today: NOW, docsUrl: "" });
    expect(d.stalls).toContainEqual({ amber: false, text: "Writing posts: 4 organisations stuck at Stamped kept no AI draft to compare, so nothing could count as kept or edited." });
  });

  it("names plans as the catalogue does", () => {
    expect(["free", "pro", "ultra", "granted", "open"].map(planLabel)).toEqual(["Free", "Pro", "Ultra", "Granted", "No plan"]);
  });

  it("holds every word it shows to the house style, and shows no raw key", async () => {
    const fake = new FakeFirestore();
    seedWeek(fake, W, copy());
    const all = [...strings(dataOf(await open(fake))), ...strings(LOOPS_COPY)].filter((s) => !s.startsWith("http") && !s.startsWith("/"));
    for (const s of all) {
      expect(dashesIn(s), s).toEqual([]);
      expect(aiTellsIn(s), s).toEqual([]);
      expect(s, s).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    }
  });
});

describe("who reads the counts across brands", () => {
  it("only the Loops section, the lane's heartbeat and Work's Used counts import fleet_cells' store", () => {
    const root = join(__dirname, "..", "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(root);
    const importers = files
      .filter((f) => /from\s+["'](?:@\/lib\/tenant\/fleetCells|\.\/fleetCells)["']/.test(readFileSync(f, "utf8")))
      .map((f) => relative(join(root, ".."), f).split("\\").join("/"))
      .sort();
    expect(importers).toEqual(["src/lib/loops/heartbeat.ts", "src/lib/loops/loopsSection.ts", "src/lib/loops/used.ts"]);
  });
});
