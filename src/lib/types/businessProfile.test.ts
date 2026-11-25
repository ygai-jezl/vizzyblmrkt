import { describe, expect, it } from "vitest";
import { BusinessProfileSchema, PROFILE_CHOICES, PROFILE_KEYS, ProfileAnswersInputSchema, ProfileAnswersSchema } from "./businessProfile";
import { TenantSchema } from "./tenant";
import { FACT_KINDS, FACT_KIND_LABEL, QUESTIONS, answerLabel, answeredLabels } from "@/lib/onboarding/choices";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";

const tenant = {
  id: "ten_A",
  tenantName: "Example Co",
  rootDomain: "example.com",
  status: "active",
  region: "us",
  allowedOrigins: ["https://example.com"],
  ownerId: "usr_owner",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("the brand's profile as stored", () => {
  it("reads a whole profile, with rev and answers defaulted", () => {
    expect(BusinessProfileSchema.parse({ status: "started", startedAt: "2026-11-25T10:00:00.000Z" })).toEqual({
      status: "started",
      answers: {},
      rev: 0,
      startedAt: "2026-11-25T10:00:00.000Z",
    });
  });

  it("drops a damaged answer on its own, and a damaged via, rev or updatedAt", () => {
    const p = BusinessProfileSchema.parse({
      status: "done",
      via: "telepathy",
      answers: { who: "robot", run: "shop", stage: "idea", want: 3 },
      rev: -2,
      startedAt: "2026-11-25T10:00:00.000Z",
      updatedAt: 12,
    });
    expect(p).toEqual({ status: "done", answers: { run: "shop", stage: "idea" }, rev: 0, startedAt: "2026-11-25T10:00:00.000Z" });
    expect(ProfileAnswersSchema.parse({ who: "solo", extra: "x" })).toEqual({ who: "solo" });
  });

  it("drops the whole profile when the status is unknown, and the tenant still parses", () => {
    expect(BusinessProfileSchema.safeParse({ status: "halfway", startedAt: "2026-11-25T10:00:00.000Z" }).success).toBe(false);
    const t = TenantSchema.parse({ ...tenant, businessProfile: { status: "halfway" } });
    expect(t.businessProfile).toBeUndefined();
    expect(TenantSchema.parse({ ...tenant, businessProfile: { status: "skipped", startedAt: "2026-11-25T10:00:00.000Z" } }).businessProfile?.status).toBe(
      "skipped",
    );
  });
});

describe("answers as a screen sends them", () => {
  it("are strict: only the four keys, only their choices, never null", () => {
    expect(ProfileAnswersInputSchema.safeParse({ who: "team", want: "customers" }).success).toBe(true);
    expect(ProfileAnswersInputSchema.safeParse({}).success).toBe(true);
    expect(ProfileAnswersInputSchema.safeParse({ who: "robot" }).success).toBe(false);
    expect(ProfileAnswersInputSchema.safeParse({ who: null }).success).toBe(false);
    expect(ProfileAnswersInputSchema.safeParse({ what: "app" }).success).toBe(false);
  });
});

describe("the four questions", () => {
  it("ask in order, each with its three choices in order, as the mockups do", () => {
    expect(QUESTIONS.map((q) => q.key)).toEqual([...PROFILE_KEYS]);
    for (const q of QUESTIONS) expect(q.options.map((o) => o.key)).toEqual([...PROFILE_CHOICES[q.key]]);
    expect(QUESTIONS.map((q) => q.q)).toEqual(["Who are you?", "What do you run?", "Where is it today?", "What do you want from YouGrow first?"]);
    expect(QUESTIONS.map((q) => q.short)).toEqual(["Who you are", "What you run", "Where it is today", "What you want first"]);
    expect(answerLabel("stage", "launched")).toBe("Launched, finding first customers");
    expect(answerLabel("stage", "robot")).toBe("");
    expect(answerLabel("who", undefined)).toBe("");
    expect(answeredLabels({ run: "service", who: "agency" }).map((a) => a.label)).toEqual(["An agency, for clients", "A service or local business"]);
  });

  it("and the fact kinds keep to house style", () => {
    expect(FACT_KINDS.map((k) => FACT_KIND_LABEL[k])).toEqual(["Timeline", "Channel", "Starting point", "Constraint", "Goal"]);
    const words = [...QUESTIONS.flatMap((q) => [q.q, q.short, ...q.options.map((o) => o.label)]), ...Object.values(FACT_KIND_LABEL)];
    for (const w of words) {
      expect(dashesIn(w), w).toEqual([]);
      expect(aiTellsIn(w), w).toEqual([]);
    }
  });
});
