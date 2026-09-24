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

  it("rejects hub URLs that aren't http(s)", () => {
    expect(IntakeSchema.safeParse({ ...intake(), strategy: { objective: "product_launch", hubUrl: "javascript:alert(1)" } }).success).toBe(false);
  });
});
