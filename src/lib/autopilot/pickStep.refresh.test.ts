import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { AutopilotRun, NextUpPick } from "@/lib/types/autopilot";
import { pickStep } from "./draftSteps";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const NOW = new Date("2026-11-24T12:00:00.000Z");
const pick = (over: Partial<NextUpPick>): NextUpPick => ({
  questionId: "q_aaaaaaa1",
  question: "Question 1?",
  subjectId: "sub_aaaaaaaa",
  subjectName: "Share of voice",
  because: "Why now.",
  chips: [],
  from: "gemini",
  ...over,
});

describe("a run's pick", () => {
  it("passes over a refresh pick and takes the first article to write", async () => {
    const db = new FakeFirestore();
    await forTenant(A, db).nextUp.create("nu_ten_A", {
      picks: [pick({ questionId: "refresh:plan_1", question: "Article 1", kind: "refresh", planId: "plan_1", workspaceId: "ws1" }), pick({})],
      notOnMap: [],
      missing: [],
      candidates: 5,
      at: NOW.toISOString(),
      by: "person",
    } as never);
    const run = { id: "run_aaaaaaaaaaaaaaaaaaaaaaaa", mode: "draft", question: null } as unknown as AutopilotRun;
    const r = await pickStep(A, run, { deadlineMs: Date.now() + 60_000 }, { db, now: () => NOW } as never);
    expect(r).toMatchObject({ step: "find", question: { questionId: "q_aaaaaaa1" } });
    const left = await forTenant(A, db).nextUp.getById("nu_ten_A");
    expect(left?.picks.map((p) => p.questionId)).toEqual(["refresh:plan_1"]);
  });
});
