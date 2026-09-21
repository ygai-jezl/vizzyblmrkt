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
