import { beforeEach, describe, expect, it } from "vitest";
import { WORK_LOG } from "@/lib/tenant";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import { addLogEntry, carryOver, logDay } from "./log";
import { addTask } from "./service";
import type { LogEntryBody } from "./inputs";
import type { WorkResult } from "./result";
import type { WorkLogRowOf } from "./types";
import { makeWorld, PEOPLE, type World } from "./testing/world";
import { LUMEN_EU, LUMEN_US, NINA, SAM } from "./testing/fixtures";
import type { TenantContext } from "@/lib/tenant/types";
import type { Region } from "@/lib/types/tenant";

/**
 * Carry over and the Nothing logged yet state on Today (plan section 8.3, the approved canvas's
 * Today): before anyone has logged today, one tap logs today's entry for each workstream still open
 * from yesterday, by the person who tapped, once. Made-up Lumen Notes; New York time, so 15:00 UTC
 * is 10:00 there and 16:00 in Berlin.
 */

let w: World;
beforeEach(() => {
  w = makeWorld("2026-11-24T15:00:00.000Z");
});

function value<T>(r: WorkResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.error} ${JSON.stringify(r.issues ?? [])}`);
  return r.value;
}
const log = async (body: LogEntryBody, who: TenantContext = PEOPLE.nina) => value(await addLogEntry(await w.scope(who), body, w.deps));
const day = async (d: string | null = null, who: TenantContext = PEOPLE.nina) => value(await logDay(await w.scope(who), d, w.deps));
const carry = async (who: TenantContext = PEOPLE.nina, d = "2026-11-25", deps = w.deps) => carryOver(await w.scope(who), { day: d }, deps);
const carried = () => [...w.us.dump(WORK_LOG), ...w.eu.dump(WORK_LOG)].filter((r) => (r as { source?: { tool?: string } }).source?.tool === "work_carry");

/** Tuesday 24 Nov: five workstreams, one of them done. Then the clock moves to Wednesday morning. */
async function tuesday() {
  const soc = value(await addTask(await w.scope(PEOPLE.nina), { title: "SOC 2 for the Team plan", brandId: LUMEN_US }, w.deps)).task.task;
  await log({ workstream: "Search answers in the nightly check", state: "done", note: "Shipped." });
  await log({ workstream: "SOC 2 evidence", state: "doing", note: "14 of 61 controls drafted.", ref: soc.ref });
  await log({ workstream: "Team spaces sharing", state: "waiting", note: "Invites next.", links: [{ url: "https://notes.lumen.example/spaces", label: "Spaces" }] }, PEOPLE.sam);
  await log({ workstream: "Competitor pricing research", state: "blocked", brandId: null });
  await log({ workstream: "Help pages for the Team plan", state: "doing", brandId: LUMEN_EU });
  w.at("2026-11-25T15:00:00.000Z");
  return soc;
}

describe("Carry over on Today", () => {
  it("is offered before anyone has logged today, counting the workstreams it will log, and never on a past day", async () => {
    await tuesday();
    const today = await day();
    expect(today.today).toBe(true);
    expect(today.entries).toEqual([]);
    expect(today.carry).toBe(4);
    expect((await day("2026-11-24")).carry).toBe(0);
  });

  it("logs today's entry for each, by the person who tapped, with yesterday's state, task and links", async () => {
    const soc = await tuesday();
    const r = value(await carry(PEOPLE.nina));
    expect(r.carried).toHaveLength(4);
    const by = (name: string) => r.carried.find((e) => e.workstream === name)!;
    for (const e of r.carried) {
      expect(e).toMatchObject({ kind: "entry", day: "2026-11-25", at: "2026-11-25T15:00:00.000Z", note: "Carried over from yesterday.", source: { who: { kind: "person", id: NINA }, tool: "work_carry", session: null } });
    }
    expect(by("SOC 2 evidence")).toMatchObject({ state: "doing", taskId: soc.id, brandId: LUMEN_US, region: "us" });
    expect(by("Team spaces sharing")).toMatchObject({ state: "waiting", links: [{ url: "https://notes.lumen.example/spaces", label: "Spaces" }], brandId: LUMEN_US });
    expect(by("Competitor pricing research")).toMatchObject({ state: "blocked", brandId: null, region: "us" });
    expect(by("Help pages for the Team plan")).toMatchObject({ state: "doing", brandId: LUMEN_EU, region: "eu" });
    expect(r.carried.map((e) => e.workstream)).not.toContain("Search answers in the nightly check");

    const today = await day();
    expect(today.entries).toHaveLength(4);
    expect(today.carry).toBe(0);
    // Ordinary entries: In flight reads them like any other, still Day 2, now by the person who carried them.
    expect(today.inFlight.map((f) => [f.workstream, f.dayN, f.by.id, f.note]).sort()).toEqual([
      ["Competitor pricing research", 2, NINA, "Carried over from yesterday."],
      ["Help pages for the Team plan", 2, NINA, "Carried over from yesterday."],
      ["SOC 2 evidence", 2, NINA, "Carried over from yesterday."],
      ["Team spaces sharing", 2, NINA, "Carried over from yesterday."],
    ]);
    // Yesterday reads as it was.
    expect((await day("2026-11-24")).entries.map((e) => e.note)).toContain("14 of 61 controls drafted.");
  });

  it("never logs one twice, tapped twice or by two people at once", async () => {
    await tuesday();
    const [a, b] = await Promise.all([carry(PEOPLE.nina), carry(PEOPLE.ninaEu)]);
    expect(value(a).carried.length + value(b).carried.length).toBe(4);
    expect(value(await carry(PEOPLE.nina)).carried).toEqual([]);
    expect(carried()).toHaveLength(4);
    expect((await day()).entries).toHaveLength(4);
  });

  it("carries nothing into a past day, which stays read only, and nothing into a day not here yet", async () => {
    await tuesday();
    expect(await carry(PEOPLE.nina, "2026-11-24")).toMatchObject({ ok: false, status: 409, error: "carry_day_over" });
    expect(await carry(PEOPLE.nina, "2026-11-26")).toMatchObject({ ok: false, error: "day_bad" });
    expect(carried()).toEqual([]);
  });

  it("leaves out a workstream someone logged today, and a member carries only their own brand's", async () => {
    await tuesday();
    // Sam sees Lumen Notes only: two of the four are his to carry.
    expect((await day(null, PEOPLE.sam)).carry).toBe(2);
    const sam = value(await carry(PEOPLE.sam));
    expect(sam.carried.map((e) => [e.workstream, e.source.who.id]).sort()).toEqual([
      ["SOC 2 evidence", SAM],
      ["Team spaces sharing", SAM],
    ]);
    // Nina has something logged today now, so Nothing logged yet is over, but the other two can still be carried.
    await log({ workstream: "Competitor pricing research", state: "done", brandId: null });
    const nina = await day();
    expect(nina.entries).toHaveLength(3);
    expect(nina.carry).toBe(1);
    expect(value(await carry(PEOPLE.nina)).carried.map((e) => e.workstream)).toEqual(["Help pages for the Team plan"]);
    expect((await day()).inFlight.map((f) => f.workstream)).not.toContain("Competitor pricing research");
    expect(carried()).toHaveLength(3);
  });

  it("carries nothing while a region can't be read, and offers nothing then", async () => {
    await tuesday();
    const broken = failingFirestore(w.eu, { collections: [WORK_LOG] });
    const deps = { ...w.deps, regionDb: (r: Region) => (r === "eu" ? broken : w.dbOf(r)) };
    expect(value(await logDay(await w.scope(PEOPLE.nina), null, deps)).carry).toBe(0);
    expect(await carry(PEOPLE.nina, "2026-11-25", deps)).toMatchObject({ ok: false, status: 409, error: "carry_regions_down" });
    expect(carried()).toEqual([]);
  });

  it("refuses past 500 entries a day for the organisation, logging none", async () => {
    await tuesday();
    for (let i = 0; i < 498; i++) w.eu.seed(WORK_LOG, `wl_${i.toString(16).padStart(24, "0")}`, { organisationId: "org_ten_lumen", day: "2026-11-25", kind: "entry" });
    expect(await carry(PEOPLE.nina)).toMatchObject({ ok: false, error: "entries_full" });
    expect(carried()).toEqual([]);
  });

  it("is an ordinary entry in what the Log keeps", async () => {
    await tuesday();
    const [row] = value(await carry(PEOPLE.nina)).carried as Array<WorkLogRowOf<"entry">>;
    const stored = w.dbOf(row!.region).raw(WORK_LOG, row!.id);
    expect(stored).toMatchObject({ kind: "entry", organisationId: "org_ten_lumen", workstream: row!.workstream, state: row!.state });
  });
});
