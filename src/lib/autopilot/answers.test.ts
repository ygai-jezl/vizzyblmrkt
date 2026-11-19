import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { createContentPlan, getContentPlan } from "@/lib/tenant/workspaceContent";
import { takeAnswers } from "./answers";
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
