import { describe, it, expect } from "vitest";
import { SANDBOX_CATALOG } from "@/lib/connect/sandbox";
import type { LifecycleDraft } from "@/lib/types/lifecycle";
import { buildProductOnboardingDraft } from "./templates/productOnboarding";
import { validateLifecycleDraft } from "./graph";
import { resolveField, selectLifecycleBranch, matchesEligibility, type RecipientContext } from "./fields";
import { pickPoolItem } from "./pools";

function codes(d: LifecycleDraft) {
  return validateLifecycleDraft(d, SANDBOX_CATALOG).issues.map((i) => i.code);
}
const fresh = () => buildProductOnboardingDraft(SANDBOX_CATALOG);

describe("validateLifecycleDraft", () => {
  it("refuses a condition that can strand users: every branch AND a default edge", () => {
    const d = fresh();
    d.graph.edges = d.graph.edges.filter((e) => !(e.source === "cond_2" && e.sourceHandle === "default"));
    expect(codes(d)).toContain("condition_missing_default_edge");

    const e = fresh();
    e.graph.edges = e.graph.edges.filter((x) => !(x.source === "cond_3" && x.sourceHandle === "done"));
    expect(validateLifecycleDraft(e, SANDBOX_CATALOG).issues).toContainEqual({ code: "branch_unwired", nodeId: "cond_3", detail: "done" });
  });

  it("refuses cycles and unreachable nodes", () => {
    const d = fresh();
    d.graph.edges.push({ id: "loop", source: "email_education_2", target: "wait_1", sourceHandle: null });
    d.graph.nodes.push({ id: "orphan", type: "email", position: { x: 0, y: 0 }, data: { poolId: "welcome" } });
    const c = codes(d);
    expect(c).toContain("cycle");
    expect(c).toContain("unreachable");
  });

  it("checks condition fields against the catalog", () => {
    const d = fresh();
    const cond = d.graph.nodes.find((n) => n.id === "cond_1")!;
    cond.data.branches = [
      { id: "vip", conditions: [{ field: "trait.tier", operator: "eq", value: "vip" }] },
      { id: "x", conditions: [{ field: "step.not_a_step", operator: "is_true" }] },
      { id: "y", conditions: [{ field: "fact.anything", operator: "gt", value: 1 }] },
    ];
    const issues = validateLifecycleDraft(d, SANDBOX_CATALOG).issues.filter((i) => i.code === "unknown_field");
    expect(issues.map((i) => i.detail)).toEqual(['unknown trait "tier"', 'unknown step "not_a_step"']);
  });

  it("reads days since and days until only from the catalog's date facts", () => {
    const d = fresh();
    const cond = d.graph.nodes.find((n) => n.id === "cond_1")!;
    cond.data.branches = [
      { id: "a", conditions: [{ field: "days_since.last_active_at", operator: "gte", value: 14 }] },
      { id: "b", conditions: [{ field: "days_until.share_of_voice", operator: "lte", value: 3 }] },
      { id: "c", conditions: [{ field: "days_since.never_heard_of", operator: "gte", value: 1 }] },
    ];
    const catalog = { ...SANDBOX_CATALOG, facts: [...SANDBOX_CATALOG.facts, { id: "last_active_at", label: "Last active", type: "date" as const, unit: null, description: "", source: "" }] };
    const issues = validateLifecycleDraft(d, catalog).issues.filter((i) => i.code === "unknown_field");
    expect(issues.map((i) => i.detail)).toEqual(['"share_of_voice" isn\'t a date fact', 'unknown fact "never_heard_of"']);
  });

  it("refuses missing pools, empty emails, consecutive waits and exits that continue", () => {
    const d = fresh();
    d.graph.nodes.find((n) => n.id === "email_welcome")!.data.poolId = "nope";
    d.pools[1]!.items[0]!.body = "  ";
    d.graph.nodes.push({ id: "w2", type: "wait", position: { x: 0, y: 0 }, data: { wait: { minHours: 1 } } });
    d.graph.edges = d.graph.edges.map((e) => (e.source === "wait_3" ? { ...e, target: "w2" } : e));
    d.graph.edges.push({ id: "w2c", source: "w2", target: "cond_3", sourceHandle: null });
    d.graph.edges.push({ id: "ex", source: "exit", target: "wait_1", sourceHandle: null });
    const c = codes(d);
    expect(c).toEqual(expect.arrayContaining(["pool_missing", "pool_item_empty", "consecutive_waits", "exit_has_outgoing"]));
  });

  it("won't publish emails built on the checklist while the catalog has no onboarding steps", () => {
    const noSteps = { ...SANDBOX_CATALOG, onboardingSteps: [] };
    const d = buildProductOnboardingDraft(SANDBOX_CATALOG);
    const issues = validateLifecycleDraft(d, noSteps).issues.filter((i) => i.code === "needs_onboarding_steps");
    expect(issues.map((i) => i.detail)).toContain("welcome/w");
    expect(validateLifecycleDraft(d, SANDBOX_CATALOG).issues.some((i) => i.code === "needs_onboarding_steps")).toBe(false);
    const plain = buildProductOnboardingDraft(SANDBOX_CATALOG);
    for (const p of plain.pools) for (const item of p.items) item.body = "<p>Hi {{user.first_name|there}}</p>";
    for (const p of plain.pools) for (const item of p.items) item.subject = "Hello";
    expect(validateLifecycleDraft(plain, noSteps).issues.some((i) => i.code === "needs_onboarding_steps")).toBe(false);
  });

  it("needs exactly one trigger", () => {
    const d = fresh();
    d.graph.nodes = d.graph.nodes.filter((n) => n.type !== "trigger");
    expect(codes(d)).toContain("no_trigger");
  });
});

describe("three-state fields", () => {
  const rc = (over: Partial<RecipientContext> = {}): RecipientContext => ({
    user: { traits: { plan: "pro" }, steps: { create_brand: { doneAt: "x" } }, milestones: {}, consent: null },
    catalog: SANDBOX_CATALOG,
    context: null,
    emailsSent: 1,
    enrolledAtMs: 0,
    nowMs: 3 * 86_400_000,
    ...over,
  });

  it("treats an unknown fact as matching nothing — not even is_false", () => {
    const branches = [{ id: "no_audit", conditions: [{ field: "fact.audit_done", operator: "is_false" as const }] }];
    expect(selectLifecycleBranch(branches, rc())).toBe("default");
    const withFact = rc({
      context: { asOf: "2026-09-21T00:00:00Z", steps: [], facts: [{ id: "audit_done", label: "Audit", value: false }], insights: [] },
    });
    expect(selectLifecycleBranch(branches, withFact)).toBe("no_audit");
  });

  it("prefers the product's live checklist over stored steps", () => {
    expect(resolveField("onboarding.complete", rc())).toBe(false);
    expect(resolveField("onboarding.steps_done", rc())).toBe(1);
    const live = rc({
      context: {
        asOf: "2026-09-21T00:00:00Z",
        steps: ["create_brand", "run_audit", "monitor_prompts"].map((id) => ({ id, label: id, done: true })),
        facts: [],
        insights: [],
      },
    });
    expect(resolveField("onboarding.complete", live)).toBe(true);
    expect(resolveField("enrolment.days_since_enrol", rc())).toBe(3);
    expect(resolveField("consent.basis", rc())).toBe("none");
  });

  it("picks the first unsent, eligible pool item", () => {
    const pool = fresh().pools.find((p) => p.id === "education")!;
    pool.items[1]!.eligibility = { match: "all", conditions: [{ field: "trait.plan", operator: "eq", value: "ultra" }] };
    expect(pickPoolItem(pool, [], rc())?.id).toBe("e1");
    expect(pickPoolItem(pool, [{ poolId: "education", itemId: "e1", status: "sent" }], rc())?.id).toBe("e3");
    expect(matchesEligibility(undefined, rc())).toBe(true);
  });
});

describe("what a journey is about (entities)", () => {
  const withKinds = {
    ...SANDBOX_CATALOG,
    entityKinds: [{ kind: "brand", label: "brand", plural: "brands", parent: null, multiple: true, description: "" }],
  };
  const draftAbout = (about: Record<string, unknown>) => {
    const d = buildProductOnboardingDraft(SANDBOX_CATALOG);
    return { ...d, settings: { ...d.settings, about: { mode: "person", kind: null, pick: "focus", fact: null, includeJoined: false, maxListed: 5, ...about } } } as LifecycleDraft;
  };
  const codesOf = (d: LifecycleDraft, catalog = withKinds) => validateLifecycleDraft(d, catalog).issues.map((i) => i.code);

  it("needs a kind the catalog knows, and a fact for the fact rules", () => {
    expect(codesOf(draftAbout({ mode: "one" }))).toContain("about_kind_missing");
    expect(codesOf(draftAbout({ mode: "one", kind: "workspace" }))).toContain("about_kind_unknown");
    expect(codesOf(draftAbout({ mode: "one", kind: "brand", pick: "fact_high" }))).toContain("about_fact_missing");
    expect(codesOf(draftAbout({ mode: "all", kind: "brand" }))).not.toEqual(expect.arrayContaining(["about_kind_missing", "about_kind_unknown"]));
  });

  it("flags {{entity.name}} with no fallback in a journey that isn't about one of them", () => {
    const d = draftAbout({ mode: "person" });
    d.pools[0]!.items[0]!.subject = "Hi {{entity.name}}";
    expect(codesOf(d)).toContain("entity_token_needs_one");
    d.pools[0]!.items[0]!.subject = "Hi {{entity.name|there}}";
    expect(codesOf(d)).not.toContain("entity_token_needs_one");
    const one = draftAbout({ mode: "one", kind: "brand" });
    one.pools[0]!.items[0]!.subject = "Hi {{entity.name}}";
    expect(codesOf(one)).not.toContain("entity_token_needs_one");
  });

  it("reads entities.* conditions only when the catalog names entity kinds", () => {
    const d = buildProductOnboardingDraft(SANDBOX_CATALOG);
    const cond = d.graph.nodes.find((n) => n.id === "cond_1")!;
    cond.data.branches = [{ id: "many", conditions: [{ field: "entities.count", operator: "gt", value: 1 }] }];
    expect(validateLifecycleDraft(d, SANDBOX_CATALOG).issues).toContainEqual(expect.objectContaining({ code: "unknown_field", detail: "the catalog has no entity kinds" }));
    expect(validateLifecycleDraft(d, withKinds).issues.some((i) => i.code === "unknown_field")).toBe(false);
  });

  it("starts the onboarding template about the brand they're setting up when steps are per brand", () => {
    const perBrand = { ...withKinds, onboardingSteps: SANDBOX_CATALOG.onboardingSteps.map((s) => ({ ...s, kind: "brand" })) };
    expect(buildProductOnboardingDraft(perBrand).settings.about).toMatchObject({ mode: "one", kind: "brand", pick: "focus" });
    expect(buildProductOnboardingDraft(SANDBOX_CATALOG).settings.about).toMatchObject({ mode: "person" });
  });
});
