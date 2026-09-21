import { describe, it, expect } from "vitest";
import type { AiDraft } from "@/lib/types/lifecycle";
import type { ProductContext } from "@/lib/connect/protocol";
import { decideSendVersion } from "./decide";

function draft(over: Partial<AiDraft> = {}): AiDraft {
  return {
    id: "lcd_1",
    tenantId: "t",
    enrolmentId: "enr",
    journeyId: "lcj",
    versionId: "lcj_v1",
    connectionId: "pcn",
    productUserId: "pu",
    externalUserId: "u",
    nodeId: "email_reminders_1",
    poolId: "reminders",
    itemId: "r1",
    itemLabel: "R1",
    status: "approved",
    requireApproval: false,
    sendAt: "2026-09-22T08:30:00.000Z",
    prepareAt: "2026-09-21T20:30:00.000Z",
    approvalDeadline: "2026-09-22T08:15:00.000Z",
    insightId: "i_sov",
    insightSentence: "ChatGPT mentioned you in 3 of 10 answers.",
    aiLine: "That's a strong start for a new brand.",
    subjectVariant: null,
    factsSnapshot: [],
    allowedTerms: ["ChatGPT"],
    attestedTerms: [],
    validationIssues: [],
    draftVersion: 3,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

const context = (ids: string[] = ["i_sov"]): ProductContext => ({
  asOf: "2026-09-22T08:30:00Z",
  steps: [],
  facts: [],
  insights: ids.map((id) => ({ id, sentence: "…", factIds: [], weight: 0.5 })),
});

const decide = (d: AiDraft | null, over: { requireApproval?: boolean; context?: ProductContext | null; aiEnabled?: boolean } = {}) =>
  decideSendVersion({ draft: d, requireApproval: over.requireApproval ?? false, context: over.context === undefined ? context() : over.context, aiEnabled: over.aiEnabled ?? true });

describe("decideSendVersion", () => {
  it("sends the AI line when approved, still grounded and still valid", () => {
    expect(decide(draft())).toEqual({ version: "ai", aiLine: "That's a strong start for a new brand.", subject: null, insightId: "i_sov" });
  });

  it("falls back when the insight is no longer in the live context", () => {
    expect(decide(draft(), { context: context(["i_other"]) })).toEqual({ version: "fallback", reason: "insight_stale" });
    expect(decide(draft(), { context: null })).toEqual({ version: "fallback", reason: "insight_stale" });
  });

  it("falls back when the approved line no longer validates", () => {
    expect(decide(draft({ aiLine: "You're 3x ahead." }))).toEqual({ version: "fallback", reason: "validation_failed" });
  });

  it("drops an invalid AI subject but keeps the line", () => {
    const r = decide(draft({ subjectVariant: "Your 3 wins" }));
    expect(r).toMatchObject({ version: "ai", subject: null });
  });

  it("maps every other state to a fallback reason", () => {
    expect(decide(null)).toEqual({ version: "fallback", reason: "no_draft" });
    expect(decide(draft({ status: "awaiting_approval" }))).toEqual({ version: "fallback", reason: "no_decision" });
    expect(decide(draft({ status: "pending" }))).toEqual({ version: "fallback", reason: "no_decision" });
    expect(decide(draft({ status: "use_fallback", fallbackReason: "generation_failed" }))).toEqual({ version: "fallback", reason: "generation_failed" });
    expect(decide(draft({ status: "used" }))).toEqual({ version: "fallback", reason: "superseded" });
    expect(decide(draft(), { aiEnabled: false })).toEqual({ version: "fallback", reason: "ai_off" });
  });

  it("honours staff choices", () => {
    expect(decide(draft({ status: "skipped" }))).toEqual({ version: "skip", reason: "staff_skipped" });
    expect(decide(draft({ status: "use_fallback", fallbackReason: "staff_choice" }))).toEqual({ version: "fallback", reason: "staff_choice" });
  });

  it("backfilled people get nothing without an approval — but a staff 'standard version' counts", () => {
    const req = { requireApproval: true };
    expect(decide(draft(), req)).toMatchObject({ version: "ai" });
    expect(decide(null, req)).toEqual({ version: "skip", reason: "approval_required" });
    expect(decide(draft({ status: "awaiting_approval" }), req)).toEqual({ version: "skip", reason: "approval_required" });
    expect(decide(draft(), { ...req, context: context(["x"]) })).toEqual({ version: "skip", reason: "approval_required" });
    expect(decide(draft({ status: "use_fallback", fallbackReason: "staff_choice" }), req)).toEqual({ version: "fallback", reason: "staff_choice" });
    expect(decide(draft(), { ...req, aiEnabled: false })).toEqual({ version: "skip", reason: "approval_required" });
  });
});
