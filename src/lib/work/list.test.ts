import { describe, expect, it } from "vitest";
import { filtersOf } from "./inputs";
import { anyFilter, filtersHref, queryOf, rowOf, withFilter, type RowView } from "./list";
import { aStoredTask, taskId } from "./testing/fixtures";

// The list as the screen draws it: the filters in the address, and each task as a row. Lumen [made up].
const now = new Date("2026-11-25T10:00:00.000Z");
const view = (over: Partial<RowView> & { task: RowView["task"] }): RowView => ({ brandName: "Lumen Notes", due: false, blockers: [], waiting: false, checkTask: null, fromVizzy: false, ...over });
const row = (v: RowView) => rowOf(v, { timeZone: "Europe/London", now });

describe("the list's address", () => {
  it("keeps only what differs from Open, and reads back as the same filters", () => {
    const open = filtersOf(new URLSearchParams());
    expect(filtersHref(open)).toBe("/admin/work");
    expect(anyFilter(open)).toBe(false);
    const href = withFilter(open, { brand: "ten_lumen", stage: "market", status: "all", mustHave: true, due: true, kind: "used" });
    expect(href).toBe("/admin/work?brand=ten_lumen&stage=market&status=all&must=1&due=1&kind=used");
    const back = filtersOf(new URLSearchParams(href.split("?")[1]));
    expect(back).toEqual({ brand: "ten_lumen", stage: "market", status: "all", mustHave: true, due: true, kind: "used" });
    expect(anyFilter(back)).toBe(true);
    expect(withFilter(back, { mustHave: false, due: false, kind: null, stage: null, brand: null, status: "open" })).toBe("/admin/work");
  });

  it("takes a page's search params as plain pairs, the first of a repeated key", () => {
    expect(queryOf({ status: ["done", "all"], due: "1", none: undefined }).toString()).toBe("status=done&due=1");
  });
});

describe("a row", () => {
  it("shows the ref, status, stage, brand, must have, Vizzy and its pull requests", () => {
    const t = aStoredTask({
      ref: 76,
      title: "Invite people to a shared notebook",
      status: "in_progress",
      stage: "build",
      mustHave: true,
      typedLinks: [{ kind: "pull_request", provider: "github", repo: "Lumen-Example/notes-app", number: 84 }],
    });
    const r = row(view({ task: t, fromVizzy: true }));
    expect(r).toMatchObject({ ref: 76, href: "/admin/work/76", statusLabel: "In progress", tone: "blue", stage: { n: 4, label: "Build" }, brand: "Lumen Notes", mustHave: true, fromVizzy: true, prs: ["#84"], closed: false });
    expect(row(view({ task: aStoredTask(), brandName: null })).brand).toBeNull();
  });

  it("says Waiting on the first open task it waits for, and nothing once they're done", () => {
    const t = aStoredTask({ ref: 77, blockedBy: [taskId()] });
    const blockers = [{ id: t.blockedBy[0]!, ref: 75, title: "Credits and pricing page", status: "in_progress" as const }];
    expect(row(view({ task: t, blockers, waiting: true })).waitingOn).toEqual({ ref: 75, title: "Credits and pricing page" });
    expect(row(view({ task: t, blockers: [{ ...blockers[0]!, status: "done" }], waiting: false })).waitingOn).toBeNull();
  });

  it("dates a check in the brand's zone, says when it is due, and waits for another task by its ref", () => {
    const date = aStoredTask({ check: { kind: "date", at: "2026-12-09T08:00:00.000Z", taskId: null, note: "", setBy: "uid_nina", setAt: "2026-11-20T09:00:00.000Z", which: null, counted: null }, hasCheck: true });
    expect(row(view({ task: date })).check).toEqual({ label: "9 Dec", due: false, measure: false, forecast: false });
    expect(row(view({ task: { ...date, check: { ...date.check!, at: "2026-11-25T08:00:00.000Z" } }, due: true })).check).toMatchObject({ label: "Due today", due: true });
    expect(row(view({ task: { ...date, check: { ...date.check!, at: "2026-11-22T08:00:00.000Z" } }, due: true })).check).toMatchObject({ label: "Due since 22 Nov", due: true });
    const other = taskId();
    const after = aStoredTask({ check: { kind: "after_task", at: null, taskId: other, note: "", setBy: "uid_nina", setAt: "2026-11-20T09:00:00.000Z", which: null, counted: null }, hasCheck: true });
    expect(row(view({ task: after, checkTask: { id: other, ref: 75, title: "Pricing", status: "todo" } })).check?.label).toBe("When #75 is done");
    expect(row(view({ task: after, checkTask: { id: other, hidden: true } })).check?.label).toBe("When another task is done");
  });

  it("forecasts the check a measure sets once the task is done, and names the kind of win", () => {
    const t = aStoredTask({
      measure: { kind: "used", counts: { none: "" }, look: { days: 14 }, setBy: "uid_nina", setAt: "2026-11-20T09:00:00.000Z", then: { kind: "moves", meaning: "conversions", direction: "up", look: { days: 60 } } },
    });
    const r = row(view({ task: t }));
    expect(r.check).toEqual({ label: "14 days after it's done", due: false, measure: true, forecast: true });
    expect(r.win).toBe("Used, then Moves a number");
    const done = aStoredTask({ measure: { kind: "done", setBy: "uid_nina", setAt: "2026-11-20T09:00:00.000Z" } });
    expect(row(view({ task: done })).check).toBeNull();
    expect(row(view({ task: done })).win).toBe("Done is the win");
  });

  it("marks a closed task, and shows the idea it became and the ideas it touches by name", () => {
    const t = aStoredTask({ status: "done", open: false, closedAt: "2026-11-24T10:00:00.000Z", ideaId: "team-spaces", ideaBrandId: "ten_lumen", typedLinks: [{ kind: "idea", brandId: "ten_lumen", ideaId: "offline-mode" }] });
    const r = rowOf(view({ task: t }), { timeZone: "UTC", now, ideaName: (b, i) => (i === "offline-mode" ? "Offline mode" : undefined) });
    expect(r).toMatchObject({ closed: true, madeIdea: true, ideas: ["Offline mode"] });
  });
});
