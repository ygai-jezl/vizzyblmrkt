import { beforeEach, describe, expect, it } from "vitest";
import { WORK_LOG } from "@/lib/tenant";
import { addLogEntry, logDay } from "./log";
import { addTask, editTask, recordDecision } from "./service";
import type { LogEntryBody } from "./inputs";
import type { WorkResult } from "./result";
import { makeWorld, PEOPLE, type World } from "./testing/world";
import { LUMEN_EU, LUMEN_US, SAM } from "./testing/fixtures";
import type { TenantContext } from "@/lib/tenant/types";

// Lumen Notes is in New York time: 15:00 UTC is 10:00 there.
let w: World;
beforeEach(() => {
  w = makeWorld("2026-11-20T15:00:00.000Z");
});

function value<T>(r: WorkResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.error} ${JSON.stringify(r.issues ?? [])}`);
  return r.value;
}
const log = async (body: LogEntryBody, who: TenantContext = PEOPLE.nina) => addLogEntry(await w.scope(who), body, w.deps);
const day = async (d: string | null = null, who: TenantContext = PEOPLE.nina) => value(await logDay(await w.scope(who), d, w.deps));

describe("the Log", () => {
  it("keeps each entry as a row for the brand it is for, in its region, on the brand's own day", async () => {
    const r = value(await log({ workstream: "Pricing page", state: "doing", note: "Plans and credits" }));
    expect(r.row).toMatchObject({ kind: "entry", brandId: LUMEN_US, region: "us", day: "2026-11-20", workstream: "Pricing page", source: { who: { kind: "person", id: PEOPLE.nina.userId }, tool: "work_log" } });
    const eu = value(await log({ workstream: "Cookie notice", state: "waiting", brandId: LUMEN_EU }));
    expect(w.eu.raw(WORK_LOG, eu.row.id)).toBeDefined();
    const whole = value(await log({ workstream: "SOC 2", state: "doing", brandId: null }));
    expect(whole.row).toMatchObject({ brandId: null, region: "us" });
  });

  it("logs a member's entries for their own brand only", async () => {
    expect(value(await log({ workstream: "Interviews", state: "doing" }, PEOPLE.sam)).row.brandId).toBe(LUMEN_US);
    expect(await log({ workstream: "Interviews", state: "doing", brandId: null }, PEOPLE.sam)).toMatchObject({ ok: false, error: "whole_business_owners" });
    expect(await log({ workstream: "Interviews", state: "doing", brandId: LUMEN_EU }, PEOPLE.sam)).toMatchObject({ ok: false, error: "brand_not_yours" });
  });

  it("files an entry about a task under the task's brand", async () => {
    const t = value(await addTask(await w.scope(PEOPLE.nina), { title: "Cookie notice in German", brandId: LUMEN_EU }, w.deps)).task.task;
    expect(value(await log({ workstream: "Cookie notice", state: "doing", ref: t.ref })).row).toMatchObject({ taskId: t.id, brandId: LUMEN_EU, region: "eu" });
    expect(await log({ workstream: "Cookie notice", state: "doing", ref: t.ref }, PEOPLE.sam)).toMatchObject({ ok: false, status: 404 });
  });

  it("carries two workstreams over to the next day, never retyped, until one is done", async () => {
    value(await log({ workstream: "Pricing page", state: "doing" }));
    value(await log({ workstream: "Interviews", state: "blocked", note: "Waiting on two admins" }, PEOPLE.sam));
    w.at("2026-11-21T15:00:00.000Z");
    const next = await day();
    expect(next.entries).toEqual([]);
    expect(next.inFlight.map((x) => [x.workstream, x.state, x.dayN])).toEqual([
      ["Interviews", "blocked", 2],
      ["Pricing page", "doing", 2],
    ]);
    value(await log({ workstream: "pricing page", state: "done" }));
    expect((await day()).inFlight.map((x) => x.workstream)).toEqual(["Interviews"]);
    // A past day reads as it was.
    expect((await day("2026-11-20")).entries.map((e) => e.workstream).sort()).toEqual(["Interviews", "Pricing page"]);
  });

  it("shows the tasks that moved, the decisions made and, today, the checks due", async () => {
    const scope = await w.scope(PEOPLE.nina);
    const t = value(await addTask(scope, { title: "Call the auditor", brandId: LUMEN_US, check: { kind: "date", day: "2026-11-20", time: "09:00" } }, w.deps)).task.task;
    // In the same moment as its added row: the added row still comes first.
    value(await editTask(scope, t.ref, { status: "in_progress" }, w.deps));
    w.at("2026-11-20T15:05:00.000Z");
    value(await recordDecision(scope, { ref: t.ref, question: "Type 1 or Type 2?", options: ["Type 1", "Type 2"], chosen: "a" }, w.deps));
    const today = await day();
    expect(today.moved.map((m) => [m.taskId, m.rows.map((r) => (r.kind === "change" ? r.field : r.kind))])).toEqual([[t.id, ["added", "status"]]]);
    expect(today.decisions.map((d) => d.decision.question)).toEqual(["Type 1 or Type 2?"]);
    expect(today.checks.map((c) => c.task.id)).toEqual([t.id]);
    expect(today.tasks[t.id]).toEqual({ ref: t.ref, title: "Call the auditor", status: "in_progress", brandId: LUMEN_US });
    expect(today.rail[0]).toEqual({ day: "2026-11-20", entries: 0, moved: 1, decisions: 1 });
    w.at("2026-11-21T15:00:00.000Z");
    expect((await day("2026-11-20")).checks).toEqual([]);
  });

  it("shows a member only their brand's rows", async () => {
    value(await log({ workstream: "Cookie notice", state: "doing", brandId: LUMEN_EU }));
    value(await log({ workstream: "SOC 2", state: "doing", brandId: null }));
    value(await log({ workstream: "Interviews", state: "doing" }, PEOPLE.sam));
    expect((await day(null, PEOPLE.sam)).entries.map((e) => e.workstream)).toEqual(["Interviews"]);
    expect((await day(null, PEOPLE.nina)).entries).toHaveLength(3);
    expect(SAM).toBeTruthy();
  });

  it("refuses a day after today or one it can't read, and past 500 entries a day in the organisation", async () => {
    expect(await logDay(await w.scope(PEOPLE.nina), "2026-11-21", w.deps)).toMatchObject({ ok: false, error: "day_bad" });
    expect(await logDay(await w.scope(PEOPLE.nina), "yesterday", w.deps)).toMatchObject({ ok: false, error: "day_bad" });
    for (let i = 0; i < 500; i++) w.eu.seed(WORK_LOG, `wl_${i.toString(16).padStart(24, "0")}`, { organisationId: "org_ten_lumen", day: "2026-11-20", kind: "entry" });
    expect(await log({ workstream: "One more", state: "doing" })).toMatchObject({ ok: false, status: 409, error: "entries_full" });
  });
});
