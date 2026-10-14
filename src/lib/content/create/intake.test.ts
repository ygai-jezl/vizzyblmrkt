import { afterEach, describe, expect, it, vi } from "vitest";
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

  describe("with a brand map", () => {
    afterEach(() => vi.unstubAllEnvs());
    const blogHub = (blog: Record<string, unknown>) => intake({ topology: { hubChannel: "blog", spokeChannels: [] }, blog });

    it("starts the brief on the subject and question chosen, or on none", () => {
      vi.stubEnv("BRAND_MAP_ENABLED", "true");
      vi.stubEnv("CREATE_BLOG_BRAND_MAP_ENABLED", "true");
      expect(planFromIntake(blogHub({ primaryQuestion: "How is it measured?", subjectId: "sub_aaaaaaaa", questionId: "q_bbbbbbbb" })).blog).toMatchObject({
        primaryQuestion: "How is it measured?",
        subjectId: "sub_aaaaaaaa",
        primaryRef: "q_bbbbbbbb",
      });
      // "None of these" is a choice of its own; leaving it means research picks one.
      expect(planFromIntake(blogHub({ subjectId: null })).blog).toMatchObject({ subjectId: null });
      expect(planFromIntake(blogHub({ primaryQuestion: "Why?" })).blog).not.toHaveProperty("subjectId");
      expect(IntakeSchema.safeParse({ ...intake(), blog: { subjectId: "../../x" } }).success).toBe(false);
      expect(IntakeSchema.safeParse({ ...intake(), blog: { questionId: "sub_aaaaaaaa" } }).success).toBe(false);
    });

    it("leaves them off while articles are not written from the map", () => {
      const plan = planFromIntake(blogHub({ primaryQuestion: "Why?", subjectId: "sub_aaaaaaaa", questionId: "q_bbbbbbbb" }));
      expect(plan.blog).not.toHaveProperty("subjectId");
      expect(plan.blog).not.toHaveProperty("primaryRef");
      expect(planFromIntake(blogHub({ subjectId: null }))).not.toHaveProperty("blog");
    });
  });

  it("rejects hub URLs that aren't http(s)", () => {
    expect(IntakeSchema.safeParse({ ...intake(), strategy: { objective: "product_launch", hubUrl: "javascript:alert(1)" } }).success).toBe(false);
  });
});
