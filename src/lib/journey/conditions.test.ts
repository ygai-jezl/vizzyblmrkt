import { describe, it, expect } from "vitest";
import type { Signup } from "@/lib/types/signup";
import type { Campaign } from "@/lib/types/campaign";
import { JourneyConditionSchema } from "@/lib/types/journey";
import type { JourneyBranch, JourneyCondition } from "@/lib/types/journey";
import {
  evaluateCondition,
  evaluateBranch,
  selectBranch,
  type ConditionContext,
} from "./conditions";

function mkSignup(overrides: Partial<Signup> = {}): Signup {
  return {
    id: "s1",
    tenantId: "t1",
    campaignId: "c1",
    verified: true,
    captchaValid: true,
    isSpam: false,
    status: "verified_active",
    amountReferred: 0,
    referralToken: "tok",
    referralLink: "https://x/y",
    score: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const campaign = {} as Campaign;

function ctx(signup: Signup, rank?: number): ConditionContext {
  return { signup, campaign, rank };
}

function evalC(cond: JourneyCondition, signup: Signup, rank?: number) {
  return evaluateCondition(cond, ctx(signup, rank));
}

describe("evaluateCondition", () => {
  it("madeReferral / usedVoiceChat: is_false is TRUE when the action hasn't happened", () => {
    const fresh = mkSignup(); // 0 referrals, no aiConversation
    expect(evalC({ field: "madeReferral", operator: "is_false" }, fresh)).toBe(true);
    expect(evalC({ field: "usedVoiceChat", operator: "is_false" }, fresh)).toBe(true);
    expect(evalC({ field: "madeReferral", operator: "is_true" }, fresh)).toBe(false);
    expect(evalC({ field: "usedVoiceChat", operator: "is_true" }, fresh)).toBe(false);
  });

  it("madeReferral / usedVoiceChat: is_true is TRUE once the action happened", () => {
    const engaged = mkSignup({
      amountReferred: 2,
      aiConversation: {
        completed: true,
        transcript: [],
        capturedAt: "2026-01-02T00:00:00.000Z",
        bonusApplied: true,
      },
    });
    expect(evalC({ field: "madeReferral", operator: "is_true" }, engaged)).toBe(true);
    expect(evalC({ field: "usedVoiceChat", operator: "is_true" }, engaged)).toBe(true);
    expect(evalC({ field: "madeReferral", operator: "is_false" }, engaged)).toBe(false);
  });

  it("treats an incomplete voice conversation as not used", () => {
    const started = mkSignup({
      aiConversation: {
        completed: false,
        transcript: [],
        capturedAt: "2026-01-02T00:00:00.000Z",
        bonusApplied: false,
      },
    });
    expect(evalC({ field: "usedVoiceChat", operator: "is_false" }, started)).toBe(true);
    expect(evalC({ field: "usedVoiceChat", operator: "is_true" }, started)).toBe(false);
  });

  it("numeric operators on referralCount / engagementBonus", () => {
    const s = mkSignup({ amountReferred: 5, engagementBonus: 100 });
    expect(evalC({ field: "referralCount", operator: "gte", value: 5 }, s)).toBe(true);
    expect(evalC({ field: "referralCount", operator: "gt", value: 5 }, s)).toBe(false);
    expect(evalC({ field: "referralCount", operator: "lt", value: 10 }, s)).toBe(true);
    expect(evalC({ field: "referralCount", operator: "eq", value: 5 }, s)).toBe(true);
    expect(evalC({ field: "referralCount", operator: "neq", value: 5 }, s)).toBe(false);
    expect(evalC({ field: "engagementBonus", operator: "lte", value: 100 }, s)).toBe(true);
  });

  it("rank: numeric ops use the provided rank; undefined rank ⇒ false", () => {
    const s = mkSignup();
    expect(evalC({ field: "rank", operator: "lte", value: 100 }, s, 42)).toBe(true);
    expect(evalC({ field: "rank", operator: "gt", value: 100 }, s, 42)).toBe(false);
    expect(evalC({ field: "rank", operator: "lte", value: 100 }, s, undefined)).toBe(false);
  });

  it("surveyAnswer: matches by question, supports eq/neq/contains (case-insensitive)", () => {
    const s = mkSignup({
      answers: [
        { question_value: "Role", answer_value: "Tech Founder", optional: false },
      ],
    });
    const base = { field: "surveyAnswer", questionValue: "Role" } as const;
    expect(evalC({ ...base, operator: "eq", value: "Tech Founder" }, s)).toBe(true);
    expect(evalC({ ...base, operator: "neq", value: "Investor" }, s)).toBe(true);
    expect(evalC({ ...base, operator: "contains", value: "founder" }, s)).toBe(true);
    // Missing answer for the targeted question.
    expect(evalC({ ...base, operator: "eq", value: "Tech Founder", questionValue: "Other" }, s)).toBe(false);
  });

  it("utmSource string compare", () => {
    const s = mkSignup({ utm: { source: "google" } });
    expect(evalC({ field: "utmSource", operator: "eq", value: "google" }, s)).toBe(true);
    expect(evalC({ field: "utmSource", operator: "contains", value: "goo" }, s)).toBe(true);
    expect(evalC({ field: "utmSource", operator: "eq", value: "facebook" }, s)).toBe(false);
  });

  it("unknown field ⇒ false", () => {
    expect(
      evalC({ field: "nope" as JourneyCondition["field"], operator: "is_true" }, mkSignup()),
    ).toBe(false);
  });
});

describe("evaluateBranch (multi-factor)", () => {
  const vcAiConversation = {
    completed: true,
    transcript: [],
    capturedAt: "2026-01-02T00:00:00.000Z",
    bonusApplied: true,
  };
  const vcAndTwoRef = mkSignup({ amountReferred: 2, aiConversation: vcAiConversation });

  it("match:all is AND — true only when every rule holds", () => {
    const b: JourneyBranch = {
      id: "x",
      match: "all",
      conditions: [
        { field: "usedVoiceChat", operator: "is_true" },
        { field: "referralCount", operator: "gte", value: 1 },
        { field: "referralCount", operator: "lte", value: 2 },
      ],
    };
    expect(evaluateBranch(b, ctx(vcAndTwoRef))).toBe(true);
    // 5 referrals fails the lte 2 rule.
    const vcAndFive = mkSignup({ amountReferred: 5, aiConversation: vcAiConversation });
    expect(evaluateBranch(b, ctx(vcAndFive))).toBe(false);
  });

  it("match:any is OR — true when at least one rule holds", () => {
    const b: JourneyBranch = {
      id: "x",
      match: "any",
      conditions: [
        { field: "usedVoiceChat", operator: "is_true" },
        { field: "referralCount", operator: "gte", value: 99 },
      ],
    };
    expect(evaluateBranch(b, ctx(vcAndTwoRef))).toBe(true);
  });

  it("undefined match defaults to AND (un-parsed/cast doc safe)", () => {
    const b: JourneyBranch = {
      id: "x",
      conditions: [
        { field: "usedVoiceChat", operator: "is_true" },
        { field: "referralCount", operator: "eq", value: 0 },
      ],
    };
    expect(evaluateBranch(b, ctx(vcAndTwoRef))).toBe(false); // 2 referrals ≠ 0
    const vcNoRef = mkSignup({ amountReferred: 0, aiConversation: vcAiConversation });
    expect(evaluateBranch(b, ctx(vcNoRef))).toBe(true);
  });

  it("falls back to the legacy single `condition`", () => {
    const b: JourneyBranch = { id: "x", condition: { field: "madeReferral", operator: "is_true" } };
    expect(evaluateBranch(b, ctx(vcAndTwoRef))).toBe(true);
    expect(evaluateBranch(b, ctx(mkSignup()))).toBe(false);
  });

  it("a branch with neither conditions nor condition ⇒ false (default catches it)", () => {
    expect(evaluateBranch({ id: "x" }, ctx(vcAndTwoRef))).toBe(false);
  });
});

describe("JourneyConditionSchema field enum (dead-end guardrail)", () => {
  it("rejects the invalid keys that caused the incident", () => {
    expect(JourneyConditionSchema.safeParse({ field: "voice_chat", operator: "eq", value: true }).success).toBe(false);
    expect(JourneyConditionSchema.safeParse({ field: "referrals", operator: "eq", value: 1 }).success).toBe(false);
  });
  it("accepts catalog keys", () => {
    expect(JourneyConditionSchema.safeParse({ field: "usedVoiceChat", operator: "is_true" }).success).toBe(true);
    expect(JourneyConditionSchema.safeParse({ field: "referralCount", operator: "gte", value: 3 }).success).toBe(true);
  });
});

describe("selectBranch", () => {
  const br = (id: string, condition: JourneyCondition): JourneyBranch => ({
    id,
    condition,
  });

  it("returns the first matching branch's id", () => {
    const branches = [
      br("a", { field: "referralCount", operator: "gte", value: 10 }),
      br("b", { field: "referralCount", operator: "gte", value: 1 }),
    ];
    const s = mkSignup({ amountReferred: 3 });
    expect(selectBranch(branches, ctx(s))).toBe("b");
  });

  it("respects ordering — an earlier broad rule wins over a later one", () => {
    const branches = [
      br("broad", { field: "referralCount", operator: "gte", value: 1 }),
      br("narrow", { field: "referralCount", operator: "gte", value: 10 }),
    ];
    const s = mkSignup({ amountReferred: 20 });
    expect(selectBranch(branches, ctx(s))).toBe("broad");
  });

  it("falls back to 'default' when no branch matches", () => {
    const branches = [
      br("a", { field: "madeReferral", operator: "is_true" }),
    ];
    expect(selectBranch(branches, ctx(mkSignup()))).toBe("default");
  });

  it("empty / undefined branches ⇒ 'default'", () => {
    expect(selectBranch([], ctx(mkSignup()))).toBe("default");
    expect(selectBranch(undefined, ctx(mkSignup()))).toBe("default");
  });
});
