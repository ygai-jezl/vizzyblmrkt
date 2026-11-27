import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { DecisionDraftSchema, decisionDraftOf, DRAFT_COPY, editedLogFields, logDraftLine, logDraftOf, LogDraftSchema, optionOf, pickLine, WORK_DECISION_DRAFT_ACTION, WORK_LOG_DRAFT_ACTION } from "./draft";

// The shapes of Vizzy's Work drafts. Made-up Lumen Notes.
const TASK = `wt_${"a".repeat(20)}`;
const decision = { taskId: TASK, ref: 1, question: "Which supplier first?", options: [{ id: "a", label: "Clay and Co" }, { id: "b", label: "Fernhill Pots" }], recommended: { option: "b", reason: "They deliver weekly." } };
const entry = { workstream: "Supplier calls", state: "doing", note: "Called two", links: [], taskId: null, ref: null, brandId: "ten_lumen" };

describe("a drafted decision", () => {
  it("is never Approve the plan, has its options a to d in order, and a pick among them", () => {
    expect(DecisionDraftSchema.safeParse(decision).success).toBe(true);
    for (const question of ["Approve the plan", "approve the plan?", " APPROVE THE PLAN. "]) expect(DecisionDraftSchema.safeParse({ ...decision, question }).success, question).toBe(false);
    expect(DecisionDraftSchema.safeParse({ ...decision, options: [{ id: "b", label: "B" }, { id: "a", label: "A" }] }).success).toBe(false);
    expect(DecisionDraftSchema.safeParse({ ...decision, recommended: { option: "c", reason: "x" } }).success).toBe(false);
    expect(DecisionDraftSchema.safeParse({ ...decision, plan: { url: "https://plans.lumen.example" } }).success).toBe(false);
  });

  it("is read only from its own kind of action", () => {
    expect(decisionDraftOf({ action: WORK_DECISION_DRAFT_ACTION, proposal: { decision } })).toMatchObject({ question: "Which supplier first?" });
    expect(decisionDraftOf({ action: WORK_LOG_DRAFT_ACTION, proposal: { decision } })).toBeNull();
    expect(decisionDraftOf({ action: WORK_DECISION_DRAFT_ACTION, proposal: null })).toBeNull();
  });

  it("names a pick by its letter or its words, and says it in a line", () => {
    expect(optionOf(decision.options as never, "B")).toBe("b");
    expect(optionOf(decision.options as never, "option a")).toBe("a");
    expect(optionOf(decision.options as never, " clay and co ")).toBe("a");
    expect(optionOf(decision.options as never, "Somebody else")).toBeNull();
    expect(pickLine(decision as never)).toBe("Vizzy's pick: Fernhill Pots. They deliver weekly.");
    expect(pickLine({ ...decision, recommended: null } as never)).toBe("Vizzy didn't pick one.");
  });
});

describe("a drafted Log note", () => {
  it("names a task by its id and ref together, and reads as the box's line", () => {
    expect(LogDraftSchema.safeParse(entry).success).toBe(true);
    expect(LogDraftSchema.safeParse({ ...entry, taskId: TASK }).success).toBe(false);
    expect(logDraftOf({ action: WORK_LOG_DRAFT_ACTION, proposal: { entry } })).toMatchObject({ workstream: "Supplier calls" });
    expect(logDraftLine(entry)).toBe("Supplier calls: Called two");
    expect(logDraftLine({ workstream: "Supplier calls", note: "" })).toBe("Supplier calls");
  });

  it("knows what the person changed before saving it", () => {
    const d = LogDraftSchema.parse(entry);
    expect(editedLogFields(d, { workstream: "Supplier calls", state: "doing", note: "Called two", taskId: null, brandId: "ten_lumen", links: [] })).toEqual([]);
    expect(editedLogFields(d, { workstream: "Supplier calls", state: "done", note: "Called both", taskId: TASK, brandId: "ten_lumen", links: [{ url: "https://lumen.example" }] })).toEqual(["state", "note", "task", "links"]);
  });
});

describe("the drafts' words", () => {
  it("keep the house style", () => {
    for (const s of Object.values(DRAFT_COPY)) expect([...dashesIn(s), ...aiTellsIn(s)], s).toEqual([]);
  });
});
