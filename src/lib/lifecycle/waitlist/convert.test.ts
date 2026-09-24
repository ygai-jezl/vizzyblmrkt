import { describe, expect, it } from "vitest";
import type { JourneyGraph, JourneyNode } from "@/lib/types/journey";
import { LifecycleDraftSchema, type LifecycleDraft } from "@/lib/types/lifecycle";
import { NO_CATALOG, validateLifecycleDraft } from "../graph";
import { convertLegacyJourney, poolIdFor } from "./convert";

/**
 * The converter (engine move D3): an original-engine journey becomes a
 * lifecycle draft with the same emails, ids, routing and timing.
 */

const at = { x: 0, y: 0 };
type Data = JourneyNode["data"];
const n = (id: string, type: JourneyNode["type"], data: Data = {}): JourneyNode => ({ id, type, position: at, data });
const email = (id: string, subject = `Subject ${id}`, extra: Data = {}) => n(id, "email", { subject, body: `Body ${id}`, ...extra });
const wait = (id: string, waitHours: number) => n(id, "wait", { waitHours });
const e = (source: string, target: string, sourceHandle: string | null = null) => ({ id: `${source}->${target}:${sourceHandle ?? ""}`, source, target, sourceHandle });

function convert(nodes: JourneyNode[], edges: ReturnType<typeof e>[]) {
  return convertLegacyJourney({ graph: { nodes, edges } as JourneyGraph });
}

/** Where the converted graph goes from a node (through a wait, if any), with the wait's hours. */
function next(d: LifecycleDraft, from: string, handle: string | null = null): { hours: number | null; to: string } {
  const out = d.graph.edges.find((x) => x.source === from && (x.sourceHandle ?? null) === handle)!;
  const node = d.graph.nodes.find((x) => x.id === out.target)!;
  if (node.type !== "wait") return { hours: null, to: node.id };
  expect(node.data.wait?.after).toBe("previous_step");
  const after = d.graph.edges.find((x) => x.source === node.id)!;
  return { hours: node.data.wait!.minHours, to: after.target };
}

const nodeOf = (d: LifecycleDraft, id: string) => d.graph.nodes.find((x) => x.id === id)!;

describe("convertLegacyJourney", () => {
  it("keeps the emails, their ids and copy, and folds chains of waits into one wait from the previous step", () => {
    const { draft, report } = convert(
      [n("trigger", "trigger"), email("email1", "Welcome {{first_name}}", { heroImageUrl: "https://cdn.example.test/h.png" }), wait("w1", 24), wait("w2", 24), email("email2"), n("exit", "exit")],
      [e("trigger", "email1"), e("email1", "w1"), e("w1", "w2"), e("w2", "email2"), e("email2", "exit")],
    );
    expect(report.ok).toBe(true);
    const d = draft!;
    expect(LifecycleDraftSchema.safeParse(d).success).toBe(true);
    expect(validateLifecycleDraft(d, NO_CATALOG, { audience: "waitlist" }).issues).toEqual([]);
    expect(next(d, "trigger")).toEqual({ hours: null, to: "email1" });
    expect(next(d, "email1")).toEqual({ hours: 48, to: "email2" });
    expect(next(d, "email2")).toEqual({ hours: null, to: "exit" });
    const pool = d.pools.find((p) => p.id === nodeOf(d, "email1").data.poolId)!;
    expect(pool.id).toBe(poolIdFor("email1"));
    expect(pool.items).toEqual([expect.objectContaining({ id: "control", subject: "Welcome {{first_name}}", body: "Body email1", heroImageUrl: "https://cdn.example.test/h.png" })]);
    expect(d.settings.sendPolicy).toMatchObject({ anytime: true, hardStopDays: null });
    expect(d.settings.tracking).toEqual({ opens: true, clicks: true });
    expect(report.notes.map((x) => x.code)).toEqual(expect.arrayContaining(["publish_to_change", "versions"]));
    expect(report.stats).toMatchObject({ emails: 2, waits: 1 });
  });

  it("drops a wait before a plain end, but keeps one before a weekly exit", () => {
    const plain = convert(
      [n("trigger", "trigger"), email("email1"), wait("w1", 72), n("exit", "exit")],
      [e("trigger", "email1"), e("email1", "w1"), e("w1", "exit")],
    );
    expect(next(plain.draft!, "email1")).toEqual({ hours: null, to: "exit" });
    expect(plain.report.notes.map((x) => x.code)).toContain("wait_before_end");

    const weekly = convert(
      [n("trigger", "trigger"), email("email1"), wait("w1", 72), n("weekly", "exit", { exitTargetKind: "weekly" })],
      [e("trigger", "email1"), e("email1", "w1"), e("w1", "weekly")],
    );
    expect(next(weekly.draft!, "email1")).toEqual({ hours: 72, to: "weekly" });
    expect(nodeOf(weekly.draft!, "weekly").data.exitTarget).toBe("weekly");
  });

  it("maps conditions onto signup fields, and ends the journey where the original engine did", () => {
    const cond = n("cond", "condition", {
      branches: [
        { id: "br_ref", match: "all", conditions: [{ field: "referralCount", operator: "gte", value: 2 }, { field: "utmSource", operator: "contains", value: "linkedin" }] },
        { id: "br_survey", condition: { field: "surveyAnswer", operator: "eq", value: "founder", questionValue: "role" } },
        { id: "br_unwired", conditions: [{ field: "verified", operator: "is_true" }] },
        { id: "br_empty" },
      ],
    });
    const { draft, report } = convert(
      [n("trigger", "trigger"), email("email1"), wait("w1", 12), cond, email("email_ref"), email("email_survey"), email("email_else")],
      [e("trigger", "email1"), e("email1", "w1"), e("w1", "cond"), e("cond", "email_ref", "br_ref"), e("cond", "email_survey", "br_survey"), e("cond", "email_else", "default")],
    );
    expect(report.ok).toBe(true);
    const d = draft!;
    expect(next(d, "email1")).toEqual({ hours: 12, to: "cond" });
    expect(nodeOf(d, "cond").data.branches).toEqual([
      { id: "br_ref", match: "all", conditions: [{ field: "signup.referralCount", operator: "gte", value: 2 }, { field: "signup.utmSource", operator: "contains", value: "linkedin" }] },
      { id: "br_survey", match: "all", conditions: [{ field: "signup.surveyAnswer", operator: "eq", value: "founder", questionValue: "role" }] },
      { id: "br_unwired", match: "all", conditions: [{ field: "signup.verified", operator: "is_true" }] },
    ]);
    expect(next(d, "cond", "br_ref").to).toBe("email_ref");
    expect(next(d, "cond", "default").to).toBe("email_else");
    // A branch with nothing connected ends the person's journey, as it does today (not the default).
    expect(nodeOf(d, next(d, "cond", "br_unwired").to).type).toBe("exit");
    expect(report.notes.map((x) => x.code)).toEqual(expect.arrayContaining(["branch_ends", "empty_branch"]));
    expect(validateLifecycleDraft(d, NO_CATALOG, { audience: "waitlist" }).issues).toEqual([]);

    // Every branch wired and no default: anyone matching none of them ends there too.
    const noDefault = convert(
      [n("trigger", "trigger"), email("email1"), n("cond", "condition", { branches: [{ id: "br_v", conditions: [{ field: "verified", operator: "is_true" }] }] }), email("email2")],
      [e("trigger", "email1"), e("email1", "cond"), e("cond", "email2", "br_v")],
    );
    expect(noDefault.report.ok).toBe(true);
    expect(nodeOf(noDefault.draft!, next(noDefault.draft!, "cond", "default").to).type).toBe("exit");
  });

  it("keeps a running A/B test's variants and split, and a promoted test's winner", () => {
    const abTest = { enabled: true, status: "running" as const, splitPercent: 40, variants: [{ variantId: "var_1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", subject: "B", body: "b", heroImageUrl: null }] };
    const running = convert([n("trigger", "trigger"), email("email1", "A", { abTest })], [e("trigger", "email1")]);
    const pool = running.draft!.pools[0]!;
    expect(pool.abTest).toEqual({ splitPercent: 40 });
    expect(pool.items.map((i) => i.id)).toEqual(["control", "var_1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"]);

    const promoted = convert(
      [n("trigger", "trigger"), email("email1", "Winner", { abTest: { ...abTest, enabled: false, status: "promoted", winnerVariantId: abTest.variants[0]!.variantId } })],
      [e("trigger", "email1")],
    );
    expect(promoted.draft!.pools[0]).toMatchObject({ items: [{ id: "control", subject: "Winner" }] });
    expect(promoted.draft!.pools[0]!.abTest).toBeUndefined();
    expect(promoted.report.notes.map((x) => x.code)).toContain("ab_promoted");
  });

  it("turns a sequence hand-off into a plain end, with a note", () => {
    const { draft, report } = convert(
      [n("trigger", "trigger"), email("email1"), n("seq", "exit", { exitTargetKind: "sequence" })],
      [e("trigger", "email1"), e("email1", "seq")],
    );
    expect(nodeOf(draft!, "seq").data.exitTarget).toBeUndefined();
    expect(report.notes.map((x) => x.code)).toContain("sequence_exit");
  });

  it("starts where the original engine does when there's no trigger", () => {
    const { draft } = convert([email("email1"), wait("w1", 6), email("email2")], [e("email1", "w1"), e("w1", "email2")]);
    expect(next(draft!, "trigger")).toEqual({ hours: null, to: "email1" });
    expect(next(draft!, "email1")).toEqual({ hours: 6, to: "email2" });
  });

  it("is blocked by a journey that wouldn't publish, an empty email, a loop, a bad variant id or too many emails", () => {
    expect(convert([n("trigger", "trigger")], []).report.blocking.map((x) => x.code)).toEqual(["invalid_original"]);

    const empty = convert([n("trigger", "trigger"), email("email1"), email("email2", "")], [e("trigger", "email1"), e("email1", "email2")]);
    expect(empty.draft).toBeNull();
    expect(empty.report.blocking.map((x) => x.code)).toContain("email_empty");

    const loop = convert(
      [n("trigger", "trigger"), email("email1"), wait("w1", 1), email("email2")],
      [e("trigger", "email1"), e("email1", "w1"), e("w1", "email2"), e("email2", "email1")],
    );
    expect(loop.report.ok).toBe(false);
    expect(loop.report.blocking.map((x) => x.code).join()).toMatch(/cycle/);

    const bad = convert(
      [n("trigger", "trigger"), email("email1", "A", { abTest: { enabled: true, status: "running", splitPercent: 50, variants: [{ variantId: "Variant One", subject: "B", body: "b" }] } })],
      [e("trigger", "email1")],
    );
    expect(bad.report.blocking.map((x) => x.code)).toContain("unsupported_id");

    const many = Array.from({ length: 61 }, (_, i) => email(`email${i}`));
    const chain = [e("trigger", "email0"), ...many.slice(1).map((m, i) => e(`email${i}`, m.id))];
    expect(convert([n("trigger", "trigger"), ...many], chain).report.blocking.map((x) => x.code)).toContain("too_many_emails");
  });
});
