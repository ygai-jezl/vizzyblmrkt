import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { EmailMessage, EmailResult } from "@/lib/email";

// The original engine's worker sends through the email module; capture it.
const outbox: Array<{ engine: string; msg: EmailMessage }> = [];
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendEmail: vi.fn(async (msg: EmailMessage): Promise<EmailResult> => {
      outbox.push({ engine: "original", msg });
      return { sent: true, provider: "mandrill", id: `m_${outbox.length}` };
    }),
  };
});

import { processEmailJobs } from "@/lib/email/delivery";
import { enrolSignupInWaitlistJourney } from "@/lib/journey/router";
import { setJourneyState } from "@/lib/journey/service";
import { publishLifecycleJourney } from "../service";
import { countDoubleSends, engineStatus, reconcileWaitlistDrains, switchEngine } from "./engineSwitch";
import { waitlistJourneyId } from "./ids";
import { runWaitlistTick } from "./tick";
import { CAMPAIGN_ID, ctx, seedLaunch, seedSignup, system, T0, TENANT_ID } from "./testing/fixtures";

/**
 * Engine move D5: switching a launch — rehearse, switch, drain, roll back — and
 * the router that sends each new person to exactly one engine. The exit gate:
 * someone part-way through finishes on the original engine, new signups get only
 * the new engine, rollback works, and nobody gets emails from both.
 */

const H = 3600_000;

beforeEach(() => {
  vi.stubEnv("WAITLIST_ENGINE_ENABLED", "true");
  vi.stubEnv("WAITLIST_ENGINE_PILOT_TENANTS", TENANT_ID);
  vi.stubEnv("WAITLIST_JOURNEY_HOLD_ON_PAUSE", "true");
  vi.stubEnv("EMAIL_LINK_ORIGIN", "https://mk.test");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  outbox.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// trigger → Welcome → wait 24 h → Second
const GRAPH = {
  nodes: [
    { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
    { id: "welcome", type: "email", position: { x: 0, y: 0 }, data: { subject: "Welcome", body: "Hi {{first_name}}" } },
    { id: "wait", type: "wait", position: { x: 0, y: 0 }, data: { waitHours: 24 } },
    { id: "second", type: "email", position: { x: 0, y: 0 }, data: { subject: "Second", body: "More" } },
  ],
  edges: [
    { id: "a", source: "trigger", target: "welcome", sourceHandle: null },
    { id: "b", source: "welcome", target: "wait", sourceHandle: null },
    { id: "c", source: "wait", target: "second", sourceHandle: null },
  ],
};

function world(opts: { original?: "active" | "paused" | "draft" | "none" } = {}) {
  const db = new FakeFirestore();
  seedLaunch(db);
  if (opts.original !== "none") {
    db.seed("journeys", `journey_${CAMPAIGN_ID}`, {
      tenantId: TENANT_ID,
      campaignId: CAMPAIGN_ID,
      status: opts.original ?? "active",
      graph: GRAPH,
      createdAt: new Date(T0 - 48 * H).toISOString(),
      updatedAt: new Date(T0 - 48 * H).toISOString(),
    });
  }
  const join = async (id: string) => {
    const s = seedSignup(db, id);
    return enrolSignupInWaitlistJourney(system, CAMPAIGN_ID, s, db);
  };
  const lifecycleSends: EmailMessage[] = [];
  const tick = () =>
    runWaitlistTick(system, {
      db,
      now: () => Date.now(),
      send: async (m) => (lifecycleSends.push(m), { sent: true, provider: "mandrill", id: "lc" }),
    });
  const worker = () => processEmailJobs(system, 100, db);
  const signup = async (id: string) => (await forTenant(system, db).signups.getById(id))!;
  const original = () => outbox.map((o) => `${o.msg.to} ${o.msg.subject}`);
  const lifecycle = () => lifecycleSends.map((m) => `${m.to} ${m.subject}`);
  return { db, join, tick, worker, signup, original, lifecycle };
}

describe("switching a launch to the lifecycle engine", () => {
  it("lets someone part-way through finish on the original, gives new signups only the new engine, and nobody gets both", async () => {
    const w = world();
    expect(await w.join("ada")).toBe("enqueued");
    await w.worker();
    expect(w.original()).toEqual(["ada@example.test Welcome"]);
    expect((await w.signup("ada")).journeyEngine).toBe("legacy");

    const r = await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 + H });
    expect(r).toMatchObject({ ok: true, value: { engine: "lifecycle" } });
    const moved = (await forTenant(system, w.db).lifecycleJourneys.getById(waitlistJourneyId(CAMPAIGN_ID)))!;
    expect(moved).toMatchObject({ status: "active", deliveryMode: "live", publishedVersion: 1 });
    // No backfill: nobody already on the list is enrolled on the new engine.
    expect(await forTenant(system, w.db).waitlistEnrolments.find({})).toHaveLength(0);

    expect(await w.join("grace")).toBe("enqueued");
    expect((await w.signup("grace")).journeyEngine).toBe("lifecycle");
    await w.tick();
    expect(w.lifecycle()).toEqual(["grace@example.test Welcome"]);

    // A day later: ada gets her second email from the original engine; grace hers from the new one.
    vi.setSystemTime(T0 + 25 * H);
    await w.worker();
    // …and with nobody left on the original journey, the same tick retires it.
    const drained = await w.tick();
    expect(w.original()).toEqual(["ada@example.test Welcome", "ada@example.test Second"]);
    expect(w.lifecycle()).toEqual(["grace@example.test Welcome", "grace@example.test Second"]);
    expect(await countDoubleSends(system, CAMPAIGN_ID, w.db)).toBe(0);
    expect(drained.retired).toBe(1);
    const original = (await forTenant(system, w.db).journeys.getById(`journey_${CAMPAIGN_ID}`))!;
    expect(original).toMatchObject({ status: "paused" });
    expect(original.retiredAt).toBeTruthy();
    expect((await engineStatus(ctx, CAMPAIGN_ID, w.db))!).toMatchObject({ engine: "lifecycle", doubleSends: 0, originalRetired: true });
  });

  it("switches back: new signups return to the original engine and those on the new one finish there", async () => {
    const w = world();
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    await w.join("grace");
    await w.tick();
    // Retire the drained original, then roll back: it comes back to life.
    await reconcileWaitlistDrains(system, { db: w.db, nowMs: T0 });
    expect(await switchEngine(ctx, CAMPAIGN_ID, "rollback", { db: w.db, nowMs: T0 + H })).toMatchObject({ ok: true, value: { engine: "legacy" } });
    expect((await forTenant(system, w.db).journeys.getById(`journey_${CAMPAIGN_ID}`))!).toMatchObject({ status: "active", retiredAt: null });

    expect(await w.join("lin")).toBe("enqueued");
    expect((await w.signup("lin")).journeyEngine).toBe("legacy");
    await w.worker();
    expect(w.original()).toEqual(["lin@example.test Welcome"]);
    vi.setSystemTime(T0 + 25 * H);
    await w.tick();
    expect(w.lifecycle()).toEqual(["grace@example.test Welcome", "grace@example.test Second"]);
    const history = (await engineStatus(ctx, CAMPAIGN_ID, w.db))!.history.map((h) => h.engine);
    expect(history).toEqual(["lifecycle", "legacy"]);
  });

  it("rehearses in shadow: the original engine emails people as normal; only the operator gets the new engine's mail", async () => {
    const w = world();
    expect(await switchEngine(ctx, CAMPAIGN_ID, "rehearse", { db: w.db, nowMs: T0 })).toMatchObject({ ok: true, value: { engine: "rehearsal" } });
    expect(await w.join("ada")).toBe("enqueued");
    expect((await w.signup("ada")).journeyEngine).toBe("legacy");
    await w.worker();
    await w.tick();
    expect(w.original()).toEqual(["ada@example.test Welcome"]);
    expect(w.lifecycle()).toEqual(["jez@sandbox.test Welcome"]);

    // Switching clears the rehearsal and goes live without anyone from it.
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 + H });
    expect(await forTenant(system, w.db).waitlistEnrolments.find({})).toHaveLength(0);
    expect((await engineStatus(ctx, CAMPAIGN_ID, w.db))!.doubleSends).toBe(0);
  });

  it("ends a rehearsal without touching anyone", async () => {
    const w = world();
    await switchEngine(ctx, CAMPAIGN_ID, "rehearse", { db: w.db, nowMs: T0 });
    await w.join("ada");
    expect(await switchEngine(ctx, CAMPAIGN_ID, "end_rehearsal", { db: w.db, nowMs: T0 + H })).toMatchObject({ ok: true, value: { engine: "legacy", purged: 1 } });
    expect((await forTenant(system, w.db).lifecycleJourneys.getById(waitlistJourneyId(CAMPAIGN_ID)))!.status).toBe("paused");
  });

  it("refuses to switch while the engine is off, outside the pilot, or with welcome emails paused or blocked", async () => {
    const w = world();
    vi.stubEnv("WAITLIST_ENGINE_ENABLED", "false");
    expect(await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db })).toMatchObject({ ok: false, status: 409, error: "engine_off" });
    vi.stubEnv("WAITLIST_ENGINE_ENABLED", "true");
    vi.stubEnv("WAITLIST_ENGINE_PILOT_TENANTS", "ten_other");
    expect(await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db })).toMatchObject({ ok: false, status: 403, error: "not_in_pilot" });
    vi.stubEnv("WAITLIST_ENGINE_PILOT_TENANTS", "*");
    await setJourneyState(system, CAMPAIGN_ID, "pause", w.db);
    expect(await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db })).toMatchObject({ ok: false, status: 409, error: "journey_paused" });
    const empty = world();
    await forTenant(system, empty.db).journeys.update(`journey_${CAMPAIGN_ID}`, {
      graph: { ...GRAPH, nodes: GRAPH.nodes.map((n) => (n.id === "second" ? { ...n, data: { subject: "", body: "" } } : n)) } as never,
    });
    expect(await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: empty.db })).toMatchObject({ ok: false, status: 422, error: "cannot_convert" });
    expect((await forTenant(system, empty.db).campaigns.getById(CAMPAIGN_ID))!.waitlistEngine).toBeUndefined();
  });

  it("moves a launch whose journey never ran as a draft; its first publish enrols everyone already verified", async () => {
    const w = world({ original: "draft" });
    seedSignup(w.db, "ada");
    seedSignup(w.db, "grace");
    expect(await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 })).toMatchObject({ ok: true, value: { engine: "lifecycle" } });
    const id = waitlistJourneyId(CAMPAIGN_ID);
    expect((await forTenant(system, w.db).lifecycleJourneys.getById(id))!.status).toBe("draft");
    // Joining before it's published: nothing yet (the first publish enrols them).
    expect(await w.join("lin")).toBe("skipped");
    const published = await publishLifecycleJourney(ctx, id, { db: w.db, nowMs: T0 + H });
    expect(published.ok).toBe(true);
    expect((await forTenant(system, w.db).waitlistEnrolments.find({})).map((e) => e.signupId).sort()).toEqual(["ada", "grace", "lin"]);
    expect((await forTenant(system, w.db).lifecycleJourneys.getById(id))!.backfill).toMatchObject({ status: "done", enrolled: 3 });
    await w.tick();
    expect(w.lifecycle().sort()).toEqual(["ada@example.test Welcome", "grace@example.test Welcome", "lin@example.test Welcome"]);
  });
});

describe("countDoubleSends", () => {
  it("counts signups with a send from both engines' journeys", async () => {
    const db = new FakeFirestore();
    const ev = (id: string, journeyId: string, signupId: string) =>
      db.seed("email_events", id, { tenantId: TENANT_ID, campaignId: CAMPAIGN_ID, journeyId, nodeId: "welcome", signupId, variantId: "control", type: "send" });
    ev("1", `journey_${CAMPAIGN_ID}`, "ada");
    ev("2", waitlistJourneyId(CAMPAIGN_ID), "grace");
    expect(await countDoubleSends(system, CAMPAIGN_ID, db)).toBe(0);
    ev("3", waitlistJourneyId(CAMPAIGN_ID), "ada");
    expect(await countDoubleSends(system, CAMPAIGN_ID, db)).toBe(1);
  });
});
