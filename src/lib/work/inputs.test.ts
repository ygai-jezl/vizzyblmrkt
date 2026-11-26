import { describe, expect, it } from "vitest";
import { AddTaskBodySchema, CheckActionBodySchema, DecisionBodySchema, EditTaskBodySchema, filtersOf, ImportBodySchema, LogEntryBodySchema, MeasureInputSchema } from "./inputs";

// What a person may send is checked strictly: what the server sets can never come from a request.
describe("Work's request shapes", () => {
  it("refuse origin, proposed, setBy, an organisation, a region or a ref on a new task", () => {
    expect(AddTaskBodySchema.safeParse({ title: "Add a G2 listing" }).success).toBe(true);
    for (const extra of [{ origin: { kind: "person", by: "x" } }, { organisationId: "org_x" }, { region: "eu" }, { ref: 3 }, { open: true }, { recent: [] }]) {
      expect(AddTaskBodySchema.safeParse({ title: "Add a G2 listing", ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(AddTaskBodySchema.safeParse({ title: "   " }).success).toBe(false);
    expect(AddTaskBodySchema.safeParse({ title: "Two\nlines" }).success).toBe(false);
  });

  it("refuse a measure that says who set it, when, or what was proposed", () => {
    const m = { kind: "used", counts: { none: "" }, look: { days: 14 } };
    expect(MeasureInputSchema.safeParse(m).success).toBe(true);
    expect(MeasureInputSchema.safeParse({ ...m, proposed: { kind: "used", reason: "x", by: "vizzy" } }).success).toBe(false);
    expect(MeasureInputSchema.safeParse({ ...m, setBy: "uid_nina" }).success).toBe(false);
    expect(MeasureInputSchema.safeParse({ kind: "done", look: { days: 1 } }).success).toBe(false);
    expect(MeasureInputSchema.safeParse({ ...m, then: { kind: "done" } }).success).toBe(false);
  });

  it("refuse a recommendation on a decision, and need a question and options unless it is a plan approval", () => {
    expect(DecisionBodySchema.safeParse({ ref: 3, question: "Which first?", options: ["A", "B"], chosen: "a" }).success).toBe(true);
    expect(DecisionBodySchema.safeParse({ ref: 3, question: "Which first?", options: ["A", "B"], recommended: { option: "a", by: { kind: "vizzy" }, reason: "x" } }).success).toBe(false);
    expect(DecisionBodySchema.safeParse({ ref: 3, question: "Which first?", options: ["A"] }).success).toBe(false);
    expect(DecisionBodySchema.safeParse({ ref: 3, question: "Which first?" }).success).toBe(false);
    expect(DecisionBodySchema.safeParse({ ref: 3, plan: { url: "https://plans.example/p" }, chosen: "a" }).success).toBe(true);
    expect(DecisionBodySchema.safeParse({ ref: 3, plan: { url: "http://plans.example/p" }, chosen: "a" }).success).toBe(false);
  });

  it("take a read only with action read, and a time only with a day", () => {
    expect(CheckActionBodySchema.safeParse({ ref: 1, action: "read", read: "too_soon" }).success).toBe(true);
    expect(CheckActionBodySchema.safeParse({ ref: 1, action: "read" }).success).toBe(false);
    expect(CheckActionBodySchema.safeParse({ ref: 1, action: "checked", read: "better" }).success).toBe(false);
    expect(CheckActionBodySchema.safeParse({ ref: 1, action: "look_again", time: "09:00" }).success).toBe(false);
    expect(CheckActionBodySchema.safeParse({ ref: 1, action: "look_again", day: "2026-12-01", time: "09:00" }).success).toBe(true);
  });

  it("refuse an edit that changes nothing, and a log entry or import with keys it doesn't name", () => {
    expect(EditTaskBodySchema.safeParse({ via: "work_page" }).success).toBe(false);
    expect(EditTaskBodySchema.safeParse({ status: "done" }).success).toBe(true);
    expect(LogEntryBodySchema.safeParse({ workstream: "Pricing page", state: "doing", source: { who: "x" } }).success).toBe(false);
    expect(ImportBodySchema.safeParse({ mode: "preview", text: "a", origin: "x" }).success).toBe(false);
  });

  it("read the list's filters from the address, leaving anything unknown out", () => {
    expect(filtersOf(new URLSearchParams("brand=ten_lumen&stage=market&status=done&must=1&due=1&kind=used"))).toEqual({ brand: "ten_lumen", stage: "market", status: "done", mustHave: true, due: true, kind: "used" });
    expect(filtersOf(new URLSearchParams("brand=../x&stage=nope&status=gone&kind=what"))).toEqual({ brand: null, stage: null, status: "open", mustHave: false, due: false, kind: null });
    expect(filtersOf(new URLSearchParams("stage=none")).stage).toBe("none");
    expect(filtersOf(new URLSearchParams("brand=none")).brand).toBe("none");
  });
});
