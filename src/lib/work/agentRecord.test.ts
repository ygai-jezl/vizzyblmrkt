import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORK_TASKS } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { agentDrafts } from "@/lib/agentRecord/agentDrafts";
import { catchUpBrand } from "@/lib/agentRecord/catchUp";
import { closeDraft, openRecordsFor, recordDraft, type DraftRef, type RecordDraftInput } from "@/lib/agentRecord/record";
import type { AgentAction } from "@/lib/types/agentAction";
import type { WorkResult } from "./result";
import { draftWorkLog } from "./drafts";
import { addSuggestion, dismissSuggestion, proposeWorkSuggestion } from "./suggestions";
import type { SuggestedTask } from "./suggestion";
import { LUMEN_US, NINA } from "./testing/fixtures";
import { makeWorld, PEOPLE, type World } from "./testing/world";

// Work (ADR-0020) beside the agent record (ADR-0026), in one brand's agent_actions: Work's
// suggestions and drafts carry no draft ref, so the record never opens, closes or counts them, and
// a person's decision on either side moves only its own record, once. Made-up Lumen Notes.
const NOW = "2026-11-20T15:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const FAR = NOW_MS + 3_600_000;
const SYSTEM: TenantContext = { tenantId: LUMEN_US, region: "us", source: "system" };
const NOTE: DraftRef = { kind: "brand_note", ref: "bn_pricing_hint" };
const NOTE_2: DraftRef = { kind: "brand_note", ref: "bn_onboarding_hint" };

let w: World;
beforeEach(() => {
  vi.stubEnv("AGENT_RECORD_ENABLED", "true");
  w = makeWorld(NOW);
});
afterEach(() => vi.unstubAllEnvs());

function value<T>(r: WorkResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.error}`);
  return r.value;
}

const task: SuggestedTask = {
  title: "Check the team plan test accounts after tonight's runs",
  description: "After tonight's runs, check both test accounts got answers.",
  stage: "build",
  brandId: LUMEN_US,
  typedLinks: [],
  measure: { kind: "runs_better", what: "errors", look: { days: 7 } },
  proposed: { kind: "runs_better", reason: "It checks a nightly run." },
  from: "from today's log: Competitor pricing research",
  why: "You logged Competitor pricing research as waiting on tonight's runs.",
};

const note = (fingerprint: string, draft: DraftRef = NOTE): RecordDraftInput => ({ action: "brand_note.suggest", draft, href: "/admin/brand-kit/notes", fingerprint });

async function suggestion(): Promise<AgentAction> {
  const r = value(await proposeWorkSuggestion(await w.scope(PEOPLE.nina), { task, evidence: [] }, w.deps));
  expect(r.outcome).toBe("created");
  return r.action!;
}

const stored = (id: string) => w.us.raw("agent_actions", id) as unknown as AgentAction;
const trail = (id: string) =>
  w.us
    .dump("ontology_events")
    .filter((r) => r.agentActionId === id)
    .map((r) => ({ key: String(r.key), kind: r.kind, properties: r.properties as Record<string, unknown> }))
    .sort((a, b) => a.key.localeCompare(b.key));
const records = () =>
  (w.us.dump("agent_actions") as unknown as AgentAction[]).filter((a) => a.action === "brand_note.suggest").sort((x, y) => x.createdAt.localeCompare(y.createdAt));

describe("Work beside the agent record", () => {
  it("a Dismiss with its reason moves the Work suggestion once and no record, and closing the record moves no suggestion", async () => {
    const a = await suggestion();
    expect(await recordDraft(PEOPLE.nina, note("aaaaaaaaaaaaaaaa"), { db: w.us, nowMs: NOW_MS })).toBe("recorded");
    // Saving the note again supersedes its own record only.
    expect(await recordDraft(PEOPLE.nina, note("bbbbbbbbbbbbbbbb"), { db: w.us, nowMs: NOW_MS + 1_000 })).toBe("recorded");
    expect(stored(a.id)).toMatchObject({ state: "proposed", rev: 1 });
    const [open] = await openRecordsFor(PEOPLE.nina, NOTE, w.us);
    expect(open).toBeDefined();

    value(await dismissSuggestion(await w.scope(PEOPLE.nina), { actionId: a.id, rev: 1, why: "not_now" }, w.deps));
    expect(stored(a.id)).toMatchObject({ state: "declined", declined: { reason: "dismissed", why: "not_now" }, proposal: { task } });
    expect(trail(a.id).filter((e) => e.kind === "agent.declined")).toEqual([expect.objectContaining({ properties: expect.objectContaining({ reason: "dismissed", why: "not_now" }) })]);
    expect(stored(open!.id)).toMatchObject({ state: "proposed", rev: open!.rev });

    const by = { type: "member" as const, id: NINA };
    expect(await closeDraft(PEOPLE.nina, NOTE, { to: "declined", reason: "dismissed", by }, { db: w.us, nowMs: NOW_MS + 2_000 })).toBe(1);
    expect(await closeDraft(PEOPLE.nina, NOTE, { to: "declined", reason: "dismissed", by }, { db: w.us, nowMs: NOW_MS + 3_000 })).toBe(0);
    expect(records().map((r) => [r.state, r.declined?.reason])).toEqual([
      ["declined", "superseded"],
      ["declined", "dismissed"],
    ]);
    // The record's dismissal carries no why: that is Work's tap only.
    expect(records().every((r) => r.declined?.why === undefined)).toBe(true);
    expect(stored(a.id)).toMatchObject({ state: "declined", declined: { reason: "dismissed", why: "not_now" } });
    expect(trail(a.id).map((e) => e.kind)).toEqual(["agent.proposed", "agent.declined"]);
  });

  it("Add to Work makes one task and acts the suggestion once, while the record waits and then closes once", async () => {
    const a = await suggestion();
    expect(await recordDraft(PEOPLE.nina, note("aaaaaaaaaaaaaaaa"), { db: w.us, nowMs: NOW_MS })).toBe("recorded");
    const added = value(await addSuggestion(await w.scope(PEOPLE.nina), { actionId: a.id, rev: 1 }, w.deps));
    expect(added.task.task.id).toBe(a.target.id);
    expect(w.us.dump(WORK_TASKS)).toHaveLength(1);
    expect(stored(a.id)).toMatchObject({ state: "acted", result: { task: { id: a.target.id }, edited: [] } });
    expect(trail(a.id).map((e) => e.kind)).toEqual(["agent.proposed", "agent.approved", "agent.acted"]);
    expect(records().map((r) => r.state)).toEqual(["proposed"]);

    const acted = { to: "acted" as const, by: { type: "member" as const, id: NINA }, fingerprint: "aaaaaaaaaaaaaaaa" };
    expect(await closeDraft(PEOPLE.nina, NOTE, acted, { db: w.us, nowMs: NOW_MS + 1_000 })).toBe(1);
    expect(await closeDraft(PEOPLE.nina, NOTE, acted, { db: w.us, nowMs: NOW_MS + 2_000 })).toBe(0);
    expect(records().map((r) => [r.state, r.result])).toEqual([["acted", { edited: false }]]);
    // A second Add after the record closed still finds the suggestion decided, and writes nothing.
    expect(await addSuggestion(await w.scope(PEOPLE.nina), { actionId: a.id, rev: stored(a.id).rev }, w.deps)).toMatchObject({ ok: false, error: "suggestion_decided" });
    expect(w.us.dump(WORK_TASKS)).toHaveLength(1);
    expect(trail(a.id).map((e) => e.kind)).toEqual(["agent.proposed", "agent.approved", "agent.acted"]);
  });

  it("the daily catch-up and get_drafts read the record's own lines only: Work's suggestion and Log draft stay open and uncounted", async () => {
    const a = await suggestion();
    const d = value(await draftWorkLog(await w.scope(PEOPLE.nina), { workstream: "Pricing page", note: "Copy is in review." }, w.deps));
    // A note record whose note is gone: the catch-up closes it as stale, once.
    expect(await recordDraft(PEOPLE.nina, note("aaaaaaaaaaaaaaaa"), { db: w.us, nowMs: NOW_MS })).toBe("recorded");

    const first = await catchUpBrand(SYSTEM, { deadlineMs: FAR, db: w.us, now: () => NOW_MS + 1_000 });
    expect(first).toEqual({ read: 1, closed: 1 });
    expect(await catchUpBrand(SYSTEM, { deadlineMs: FAR, db: w.us, now: () => NOW_MS + 2_000 })).toEqual({ read: 0, closed: 0 });
    expect(records().map((r) => [r.state, r.declined?.reason])).toEqual([["declined", "stale"]]);
    expect(stored(a.id)).toMatchObject({ state: "proposed", rev: 1 });
    expect(stored(d.action.id)).toMatchObject({ state: "proposed", rev: 1 });

    // A note recorded since waits, and is the only draft get_drafts counts.
    expect(await recordDraft(PEOPLE.nina, note("cccccccccccccccc", NOTE_2), { db: w.us, nowMs: NOW_MS + 3_000 })).toBe("recorded");
    const r = await agentDrafts(PEOPLE.nina, {}, { db: w.us, nowMs: NOW_MS + 4_000 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ made: 1, waiting: 1, kept: 0, dismissed: 0 });
    expect(stored(a.id)).toMatchObject({ state: "proposed", rev: 1 });
    expect(stored(d.action.id)).toMatchObject({ state: "proposed", rev: 1 });
  });
});
