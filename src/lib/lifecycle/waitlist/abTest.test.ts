import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { EmailMessage } from "@/lib/email";
import type { TenantContext } from "@/lib/tenant/types";
import type { Journey } from "@/lib/types/journey";
import type { ContentPool, LifecycleDraft } from "@/lib/types/lifecycle";
import { computeSequenceEmailBreakdown } from "@/lib/analytics/email";
import { promoteVariant } from "@/lib/journey/abTest";
import { allocateVariant } from "@/lib/journey/allocation";
import { enrolSignupInWaitlistJourney } from "@/lib/journey/router";
import { publishLifecycleJourney, saveLifecycleDraft } from "../service";
import { promoteLaunchWinner, promoteWaitlistVariant } from "./abTest";
import { poolIdFor } from "./convert";
import { switchEngine } from "./engineSwitch";
import { waitlistJourneyId } from "./ids";
import { runWaitlistTick } from "./tick";
import { liveWinners } from "./winners";
import { CAMPAIGN_ID, ctx, publishWaitlist, seedLaunch, seedSignup, system, T0, TENANT_ID, welcomeDraft } from "./testing/fixtures";

/**
 * A person's pick of an email test winner (WAITLIST_AB_WINNER_ENABLED): it reaches the journey a
 * launch sends from on either engine, once, and a test restarted in the editor runs again.
 * Every address is on example.test.
 */

const H = 3600_000;
const MOVED = waitlistJourneyId(CAMPAIGN_ID);
const ORIGINAL = `journey_${CAMPAIGN_ID}`;
const POOL = poolIdFor("welcome");
const AB = { enabled: true, status: "running" as const, splitPercent: 50, variants: [{ variantId: "var_b", subject: "Welcome B", body: "Hi from B" }] };
const GRAPH = {
  nodes: [
    { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
    { id: "welcome", type: "email", position: { x: 0, y: 0 }, data: { subject: "Welcome", body: "Hi {{first_name}}", abTest: AB } },
  ],
  edges: [{ id: "a", source: "trigger", target: "welcome", sourceHandle: null }],
};
/** The same email two days after joining, so someone can be on a version while it changes. */
const WAIT_GRAPH = {
  nodes: [GRAPH.nodes[0]!, { id: "wait", type: "wait", position: { x: 0, y: 0 }, data: { waitHours: 48 } }, GRAPH.nodes[1]!],
  edges: [
    { id: "a", source: "trigger", target: "wait", sourceHandle: null },
    { id: "b", source: "wait", target: "welcome", sourceHandle: null },
  ],
};
const PEOPLE = ["grace", "lin", "noor", "omar", "priya", "quinn", "rosa", "sam"];
/** Someone the test gives the control: only a pick gets them Variant B. */
const CONTROL_PERSON = PEOPLE.find((id) => allocateVariant("welcome", id, AB).variantId === "control")!;

beforeEach(() => {
  vi.stubEnv("WAITLIST_ENGINE_ENABLED", "true");
  vi.stubEnv("WAITLIST_ENGINE_PILOT_TENANTS", TENANT_ID);
  vi.stubEnv("EMAIL_LINK_ORIGIN", "https://mk.test");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function world(opts: { original?: boolean; launch?: Record<string, unknown>; wait?: boolean } = {}) {
  const db = new FakeFirestore();
  seedLaunch(db, opts.launch);
  if (opts.original !== false) {
    db.seed("journeys", ORIGINAL, {
      tenantId: TENANT_ID,
      campaignId: CAMPAIGN_ID,
      status: "active",
      graph: opts.wait ? WAIT_GRAPH : GRAPH,
      createdAt: new Date(T0 - 48 * H).toISOString(),
      updatedAt: new Date(T0 - 48 * H).toISOString(),
    });
  }
  const sends = (variantId: string, opts: { n?: number; nodeId?: string; journeyId?: string } = {}) => {
    const { n = 50, nodeId = "welcome", journeyId = MOVED } = opts;
    for (let i = 0; i < n; i += 1) {
      db.seed("email_events", `ev_${journeyId}_${nodeId}_${variantId}_${i}`, {
        tenantId: TENANT_ID,
        campaignId: CAMPAIGN_ID,
        journeyId,
        nodeId,
        variantId,
        type: "send",
        signupId: `s${i}`,
        recipientKind: "signup",
        createdAt: new Date(T0).toISOString(),
      });
    }
  };
  const repo = forTenant(system, db);
  const moved = async () => (await repo.lifecycleJourneys.getById(MOVED))!;
  const original = async () => (await repo.journeys.getById(ORIGINAL)) as Journey;
  const originalTest = async () => (await original()).graph.nodes.find((n) => n.id === "welcome")!.data.abTest;
  const sent: EmailMessage[] = [];
  const tick = () => runWaitlistTick(system, { db, now: () => Date.now(), send: async (m) => (sent.push(m), { sent: true, provider: "mandrill", id: "lc" }) });
  const got = (id: string) => sent.filter((m) => m.to === `${id}@example.test`).map((m) => m.subject);
  const join = async (id: string) => {
    const s = seedSignup(db, id);
    await enrolSignupInWaitlistJourney(system, CAMPAIGN_ID, s, db);
    await tick();
    return got(id);
  };
  /** The welcome email's versions in the new editor, saved, and published unless told not to. */
  const editTest = async (ids: string[], o: { publish?: boolean } = {}) => {
    const draft = structuredClone((await moved()).draft) as LifecycleDraft;
    draft.pools = draft.pools.map((p) =>
      p.id === POOL
        ? {
            ...p,
            items: ids.map((id) => p.items.find((i) => i.id === id) ?? { ...p.items[0]!, id, label: id, subject: `Welcome ${id}` }),
            abTest: { splitPercent: 50 },
          }
        : p,
    );
    expect((await saveLifecycleDraft(ctx, MOVED, draft, { db, nowMs: Date.now() })).ok).toBe(true);
    if (o.publish !== false) expect((await publishLifecycleJourney(ctx, MOVED, { db, nowMs: Date.now() })).ok).toBe(true);
  };
  return { db, sends, moved, original, originalTest, join, tick, got, editTest };
}

const pick = (db: FakeFirestore, winner: string, opts: { nodeId?: string; as?: TenantContext } = {}) =>
  promoteLaunchWinner(opts.as ?? ctx, CAMPAIGN_ID, opts.nodeId ?? "welcome", winner, { requireMinSample: 50, nowMs: T0 + H }, db);

const pool = (items: string[], abTest = true): ContentPool => ({
  id: "p1",
  label: "Welcome",
  items: items.map((id) => ({ id, label: id, subject: id, body: id, format: "branded", messageClass: "marketing", personalization: "none" })),
  ...(abTest ? { abTest: { splitPercent: 50 } } : {}),
});

describe("liveWinners", () => {
  const picked = { poolId: "p1", nodeId: "email1", itemId: "var_b", arms: ["control", "var_b"], at: "2026-11-01T00:00:00.000Z", by: "usr_1" };

  it("keeps a pick while its test has the arms it was picked from, in any order", () => {
    expect(liveWinners({ abWinners: { p1: "var_b" }, abWinnerHistory: [picked] }, [pool(["var_b", "control"])])).toEqual({ p1: "var_b" });
  });

  it("lets a stopped or restarted test go its own way", () => {
    expect(liveWinners({ abWinners: { p1: "var_b" }, abWinnerHistory: [picked] }, [pool(["control"], false)])).toEqual({});
    expect(liveWinners({ abWinners: { p1: "control" }, abWinnerHistory: [{ ...picked, itemId: "control" }] }, [pool(["control", "var_c"])])).toEqual({});
  });

  it("keeps a pick for an earlier shape of its test, and not once the winner has left it", () => {
    const three = { ...picked, arms: ["control", "var_b", "var_c"] };
    expect(liveWinners({ abWinners: { p1: "var_b" }, abWinnerHistory: [three] }, [pool(["control", "var_b"])])).toEqual({ p1: "var_b" });
    expect(liveWinners({ abWinners: { p1: "var_b" }, abWinnerHistory: [three] }, [pool(["control", "var_c"])])).toEqual({});
    expect(liveWinners({ abWinners: { p1: "var_b" }, abWinnerHistory: [picked] }, [pool(["control", "var_b", "var_c"])])).toEqual({});
  });

  it("keeps a winner with no recorded pick, as before", () => {
    expect(liveWinners({ abWinners: { p1: "var_b" } }, [pool(["control", "var_c"])])).toEqual({ p1: "var_b" });
    expect(liveWinners({}, [pool(["control", "var_b"])])).toEqual({});
  });
});

describe("promoteWaitlistVariant", () => {
  it("records who picked which winner from which arms, once", async () => {
    const db = new FakeFirestore();
    seedLaunch(db);
    const { journey } = await publishWaitlist(db, { draft: welcomeDraft({ abTest: { splitPercent: 50 } }) });
    expect(await promoteWaitlistVariant(ctx, journey.id, "email1", "var_b", { nowMs: T0 }, db)).toEqual({ ok: true });
    expect(await promoteWaitlistVariant(ctx, journey.id, "email1", "var_b", { nowMs: T0 + H }, db)).toEqual({ ok: true });
    expect(await promoteWaitlistVariant(ctx, journey.id, "email1", "control", { nowMs: T0 + H }, db)).toEqual({ ok: false, error: "already_promoted" });
    const after = (await forTenant(system, db).lifecycleJourneys.getById(journey.id))!;
    expect(after.abWinners).toEqual({ p_email1: "var_b" });
    expect(after.abWinnerHistory).toEqual([
      { poolId: "p_email1", nodeId: "email1", itemId: "var_b", arms: ["control", "var_b"], at: new Date(T0).toISOString(), by: "usr_1" },
    ]);
  });
});

describe("promoteLaunchWinner", () => {
  it("on a moved launch, writes the winner where new signups get it and on the original for people finishing there", async () => {
    const w = world();
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    w.sends("var_b", { n: 30 });
    w.sends("var_b", { n: 20, journeyId: ORIGINAL });

    expect(await pick(w.db, "var_b")).toEqual({ ok: true, applied: ["lifecycle", "original"] });
    expect((await w.moved()).abWinners).toEqual({ [POOL]: "var_b" });
    expect((await w.moved()).abWinnerHistory).toMatchObject([{ poolId: POOL, nodeId: "welcome", itemId: "var_b", by: "usr_1" }]);
    expect(await w.originalTest()).toMatchObject({ status: "promoted", enabled: false, winnerVariantId: "var_b" });
  });

  it("needs 50 sends of the winner across both engines, and writes nothing until then", async () => {
    const w = world();
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    w.sends("var_b", { n: 49 });
    w.sends("control", { n: 200 });
    expect(await pick(w.db, "var_b")).toEqual({ ok: false, error: "insufficient_data" });
    expect((await w.moved()).abWinners).toBeUndefined();
    expect(await w.originalTest()).toMatchObject({ status: "running", enabled: true });
  });

  it("is the same pick the second time, and refuses another winner without changing anything", async () => {
    const w = world();
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    w.sends("var_b");
    w.sends("control");
    await pick(w.db, "var_b");
    expect(await pick(w.db, "var_b")).toEqual({ ok: true, applied: [] });
    expect(await pick(w.db, "control")).toEqual({ ok: false, error: "already_promoted" });
    expect((await w.moved()).abWinners).toEqual({ [POOL]: "var_b" });
    expect((await w.moved()).abWinnerHistory).toHaveLength(1);
    expect(await w.originalTest()).toMatchObject({ winnerVariantId: "var_b" });
  });

  it("completes a pick that reached only the original journey", async () => {
    const w = world();
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    w.sends("var_b");
    const { promoteVariant } = await import("@/lib/journey/abTest");
    expect(await promoteVariant(ctx, CAMPAIGN_ID, "welcome", "var_b", {}, w.db)).toEqual({ ok: true });

    expect(await pick(w.db, "var_b")).toEqual({ ok: true, applied: ["lifecycle"] });
    expect((await w.moved()).abWinners).toEqual({ [POOL]: "var_b" });
  });

  it("on a launch still on the original engine, promotes as before and leaves no lifecycle journey", async () => {
    const w = world();
    w.sends("var_b", { journeyId: ORIGINAL });
    expect(await pick(w.db, "var_b")).toEqual({ ok: true, applied: ["original"] });
    expect(await w.originalTest()).toMatchObject({ status: "promoted", winnerVariantId: "var_b" });
    expect((await w.original()).graph.nodes.find((n) => n.id === "welcome")!.data).toMatchObject({ subject: "Welcome B", body: "Hi from B" });
    expect(await forTenant(system, w.db).lifecycleJourneys.getById(MOVED)).toBeNull();
  });

  it("after a rollback, picks on the original first and on the journey people are finishing", async () => {
    const w = world();
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    await switchEngine(ctx, CAMPAIGN_ID, "rollback", { db: w.db, nowMs: T0 + H });
    w.sends("var_b");
    expect(await pick(w.db, "var_b")).toEqual({ ok: true, applied: ["original", "lifecycle"] });
  });

  it("answers with the refusal of the journey new signups get, and writes nothing", async () => {
    const w = world();
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    w.sends("var_b");
    // The test was stopped in the new editor after the move.
    const draft = structuredClone((await w.moved()).draft) as LifecycleDraft;
    draft.pools = draft.pools.map((p) => (p.id === POOL ? { ...p, items: p.items.slice(0, 1), abTest: undefined } : p));
    expect((await saveLifecycleDraft(ctx, MOVED, draft, { db: w.db, nowMs: T0 })).ok).toBe(true);
    expect((await publishLifecycleJourney(ctx, MOVED, { db: w.db, nowMs: T0 })).ok).toBe(true);

    expect(await pick(w.db, "var_b")).toEqual({ ok: false, error: "no_ab_test" });
    expect(await w.originalTest()).toMatchObject({ status: "running" });
    expect(await pick(w.db, "var_b", { nodeId: "nope" })).toEqual({ ok: false, error: "node_not_found" });
  });

  it("picks on a launch that started on the lifecycle engine", async () => {
    const w = world({ original: false, launch: { waitlistEngine: "lifecycle" } });
    await publishWaitlist(w.db, { draft: welcomeDraft({ abTest: { splitPercent: 50 } }) });
    w.sends("var_b", { nodeId: "email1" });
    expect(await pick(w.db, "var_b", { nodeId: "email1" })).toEqual({ ok: true, applied: ["lifecycle"] });
    expect(await pick(w.db, "var_zz", { nodeId: "email1" })).toEqual({ ok: false, error: "already_promoted" });
  });

  it("never reaches another brand's launch", async () => {
    const w = world();
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    w.sends("var_b");
    const other: TenantContext = { ...ctx, tenantId: "ten_other", userId: "usr_other" };
    expect(await pick(w.db, "var_b", { as: other })).toEqual({ ok: false, error: "journey_not_found" });
    expect((await w.moved()).abWinners).toBeUndefined();
    expect(await w.originalTest()).toMatchObject({ status: "running" });
  });

  it("sends the winner to people who join after the pick, and runs a test restarted in the editor", async () => {
    const w = world();
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    w.sends("var_b");
    const people = ["grace", "lin", "noor", "omar", "priya", "quinn", "rosa", "sam"];
    const control = people.find((id) => allocateVariant("welcome", id, AB).variantId === "control")!;
    await pick(w.db, "var_b");
    expect(await w.join(control)).toEqual(["Welcome B"]);

    // Test off, then on again: a new challenger, and the earlier pick no longer applies.
    const draft = structuredClone((await w.moved()).draft) as LifecycleDraft;
    draft.pools = draft.pools.map((p) =>
      p.id === POOL ? { ...p, items: [p.items[0]!, { ...p.items[0]!, id: "var_c", label: "Variant C", subject: "Welcome C" }], abTest: { splitPercent: 50 } } : p,
    );
    expect((await saveLifecycleDraft(ctx, MOVED, draft, { db: w.db, nowMs: T0 })).ok).toBe(true);
    expect((await publishLifecycleJourney(ctx, MOVED, { db: w.db, nowMs: T0 })).ok).toBe(true);
    const restarted = { ...AB, variants: [{ variantId: "var_c", subject: "", body: "" }] };
    const later = people.filter((id) => id !== control);
    for (const id of later) {
      const arm = allocateVariant("welcome", id, restarted).variantId;
      expect(await w.join(id)).toEqual([arm === "control" ? "Welcome" : "Welcome C"]);
    }
  });
});

describe("a pick and the other journey's test", () => {
  it("leaves the original's earlier test running when a test restarted in the new editor picks its control", async () => {
    const w = world();
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    // Restarted after the move: Control against Variant C, while the original still runs Control against Variant B.
    await w.editTest(["control", "var_c"]);
    w.sends("control");

    expect(await pick(w.db, "control")).toEqual({ ok: true, applied: ["lifecycle"] });
    expect(await w.originalTest()).toMatchObject({ enabled: true, status: "running" });
    expect((await w.moved()).abWinners).toEqual({ [POOL]: "control" });
  });

  it("reaches the original where its test is an earlier shape of the one picked from", async () => {
    const w = world();
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    await w.editTest(["control", "var_b", "var_c"]);
    w.sends("var_b");

    expect(await pick(w.db, "var_b")).toEqual({ ok: true, applied: ["lifecycle", "original"] });
    expect(await w.originalTest()).toMatchObject({ status: "promoted", winnerVariantId: "var_b" });
  });

  it("after a rollback, leaves the lifecycle journey's restarted test running", async () => {
    const w = world();
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    await w.editTest(["control", "var_c"]);
    await switchEngine(ctx, CAMPAIGN_ID, "rollback", { db: w.db, nowMs: T0 + H });
    w.sends("control", { journeyId: ORIGINAL });

    expect(await pick(w.db, "control")).toEqual({ ok: true, applied: ["original"] });
    expect((await w.moved()).abWinners).toBeUndefined();
  });
});

describe("people already on a journey when the pick is made", () => {
  it("gives the winner to someone who joined before a version was added to the test", async () => {
    const w = world({ wait: true });
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    expect(await w.join(CONTROL_PERSON)).toEqual([]); // on the first version (Control against Variant B), waiting two days
    vi.setSystemTime(T0 + H);
    await w.editTest(["control", "var_b", "var_c"]);
    w.sends("var_b");
    expect(await pick(w.db, "var_b")).toMatchObject({ ok: true });

    vi.setSystemTime(T0 + 50 * H);
    await w.tick();
    expect(w.got(CONTROL_PERSON)).toEqual(["Welcome B"]);
  });
});

describe("the Analytics tab's view of a moved launch (WAITLIST_AB_WINNER_ENABLED)", () => {
  const welcome = async (db: FakeFirestore) => (await computeSequenceEmailBreakdown(ctx, ORIGINAL, db)).nodes.find((n) => n.nodeId === "welcome")!;
  const view = (n: Awaited<ReturnType<typeof welcome>>) => ({ abTest: n.abTest, status: n.status, winner: n.winnerVariantId, arms: n.arms.map((a) => a.variantId) });

  it("still shows a test decided before the move, with its winner", async () => {
    const w = world();
    w.sends("var_b", { journeyId: ORIGINAL });
    expect(await promoteVariant(ctx, CAMPAIGN_ID, "welcome", "var_b", {}, w.db)).toEqual({ ok: true });
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    const decided = { abTest: true, status: "promoted", winner: "var_b", arms: ["control", "var_b"] };

    expect(view(await welcome(w.db))).toEqual(decided);
    vi.stubEnv("WAITLIST_AB_WINNER_ENABLED", "true");
    expect(view(await welcome(w.db))).toEqual(decided);
    expect(await welcome(w.db)).toMatchObject({ pickedAt: null, earlierPicksAt: [] });
  });

  it("shows the published test a pick checks, and when its winners were picked", async () => {
    vi.stubEnv("WAITLIST_AB_WINNER_ENABLED", "true");
    const w = world();
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    w.sends("var_b");
    expect(await pick(w.db, "var_b")).toMatchObject({ ok: true });
    const pickedAt = new Date(T0 + H).toISOString();
    expect(await welcome(w.db)).toMatchObject({ status: "promoted", winnerVariantId: "var_b", pickedAt, earlierPicksAt: [] });

    // Restarted in the draft only: new signups still get the winner, so the tab still shows it.
    await w.editTest(["control", "var_c"], { publish: false });
    expect(view(await welcome(w.db))).toEqual({ abTest: true, status: "promoted", winner: "var_b", arms: ["control", "var_b"] });
    expect(await pick(w.db, "control")).toEqual({ ok: false, error: "already_promoted" });

    // Published: the new test runs, and the earlier pick is listed with its time.
    expect((await publishLifecycleJourney(ctx, MOVED, { db: w.db, nowMs: T0 + 2 * H })).ok).toBe(true);
    expect(view(await welcome(w.db))).toEqual({ abTest: true, status: "running", winner: null, arms: ["control", "var_c"] });
    expect(await welcome(w.db)).toMatchObject({ pickedAt: null, earlierPicksAt: [pickedAt] });
  });

  it("adds no pick times while the switch is off", async () => {
    const w = world({ original: false, launch: { waitlistEngine: "lifecycle" } });
    await publishWaitlist(w.db, { draft: welcomeDraft({ abTest: { splitPercent: 50 } }) });
    const node = (await computeSequenceEmailBreakdown(ctx, ORIGINAL, w.db)).nodes[0]!;
    expect(node.abTest).toBe(true);
    expect(node).not.toHaveProperty("pickedAt");
    expect(node).not.toHaveProperty("earlierPicksAt");
  });
});
