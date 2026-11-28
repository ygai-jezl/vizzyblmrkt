import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { loopWeekOf } from "@/lib/loops/count";
import { sumWeek } from "@/lib/loops/testing/sumWeek";
import type { LoopStamp } from "@/lib/types/loopStamp";
import { decideApproval } from "./approvals";

/**
 * A decision on an AI line counts against the line's stamp (learning loops step 5, 4.4): approved
 * as written is kept, approved with the line changed is edited, the standard version or a skip is
 * declined, and only the first decision counts.
 */

const ctx: TenantContext = { tenantId: "ten_lumen", region: "us", source: "idtoken", userId: "uid_priya", email: "priya@example.com", role: "admin" };
const NOW = Date.parse("2027-01-15T10:00:00.000Z");
const SEND = "2027-01-16T10:00:00.000Z";
const LINE = "You set up your first project this week.";
const stamp: LoopStamp = { made: "m1.lifecycle_lines.0.n", kind: "lifecycle_lines", scope: "lifecycle_lines", v: 0, arm: "none", items: [], prompt: null, tokens: { rules: 0, examples: 0 }, at: "2027-01-15T08:00:00.000Z" };

function seedDraft(db: FakeFirestore, id: string, over: Record<string, unknown> = {}) {
  db.seed("lifecycle_drafts", id, {
    tenantId: ctx.tenantId,
    enrolmentId: "enr_1",
    journeyId: "lj_1",
    versionId: "v1",
    connectionId: "pc_1",
    productUserId: "pu_maya",
    externalUserId: "maya",
    nodeId: "n1",
    poolId: "p1",
    itemId: id,
    itemLabel: "Week one",
    status: "awaiting_approval",
    requireApproval: true,
    sendAt: SEND,
    prepareAt: "2027-01-15T08:00:00.000Z",
    approvalDeadline: "2027-01-16T09:45:00.000Z",
    insightId: "ins_1",
    insightSentence: "Set up a first project.",
    aiLine: LINE,
    subjectVariant: null,
    standardSubject: "Your first week",
    factsSnapshot: [],
    allowedTerms: [],
    attestedTerms: [],
    validationIssues: [],
    made: stamp,
    draftVersion: 1,
    createdAt: "2027-01-15T08:00:00.000Z",
    updatedAt: "2027-01-15T08:00:00.000Z",
    ...over,
  });
}

const cell = (db: FakeFirestore) =>
  (sumWeek(db, ctx.tenantId, loopWeekOf(new Date())) as { c?: Record<string, Record<string, unknown>> }).c?.lifecycle_lines?.lifecycle_lines;

beforeEach(() => vi.stubEnv("LOOPS_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("deciding an AI line counts it once", () => {
  it("as kept, edited or declined", async () => {
    const db = new FakeFirestore();
    for (const id of ["a", "b", "c", "d"]) seedDraft(db, id);
    expect((await decideApproval(ctx, "a", { action: "approve", draftVersion: 1 }, db, NOW)).status).toBe(200);
    expect((await decideApproval(ctx, "b", { action: "approve", draftVersion: 1, aiLine: "You set up your first project." }, db, NOW)).status).toBe(200);
    expect((await decideApproval(ctx, "c", { action: "fallback", draftVersion: 1 }, db, NOW)).status).toBe(200);
    expect((await decideApproval(ctx, "d", { action: "skip", draftVersion: 1 }, db, NOW)).status).toBe(200);
    expect(cell(db)).toEqual({ v0: { none: { kept: 1, edited: 1, declined: 2 } } });
    // A change of mind, and a stale or refused decision, count nothing more.
    expect((await decideApproval(ctx, "a", { action: "skip", draftVersion: 2 }, db, NOW)).status).toBe(200);
    expect((await decideApproval(ctx, "b", { action: "skip", draftVersion: 1 }, db, NOW)).status).toBe(409);
    expect(cell(db)).toEqual({ v0: { none: { kept: 1, edited: 1, declined: 2 } } });
  });

  it("counts nothing for a line with no stamp, or with LOOPS_ENABLED off", async () => {
    const db = new FakeFirestore();
    seedDraft(db, "a", { made: { unstamped: "loops_off" } });
    seedDraft(db, "b");
    await decideApproval(ctx, "a", { action: "skip", draftVersion: 1 }, db, NOW);
    vi.stubEnv("LOOPS_ENABLED", "");
    await decideApproval(ctx, "b", { action: "skip", draftVersion: 1 }, db, NOW);
    expect(db.dump("loop_days")).toEqual([]);
  });
});
