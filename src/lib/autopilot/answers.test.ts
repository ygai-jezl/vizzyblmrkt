import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { createContentPlan, getContentPlan, updateContentPlan, updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import { closeDraftRows, takeAnswers } from "./answers";
import { createRun, getRun } from "./runs";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

async function setup(hubBody: string) {
  const db = new FakeFirestore();
  const run = await createRun(A, { id: "run_aaaaaaaaaaaaaaaaaaaaaaaa", mode: "draft", trigger: "schedule", step: "done", question: { questionId: "q_1", text: "How?", subjectId: "sub_1", subjectName: "S" } }, { db });
  await forTenant(A, db).autopilotRuns.update(run.id, { planId: "ap_1", workspaceId: "ws1", askedIds: ["note_1", "note_2"], hubHash: hash("As autopilot wrote it") });
  await createContentPlan(
    A,
    "ws1",
    {
      name: "How?",
      status: "generating",
      strategy: { objective: "brand_visibility" },
      scope: { topics: [], spark: "" },
      knowledge: {},
      topology: { hubChannel: "blog", spokeChannels: [] },
      graph: { nodes: [{ id: "hub", type: "hub", role: "hub", channel: "blog", status: "generated", body: hubBody, position: { x: 0, y: 0 } }], edges: [] },
      autopilot: { runId: run.id, state: "done", at: "" },
    } as never,
    db,
    { id: "ap_1" },
  );
  for (const id of ["note_1", "note_2"]) await forTenant(A, db).brandNotes.create(id, { status: "asked", question: "Q?", text: "", createdAt: "2026-11-18T12:00:00.000Z" } as never);
  return { db, runId: run.id };
}

describe("a draft's questions answered with nobody there", () => {
  it("waits until every question is answered", async () => {
    const { db, runId } = await setup("As autopilot wrote it");
    await forTenant(A, db).brandNotes.update("note_1", { status: "kept", text: "Clients ask for a checklist." } as never);
    expect(await takeAnswers(A, { db })).toBe(0);
    expect((await getRun(A, runId, { db }))!.askedIds).toEqual(["note_2"]);
  });

  it("goes round again from What we've seen when nobody changed the article", async () => {
    const { db, runId } = await setup("As autopilot wrote it");
    for (const id of ["note_1", "note_2"]) await forTenant(A, db).brandNotes.update(id, { status: "kept", text: "An answer." } as never);
    expect(await takeAnswers(A, { db })).toBe(1);
    expect(await getRun(A, runId, { db })).toMatchObject({ step: "seen", active: true, askedIds: [] });
    expect((await getContentPlan(A, "ws1", "ap_1", db))!.autopilot!.state).toBe("working");
  });

  it("never rewrites an article someone changed: Review says the answers are in", async () => {
    const { db, runId } = await setup("Edited by a person");
    for (const id of ["note_1", "note_2"]) await forTenant(A, db).brandNotes.update(id, { status: "kept", text: "An answer." } as never);
    expect(await takeAnswers(A, { db })).toBe(1);
    expect(await getRun(A, runId, { db })).toMatchObject({ step: "done", active: false, answersIn: true, askedIds: [] });
    expect((await getContentPlan(A, "ws1", "ap_1", db))!.autopilot!.state).toBe("done");
  });
});

describe("a draft's question rows close once it is done with", () => {
  /** A tick the hourly look runs on (every 30th two-minute tick, this hour), and one it doesn't. */
  const HOUR = 120_000 * 30;
  const sweepAt = Math.floor(Date.now() / HOUR) * HOUR;
  const sweep = () => new Date(sweepAt);
  const quiet = () => new Date(sweepAt + 120_000);

  it("closes them when the route approves, archives or deletes it", async () => {
    const { db, runId } = await setup("As autopilot wrote it");
    const plan = await getContentPlan(A, "ws1", "ap_1", db);
    expect(await closeDraftRows(A, plan, { db })).toBe(true);
    expect(await getRun(A, runId, { db })).toMatchObject({ askedIds: [], answersIn: false });
    // Nothing left to close, and a plan autopilot didn't write has no rows.
    expect(await closeDraftRows(A, plan, { db })).toBe(false);
    expect(await closeDraftRows(A, { autopilot: null } as never, { db })).toBe(false);
    expect(await closeDraftRows(A, null, { db })).toBe(false);
  });

  it("closes them on the hourly look when the article was approved some other way", async () => {
    const { db, runId } = await setup("As autopilot wrote it");
    await updateContentPlanNode(A, "ws1", "ap_1", "hub", { status: "approved", made: { unstamped: "records_where" } }, db);
    await takeAnswers(A, { db, now: quiet });
    expect((await getRun(A, runId, { db }))!.askedIds).toEqual(["note_1", "note_2"]);
    await takeAnswers(A, { db, now: sweep });
    expect(await getRun(A, runId, { db })).toMatchObject({ askedIds: [], answersIn: false });
  });

  it("closes them on the hourly look when the plan was archived, or an answers-in row is left", async () => {
    const { db, runId } = await setup("As autopilot wrote it");
    await forTenant(A, db).autopilotRuns.update(runId, { askedIds: [], answersIn: true });
    await updateContentPlan(A, "ws1", "ap_1", { status: "archived" }, db);
    await takeAnswers(A, { db, now: sweep });
    expect(await getRun(A, runId, { db })).toMatchObject({ askedIds: [], answersIn: false });
  });

  it("leaves a draft still waiting alone on the hourly look", async () => {
    const { db, runId } = await setup("As autopilot wrote it");
    await takeAnswers(A, { db, now: sweep });
    expect((await getRun(A, runId, { db }))!.askedIds).toEqual(["note_1", "note_2"]);
  });

  it("answers for an approved article don't raise 'answers are in': the row just closes", async () => {
    const { db, runId } = await setup("Edited by a person");
    await updateContentPlanNode(A, "ws1", "ap_1", "hub", { status: "approved", made: { unstamped: "records_where" } }, db);
    for (const id of ["note_1", "note_2"]) await forTenant(A, db).brandNotes.update(id, { status: "kept", text: "An answer." } as never);
    expect(await takeAnswers(A, { db, now: quiet })).toBe(1);
    expect(await getRun(A, runId, { db })).toMatchObject({ step: "done", askedIds: [], answersIn: false });
  });
});
