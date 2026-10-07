import { describe, expect, it } from "vitest";
import { IntakeSchema, planFromIntake } from "./intake";

const intake = (over: Record<string, unknown> = {}) =>
  IntakeSchema.parse({
    name: "Weekly plate",
    strategy: { objective: "newsletter_signups" },
    scope: { topics: ["audience", "audience", "not-a-topic"], spark: "15-minute dinners" },
    knowledge: {},
    topology: { hubChannel: "newsletter", spokeChannels: ["linkedin", "x", "linkedin", "newsletter", "standalone", "fax"] },
    ...over,
  });

describe("content plan intake", () => {
  it("keeps only real topics and real, non-hub spoke channels, once each", () => {
    const plan = planFromIntake(intake());
    expect(plan.scope.topics).toEqual(["audience"]);
    expect(plan.topology.spokeChannels).toEqual(["linkedin", "x"]);
    expect(plan).toMatchObject({ status: "draft", graph: { nodes: [], edges: [] } });
  });

  it("defaults an email sequence to a welcome sequence, and drops the type otherwise", () => {
    expect(planFromIntake(intake({ strategy: { objective: "email_sequence" } })).strategy.sequenceType).toBe("welcome");
    expect(planFromIntake(intake({ strategy: { objective: "newsletter_signups", sequenceType: "win_back" } })).strategy.sequenceType).toBeNull();
  });

  it("starts a blog hub's brief from what the operator already knows, and only for a blog", () => {
    const blog = { primaryQuestion: "  How do I track my brand in AI answers? ", buyerQuestions: "Which engines?" };
    const plan = planFromIntake(intake({ topology: { hubChannel: "blog", spokeChannels: ["linkedin"] }, blog }));
    expect(plan.blog).toMatchObject({
      primaryQuestion: "How do I track my brand in AI answers?",
      buyerQuestions: "Which engines?",
      questions: [],
      researchedAt: null,
    });
    // Nothing typed → no brief yet (research starts one); not a blog hub → never a brief.
    expect(planFromIntake(intake({ topology: { hubChannel: "blog", spokeChannels: [] } }))).not.toHaveProperty("blog");
    expect(planFromIntake(intake({ blog }))).not.toHaveProperty("blog");
    expect(IntakeSchema.safeParse({ ...intake(), blog: { primaryQuestion: "x".repeat(301) } }).success).toBe(false);
  });

  it("rejects hub URLs that aren't http(s)", () => {
    expect(IntakeSchema.safeParse({ ...intake(), strategy: { objective: "product_launch", hubUrl: "javascript:alert(1)" } }).success).toBe(false);
  });
});
