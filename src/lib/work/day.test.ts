import { describe, expect, it } from "vitest";
import { deriveDay, inFlightOn, LOG_RAIL_DAYS } from "./day";
import type { EntryState, WorkLogRow } from "./types";
import { ORG, LUMEN_US, NINA, SAM } from "./testing/fixtures";

let n = 0;
const id = () => `wl_${(++n).toString(16).padStart(24, "0")}`;
const base = (at: string, who = NINA) => ({
  id: id(),
  organisationId: ORG,
  brandId: LUMEN_US,
  region: "us" as const,
  day: at.slice(0, 10),
  at,
  source: { who: { kind: "person" as const, id: who }, tool: "work_log", session: null },
});
const entry = (at: string, workstream: string, state: EntryState, note = "", who = NINA): WorkLogRow => ({ ...base(at, who), kind: "entry", taskId: null, workstream, state, note, links: [] });
const change = (at: string, taskId: string, tool = "work_page"): WorkLogRow => ({ ...base(at), source: { ...base(at).source, tool }, kind: "change", taskId, field: "status", before: "todo", after: "in_progress" });
const decision = (at: string, taskId: string): WorkLogRow => ({
  ...base(at),
  kind: "decision",
  taskId,
  decision: { question: "Which plan first?", options: [{ id: "a", label: "Team" }, { id: "b", label: "Solo" }], recommended: null, chosen: { option: "a", by: NINA }, agreed: null, why: null, replaces: null, plan: null },
});

const TZ = "Europe/London";
const T1 = "wt_aaaaaaaaaaaaaaaaaaab";
const T2 = "wt_aaaaaaaaaaaaaaaaaaac";

describe("a day of the Log", () => {
  const rows = [
    entry("2026-11-18T09:00:00.000Z", "Pricing page", "doing", "Plans and credits"),
    entry("2026-11-18T10:00:00.000Z", "Interviews", "doing", "", SAM),
    entry("2026-11-19T09:00:00.000Z", "pricing  PAGE", "blocked", "Waiting on the tax answer"),
    entry("2026-11-19T16:00:00.000Z", "Interviews", "done", "All 5 done", SAM),
    entry("2026-11-20T09:30:00.000Z", "Gift guide", "doing"),
    change("2026-11-20T10:00:00.000Z", T1),
    change("2026-11-20T11:00:00.000Z", T1),
    change("2026-11-20T12:00:00.000Z", T2, "work_count"),
    decision("2026-11-20T13:00:00.000Z", T2),
    change("2026-11-19T10:00:00.000Z", T2),
  ];

  it("carries a workstream over until an entry says it's done, with Day N from its first entry, never retyped", () => {
    const day = deriveDay(rows, "2026-11-20", TZ, "2026-10-21");
    expect(day.inFlight.map((w) => [w.workstream, w.state, w.dayN, w.since])).toEqual([
      ["Gift guide", "doing", 1, "2026-11-20"],
      ["pricing  PAGE", "blocked", 3, "2026-11-18"],
    ]);
    expect(day.inFlight[1]!.note).toBe("Waiting on the tax answer");
    // The day before, Interviews was still in flight.
    expect(inFlightOn(rows, "2026-11-18", TZ, "2026-10-21").map((w) => w.workstream).sort()).toEqual(["Interviews", "Pricing page"]);
  });

  it("starts Day N again after a workstream was done and picked up again", () => {
    const again = [...rows, entry("2026-11-21T09:00:00.000Z", "Interviews", "doing", "Two more", SAM)];
    expect(inFlightOn(again, "2026-11-22", TZ, "2026-10-23").find((w) => w.workstream === "Interviews")).toMatchObject({ dayN: 2, since: "2026-11-21" });
  });

  it("lists the day's entries, the tasks that moved (not Work's own counting) and the decisions", () => {
    const day = deriveDay(rows, "2026-11-20", TZ, "2026-10-21");
    expect(day.entries.map((e) => e.workstream)).toEqual(["Gift guide"]);
    expect(day.moved.map((m) => [m.taskId, m.rows.length])).toEqual([[T1, 2]]);
    expect(day.decisions.map((d) => d.taskId)).toEqual([T2]);
  });

  it("uses the brand's own days", () => {
    // 23:30 UTC on 20 Nov is the 21st in Berlin.
    const late = [entry("2026-11-20T23:30:00.000Z", "Late one", "doing")];
    expect(deriveDay(late, "2026-11-21", "Europe/Berlin", "2026-10-22").entries).toHaveLength(1);
    expect(deriveDay(late, "2026-11-20", "Europe/London", "2026-10-21").entries).toHaveLength(1);
  });

  it("fills the day rail for the days before, newest first", () => {
    const day = deriveDay(rows, "2026-11-20", TZ, "2026-10-21");
    expect(day.rail).toHaveLength(LOG_RAIL_DAYS);
    expect(day.rail.slice(0, 3)).toEqual([
      { day: "2026-11-20", entries: 1, moved: 1, decisions: 1 },
      { day: "2026-11-19", entries: 2, moved: 1, decisions: 0 },
      { day: "2026-11-18", entries: 2, moved: 0, decisions: 0 },
    ]);
  });

  it("says when a workstream began before the days read", () => {
    const old = [entry("2026-10-21T09:00:00.000Z", "Long one", "doing")];
    expect(inFlightOn(old, "2026-11-20", TZ, "2026-10-21")[0]).toMatchObject({ longer: true, dayN: 31 });
  });
});
