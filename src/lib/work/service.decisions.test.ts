import { beforeEach, describe, expect, it } from "vitest";
import { WORK_LOG } from "@/lib/tenant";
import { addTask, editTask, recordDecision, taskPage } from "./service";
import type { DecisionBody } from "./inputs";
import type { WorkResult } from "./result";
import { makeWorld, PEOPLE, type World } from "./testing/world";
import { LUMEN_EU, LUMEN_US, NINA, SAM } from "./testing/fixtures";
import type { TenantContext } from "@/lib/tenant/types";
import type { TypedLink, WorkLogRow, WorkLogRowOf, WorkTask } from "./types";

let w: World;
let t: WorkTask;
const PLAN_URL = "https://plans.lumen.example/shared-notebooks";
const plan = (version?: string): TypedLink => ({ kind: "plan", url: PLAN_URL, title: "Shared notebooks plan", ...(version ? { version } : {}) });

function value<T>(r: WorkResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.error} ${JSON.stringify(r.issues ?? [])}`);
  return r.value;
}
const decide = async (body: Omit<DecisionBody, "ref">, who: TenantContext = PEOPLE.nina, opts?: Parameters<typeof recordDecision>[3]) => recordDecision(await w.scope(who), { ref: t.ref, ...body }, w.deps, opts);

beforeEach(async () => {
  w = makeWorld("2026-11-20T15:00:00.000Z");
  t = value(await addTask(await w.scope(PEOPLE.nina), { title: "Invite people to a shared notebook", brandId: LUMEN_US, typedLinks: [plan("v1")] }, w.deps)).task.task;
});

describe("decisions on a task", () => {
  it("are stored as append only log rows with the options a to d, the choice, who chose and why", async () => {
    const r = value(await decide({ question: "Which plan gets it first?", options: ["Team", "Solo", "Both"], chosen: "a", why: "Teams asked for it" }, PEOPLE.sam));
    expect(r.row).toMatchObject({
      kind: "decision",
      taskId: t.id,
      brandId: LUMEN_US,
      region: "us",
      decision: {
        question: "Which plan gets it first?",
        options: [
          { id: "a", label: "Team" },
          { id: "b", label: "Solo" },
          { id: "c", label: "Both" },
        ],
        recommended: null,
        chosen: { option: "a", by: SAM },
        agreed: null,
        why: "Teams asked for it",
        replaces: null,
        plan: null,
      },
    });
    expect(w.us.dump(WORK_LOG).filter((x) => x.kind === "decision")).toHaveLength(1);
  });

  it("works out agreed from a stored recommendation, never from the request, and the choice must be an option", async () => {
    const recommended = { option: "b" as const, by: { kind: "vizzy" as const }, reason: "Solo users sign up faster" };
    const over = value(await decide({ question: "Which plan gets it first?", options: ["Team", "Solo"], chosen: "a" }, PEOPLE.nina, { recommended }));
    expect(over.row.decision).toMatchObject({ recommended, chosen: { option: "a", by: NINA }, agreed: false });
    const agree = value(await decide({ question: "Which plan gets it first?", options: ["Team", "Solo"], chosen: "b" }, PEOPLE.nina, { recommended }));
    expect(agree.row.decision.agreed).toBe(true);
    expect(await decide({ question: "Which plan gets it first?", options: ["Team", "Solo"], chosen: "c" })).toMatchObject({ ok: false, error: "plan_choice" });
    expect(value(await decide({ question: "Still open?", options: ["Yes", "No"] })).row.decision).toMatchObject({ chosen: null, agreed: null });
  });

  it("keeps the first row when a mind changes: the new row names the one it replaces", async () => {
    const first = value(await decide({ question: "Which plan gets it first?", options: ["Team", "Solo"], chosen: "a" }));
    const second = value(await decide({ question: "Which plan gets it first?", options: ["Team", "Solo"], chosen: "b", replaces: first.row.id }));
    expect(second.row.decision.replaces).toBe(first.row.id);
    const rows = (w.us.dump(WORK_LOG) as unknown as WorkLogRow[]).filter((x): x is WorkLogRowOf<"decision"> => x.kind === "decision");
    expect(rows.map((x) => x.decision.chosen?.option)).toEqual(["a", "b"]);
    expect(await decide({ question: "Which?", options: ["A", "B"], replaces: "wl_000000000000000000000000" })).toMatchObject({ ok: false, error: "replaces_missing" });
  });

  it("carries the replaced row's question, options and Vizzy's pick, so a changed pick reads as overruling Vizzy", async () => {
    const recommended = { option: "b" as const, by: { kind: "vizzy" as const }, reason: "Solo users sign up faster" };
    const first = value(await decide({ question: "Which plan gets it first?", options: ["Team", "Solo"], chosen: "b" }, PEOPLE.nina, { recommended }));
    expect(first.row.decision).toMatchObject({ recommended, agreed: true });
    // Change the pick as the task page does: the same question and options, no draft.
    const changed = value(await decide({ question: "Which plan gets it first?", options: ["Team", "Solo"], chosen: "a", replaces: first.row.id }));
    expect(changed.row.decision).toMatchObject({ recommended, chosen: { option: "a", by: NINA }, agreed: false, replaces: first.row.id });
    // A row that replaces another can't swap in another question or other options.
    expect(await decide({ question: "Something else entirely", options: ["X", "Y", "Z"], chosen: "a", replaces: changed.row.id })).toMatchObject({ ok: false, error: "replaces_other" });
    expect(await decide({ question: "Which plan gets it first?", options: ["Team", "Solo", "Both"], chosen: "a", replaces: changed.row.id })).toMatchObject({ ok: false, error: "replaces_other" });
    // Nor can a plan approval and another decision replace each other.
    expect(await decide({ plan: { url: PLAN_URL, version: "v1" }, chosen: "a", replaces: changed.row.id })).toMatchObject({ ok: false, error: "replaces_other" });
    const approval = value(await decide({ plan: { url: PLAN_URL, version: "v1" }, chosen: "b" }));
    expect(await decide({ question: "Which plan gets it first?", options: ["Team", "Solo"], chosen: "a", replaces: approval.row.id })).toMatchObject({ ok: false, error: "replaces_other" });
  });

  it("refuses past 50 decisions on one task, and on a task the person can't see", async () => {
    for (let i = 0; i < 50; i++) value(await decide({ question: `Question ${i}`, options: ["A", "B"], chosen: "a" }));
    expect(await decide({ question: "One more", options: ["A", "B"] })).toMatchObject({ ok: false, status: 409, error: "decisions_full" });
    const eu = value(await addTask(await w.scope(PEOPLE.nina), { title: "Europe's", brandId: LUMEN_EU }, w.deps)).task.task;
    expect(await recordDecision(await w.scope(PEOPLE.sam), { ref: eu.ref, question: "Which?", options: ["A", "B"] }, w.deps)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("approving a plan", () => {
  it("is a decision row tied to the plan link's url and version, with the fixed question and options, and no recommendation", async () => {
    const r = value(await decide({ plan: { url: PLAN_URL, version: "v1" }, chosen: "b", why: "Split the invite step" }));
    expect(r.row.decision).toEqual({
      question: "Approve the plan",
      options: [
        { id: "a", label: "Approve" },
        { id: "b", label: "Change it" },
        { id: "c", label: "Not now" },
      ],
      recommended: null,
      chosen: { option: "b", by: NINA },
      agreed: null,
      why: "Split the invite step",
      replaces: null,
      plan: { url: PLAN_URL, version: "v1" },
    });
    expect(r.plans).toEqual([{ url: PLAN_URL, version: "v1", title: "Shared notebooks plan", state: "change_it", decisionId: r.row.id }]);
    // Even in the same millisecond, the row that replaces another is the newer one.
    const approved = value(await decide({ plan: { url: PLAN_URL, version: "v1" }, chosen: "a", replaces: r.row.id }));
    expect(approved.plans[0]).toMatchObject({ state: "approved", decisionId: approved.row.id });
    w.at("2026-11-21T09:00:00.000Z");
    const later = value(await decide({ plan: { url: PLAN_URL, version: "v1" }, chosen: "c" }));
    expect(later.plans[0]!.state).toBe("not_now");
  });

  it("needs a plan link with that url and version on the task, and takes only Approve, Change it or Not now", async () => {
    expect(await decide({ plan: { url: PLAN_URL, version: "v2" }, chosen: "a" })).toMatchObject({ ok: false, error: "plan_link_missing" });
    expect(await decide({ plan: { url: "https://plans.lumen.example/other", version: "v1" }, chosen: "a" })).toMatchObject({ ok: false, error: "plan_link_missing" });
    expect(await decide({ plan: { url: PLAN_URL, version: "v1" }, chosen: "d" })).toMatchObject({ ok: false, error: "plan_choice" });
    expect(await decide({ plan: { url: PLAN_URL, version: "v1" } })).toMatchObject({ ok: false, error: "plan_choice" });
    expect(await decide({ plan: { url: PLAN_URL, version: "v1" }, chosen: "a", options: ["Yes", "No", "Later"] })).toMatchObject({ ok: false, error: "plan_choice" });
    expect(await decide({ plan: { url: PLAN_URL, version: "v1" }, chosen: "a", question: "Ship it?" })).toMatchObject({ ok: false, error: "plan_question" });
    // Asked without a plan link, Approve the plan is refused.
    expect(await decide({ question: "Approve the plan?", options: ["Approve", "Change it", "Not now"], chosen: "a" })).toMatchObject({ ok: false, error: "plan_question" });
  });

  it("is refused when drafted: nobody recommends approving a plan", async () => {
    const recommended = { option: "a" as const, by: { kind: "vizzy" as const }, reason: "Looks complete" };
    expect(await decide({ plan: { url: PLAN_URL, version: "v1" }, chosen: "a" }, PEOPLE.nina, { recommended })).toMatchObject({ ok: false, error: "plan_recommended" });
    expect(w.us.dump(WORK_LOG).filter((x) => x.kind === "decision")).toEqual([]);
  });

  it("covers only that version: approving v1 doesn't approve v2, and a changed link shows Not approved yet", async () => {
    value(await decide({ plan: { url: PLAN_URL, version: "v1" }, chosen: "a" }));
    expect(value(await taskPage(await w.scope(PEOPLE.nina), t.ref, w.deps)).plans[0]!.state).toBe("approved");
    value(await editTask(await w.scope(PEOPLE.nina), t.ref, { typedLinks: [plan("v2")] }, w.deps));
    const page = value(await taskPage(await w.scope(PEOPLE.nina), t.ref, w.deps));
    expect(page.plans).toEqual([{ url: PLAN_URL, version: "v2", title: "Shared notebooks plan", state: "not_approved_yet", decisionId: null }]);
    // The old approval stays in place.
    expect(page.decisions.map((d) => d.decision.plan?.version)).toEqual(["v1"]);
    expect(value(await decide({ plan: { url: PLAN_URL, version: "v2" }, chosen: "c" })).plans[0]!.state).toBe("not_now");
  });
});
