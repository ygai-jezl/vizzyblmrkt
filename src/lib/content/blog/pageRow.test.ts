import { describe, expect, it } from "vitest";
import { buildPlanPage, pageFingerprint } from "./pageRow";
import { samplePlan, sampleHub } from "./testing/samplePlan";

describe("an article's row on the brand map", () => {
  it("holds the facts of its page", () => {
    expect(buildPlanPage(samplePlan())).toMatchObject({
      kind: "article",
      workspaceId: "ws1",
      planId: "plan_1",
      url: "https://acme.example/blog/visibility",
      title: "What is AI search visibility monitoring?",
      primaryQuestion: "What is AI search visibility monitoring?",
      primaryRef: "q_aaaaaaaa",
      questions: [
        { text: "How does it differ from SEO rank tracking?", ref: "q_bbbbbbbb" },
        { text: "What does it cost?", ref: null },
      ],
      subjectId: "sub_aaaaaaaa",
      state: "draft",
      liveAt: null,
    });
  });

  it("keeps the names it says and its links to the brand's own pages, once each", () => {
    const row = buildPlanPage(samplePlan())!;
    expect(row.names).toEqual(["Acme Visibility", "AI search visibility monitoring", "Rivalco"]);
    expect(row.links).toEqual(["https://acme.example/customers/harbor", "https://acme.example/product", "https://acme.example/pricing"]);
  });

  it("is planned before it is written, then a draft, then approved", () => {
    const planned = buildPlanPage(samplePlan({}, sampleHub({ body: "", status: "empty" })))!;
    expect(planned).toMatchObject({ state: "planned", links: [], title: "What is AI search visibility monitoring?" });
    // Not written yet: the names it is to say.
    expect(planned.names).toEqual(["Acme Visibility", "AI search visibility monitoring", "Rivalco", "ExampleChat"]);
    expect(buildPlanPage(samplePlan({}, sampleHub({ status: "approved" })))!.state).toBe("approved");
    expect(buildPlanPage(samplePlan({}, null))!.state).toBe("planned");
  });

  it("has no address until an https one is set, and no row unless it is a blog article", () => {
    expect(buildPlanPage(samplePlan({ strategy: { objective: "brand_visibility", hubUrl: null, subscriberCount: null, sequenceType: null } }))!.url).toBeNull();
    expect(buildPlanPage(samplePlan({ strategy: { objective: "brand_visibility", hubUrl: "http://acme.example/x", subscriberCount: null, sequenceType: null } }))!.url).toBeNull();
    expect(buildPlanPage(samplePlan({ topology: { hubChannel: "newsletter", spokeChannels: [] } }))).toBeNull();
    expect(buildPlanPage(samplePlan({ strategy: { objective: "email_sequence", hubUrl: null, subscriberCount: null, sequenceType: "welcome" } }))).toBeNull();
  });

  it("fingerprints the facts, so an unchanged page is never rewritten", () => {
    const row = buildPlanPage(samplePlan())!;
    expect(pageFingerprint(row)).toBe(pageFingerprint(buildPlanPage(samplePlan())!));
    expect(pageFingerprint(row)).not.toBe(pageFingerprint({ ...row, state: "approved" }));
    expect(pageFingerprint(row)).toMatch(/^[0-9a-f]{16}$/);
  });
});
