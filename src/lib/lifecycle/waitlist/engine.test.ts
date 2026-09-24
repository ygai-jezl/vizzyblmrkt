import { describe, expect, it } from "vitest";
import { SendPolicySchema, type ContentPool, type LifecycleGraph } from "@/lib/types/lifecycle";
import type { Campaign } from "@/lib/types/campaign";
import type { Signup } from "@/lib/types/signup";
import { allocateVariant } from "@/lib/journey/allocation";
import { isInSendWindow, nextWindowAt, scheduleAfterWait } from "../sendWindow";
import { decideNext, type WalkEnv, type WalkState } from "../planner";
import { evaluateLifecycleCondition, type RecipientContext } from "../fields";
import { NO_CATALOG, validateLifecycleDraft } from "../graph";
import { waitlistSettings } from "../service";
import { pickWaitlistItem } from "./pick";
import { welcomeDraft } from "./testing/fixtures";

/**
 * The pure pieces waitlist journeys add to the lifecycle engine (engine move
 * D2): any-time sending, waits counted from the previous step, no hard stop,
 * `signup.*` conditions, A/B arms and audience-aware validation.
 */

const H = 3600_000;
const anytime = SendPolicySchema.parse({ anytime: true, hardStopDays: null });
const SUNDAY_3AM = Date.parse("2026-09-20T02:00:00Z"); // 03:00 BST

function person(over: Partial<Signup> = {}): RecipientContext {
  return {
    user: { traits: {}, steps: {}, milestones: {}, consent: null },
    catalog: { onboardingSteps: [] },
    context: null,
    emailsSent: 0,
    enrolledAtMs: 0,
    nowMs: 0,
    waitlist: {
      signup: { id: "ada", campaignId: "camp1", email: "ada@example.test", status: "verified_active", ...over } as Signup,
      campaign: { id: "camp1" } as Campaign,
      rank: 3,
    },
  };
}

describe("any-time sending", () => {
  it("is always inside the window, on any day", () => {
    expect(isInSendWindow(SUNDAY_3AM, "Europe/London", anytime, 0)).toBe(true);
    expect(nextWindowAt(SUNDAY_3AM, "Europe/London", anytime, 0)).toBe(SUNDAY_3AM);
  });

  it("moves to local midnight when the next email must land on a later day", () => {
    const at = nextWindowAt(SUNDAY_3AM, "Europe/London", anytime, 0, { afterLocalDateOfMs: SUNDAY_3AM });
    expect(new Date(at).toISOString()).toBe("2026-09-20T23:00:00.000Z"); // Monday 00:00 BST
  });

  it("counts a wait from the previous step, not the previous email", () => {
    const lastSentMs = SUNDAY_3AM - 30 * H; // an email long before a condition
    const fromEmail = scheduleAfterWait({ wait: { minHours: 24 }, anchorMs: 0, lastSentMs, nowMs: SUNDAY_3AM, tz: "UTC", policy: anytime, offsetMin: 0 });
    const fromStep = scheduleAfterWait({ wait: { minHours: 24, after: "previous_step" }, anchorMs: 0, lastSentMs, nowMs: SUNDAY_3AM, tz: "UTC", policy: anytime, offsetMin: 0 });
    expect(fromEmail.runAtMs).toBe(SUNDAY_3AM); // already 30 h since the email
    expect(fromStep.runAtMs).toBe(SUNDAY_3AM + 24 * H);
  });
});

describe("the walk for a waitlist journey", () => {
  const draft = welcomeDraft({ exitTarget: "weekly" });
  const env = (over: Partial<WalkEnv> = {}): WalkEnv => ({
    graph: draft.graph,
    pools: draft.pools,
    policy: anytime,
    tz: "UTC",
    offsetMin: 0,
    recipientAt: () => person(),
    ...over,
  });
  const start = (cursor: string, nowMs: number): WalkState => ({ cursor, nowMs, anchorMs: 0, lastSentMs: null, windowExemptUntilMs: null, sent: [] });

  it("has no hard stop: a person can be years in", () => {
    const r = decideNext(start("email1", 900 * 24 * H), env());
    expect(r.decision.kind).toBe("send");
  });

  it("uses the audience's picker for email nodes, and names the exit reached", () => {
    const picked: string[] = [];
    const r = decideNext(start("email2", 0), env({ pickItem: ({ nodeId, pool }) => (picked.push(nodeId), pool.items[0]!) }));
    expect(picked).toEqual(["email2"]);
    expect(r.decision.kind).toBe("send");
    const end = decideNext(start("exit", 0), env());
    expect(end.decision).toEqual({ kind: "complete", nodeId: "exit" });
  });
});

describe("signup.* conditions", () => {
  it("keep the original engine's two-state logic: missing means hasn't", () => {
    expect(evaluateLifecycleCondition({ field: "signup.usedVoiceChat", operator: "is_false" }, person())).toBe(true);
    expect(evaluateLifecycleCondition({ field: "signup.madeReferral", operator: "is_true" }, person({ amountReferred: 2 }))).toBe(true);
    expect(evaluateLifecycleCondition({ field: "signup.rank", operator: "lte", value: 3 }, person())).toBe(true);
    expect(
      evaluateLifecycleCondition(
        { field: "signup.surveyAnswer", operator: "eq", value: "founder", questionValue: "role" },
        person({ answers: [{ question_value: "role", answer_value: "founder" }] } as Partial<Signup>),
      ),
    ).toBe(true);
  });

  it("never match on a product journey's recipient", () => {
    const rc = { ...person(), waitlist: undefined };
    expect(evaluateLifecycleCondition({ field: "signup.usedVoiceChat", operator: "is_false" }, rc)).toBe(false);
  });
});

describe("validating by audience", () => {
  const codes = (d: ReturnType<typeof welcomeDraft>, audience: "product" | "waitlist") =>
    validateLifecycleDraft(d, NO_CATALOG, { audience }).issues.map((i) => i.code);

  it("accepts a waitlist journey's signup fields, A/B pools, weekly exits, long waits and no hard stop", () => {
    const d = welcomeDraft({ exitTarget: "weekly", abTest: { splitPercent: 50 } });
    (d.graph.nodes.find((n) => n.id === "wait1")!.data.wait!).minHours = 24 * 90;
    expect(codes(d, "waitlist")).toEqual([]);
  });

  it("refuses them on a product journey, and product fields on a waitlist journey", () => {
    const d = welcomeDraft({ exitTarget: "weekly", abTest: { splitPercent: 50 } });
    (d.graph.nodes.find((n) => n.id === "wait1")!.data.wait!).minHours = 24 * 90;
    expect(codes(d, "product")).toEqual(
      expect.arrayContaining(["hard_stop_required", "field_not_for_product", "exit_target_waitlist_only", "ab_test_waitlist_only", "wait_too_long"]),
    );
    const w = welcomeDraft();
    w.graph.nodes.find((n) => n.id === "cond1")!.data.branches = [{ id: "br_x", conditions: [{ field: "trait.plan", operator: "eq", value: "pro" }] }];
    expect(codes(w, "waitlist")).toContain("field_not_for_waitlist");
  });

  it("gives new waitlist journeys any-time sending, no hard stop and tracking", () => {
    expect(waitlistSettings()).toMatchObject({ sendPolicy: { anytime: true, hardStopDays: null }, tracking: { opens: true, clicks: true } });
  });
});

describe("pickWaitlistItem", () => {
  const pool = (split?: number): ContentPool => ({
    id: "p_email1",
    label: "Welcome",
    items: [
      { id: "control", label: "A", subject: "A", body: "a", format: "branded", messageClass: "marketing", personalization: "none" },
      { id: "var_b", label: "B", subject: "B", body: "b", format: "branded", messageClass: "marketing", personalization: "none" },
    ],
    ...(split ? { abTest: { splitPercent: split } } : {}),
  });

  it("allocates the original engine's arm for each person, once", () => {
    const legacy = { enabled: true, status: "running" as const, splitPercent: 30, variants: [{ variantId: "var_b", subject: "", body: "" }] };
    for (const id of ["ada", "grace", "lin", "noor", "omar", "priya"]) {
      const item = pickWaitlistItem({ nodeId: "email1", pool: pool(30), signupId: id, sent: [], rc: person() });
      expect(item?.id).toBe(allocateVariant("email1", id, legacy).variantId);
    }
    expect(pickWaitlistItem({ nodeId: "email1", pool: pool(30), signupId: "ada", sent: [{ poolId: "p_email1", itemId: "var_b", status: "sent" }], rc: person() })).toBeNull();
  });

  it("gives everyone a promoted winner, and works like any pool without a test", () => {
    expect(pickWaitlistItem({ nodeId: "email1", pool: pool(30), signupId: "ada", sent: [], rc: person(), winners: { p_email1: "var_b" } })?.id).toBe("var_b");
    const plain = pool();
    expect(pickWaitlistItem({ nodeId: "email1", pool: plain, signupId: "ada", sent: [], rc: person() })?.id).toBe("control");
    expect(pickWaitlistItem({ nodeId: "email1", pool: plain, signupId: "ada", sent: [{ poolId: "p_email1", itemId: "control", status: "sent" }], rc: person() })?.id).toBe("var_b");
  });
});

// Keep the fixture graph honest: it must be a valid waitlist journey.
const graph: LifecycleGraph = welcomeDraft().graph;
it("the fixture journey is valid", () => {
  expect(validateLifecycleDraft({ graph, pools: welcomeDraft().pools }, NO_CATALOG, { audience: "waitlist" }).issues).toEqual([]);
});
