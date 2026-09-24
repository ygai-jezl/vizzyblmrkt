import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Vizzy's canvas path reads the tenant repository without an injected database.
let fake: FakeFirestore;
vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant")>();
  return { ...actual, forTenant: (ctx: Parameters<typeof actual.forTenant>[0], db?: Parameters<typeof actual.forTenant>[1]) => actual.forTenant(ctx, db ?? fake) };
});
vi.mock("@/lib/agents/creative", () => ({
  draftCopy: vi.fn(async () => ({ variants: [{ subject: "Welcome aboard", body: "Hi {{first_name}}" }], source: "agent3" })),
}));
vi.mock("@/lib/content/create/activeBrandVoice", () => ({ activeBrandVoiceText: vi.fn(async () => null) }));

import { forTenant } from "@/lib/tenant";
import { journeyCanvasKind } from "@/lib/canvas/kinds/journey";
import { setJourneyState } from "@/lib/journey/service";
import { setLaunchArchived } from "@/lib/tenant/launchArchive";
import { loadWaitlistJourneys } from "@/lib/journey/waitlistJourneys";
import { loadGrowthSignals } from "@/lib/nav/growthSignals";
import { agentJourneyItem } from "@/lib/review/summary";
import { emailNames } from "@/lib/insights/names";
import { computeSequenceEmailBreakdown } from "@/lib/analytics/email";
import { getContactEmailHistory } from "@/lib/crm/emailHistory";
import {
  duplicateJourneyTo,
  enrolByHand,
  generateJourneyDraft,
  getJourneyDetail,
  journeyAnalytics,
  listEnrolments,
  listJourneys,
  runNow,
  setJourneyStatus,
  stopEnrolment,
} from "../adminApi";
import { enrolWaitlistSignup } from "./enrol";
import { waitlistEnrolmentId, waitlistJourneyId } from "./ids";
import { CAMPAIGN_ID, ctx, publishWaitlist, seedLaunch, seedSignup, system, T0, TENANT_ID, welcomeDraft } from "./testing/fixtures";

/**
 * Engine move D4: every screen and API that shows a launch's welcome journey
 * finds it on the lifecycle engine once the launch has moved.
 */

beforeEach(() => {
  vi.stubEnv("WAITLIST_ENGINE_ENABLED", "true");
  vi.stubEnv("EMAIL_LINK_ORIGIN", "https://mk.test");
  fake = new FakeFirestore();
});
afterEach(() => vi.unstubAllEnvs());

const ORIGINAL = {
  tenantId: TENANT_ID,
  campaignId: CAMPAIGN_ID,
  status: "active",
  graph: {
    nodes: [
      { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
      { id: "email1", type: "email", position: { x: 0, y: 0 }, data: { subject: "Hi", body: "Hi" } },
    ],
    edges: [{ id: "e0", source: "trigger", target: "email1", sourceHandle: null }],
  },
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
};

/** A launch that has moved: its original journey (still draining) and its journey on the lifecycle engine. */
async function moved(opts: { original?: boolean } = {}) {
  const db = fake;
  seedLaunch(db, { waitlistEngine: "lifecycle" });
  if (opts.original !== false) db.seed("journeys", `journey_${CAMPAIGN_ID}`, ORIGINAL);
  const { journey, version } = await publishWaitlist(db, { draft: welcomeDraft({ abTest: { splitPercent: 50 } }) });
  return { db, journey, version };
}

describe("the lifecycle admin API for a launch's welcome journey", () => {
  it("describes it as the launch's, sending from the launch's sender, and keeps it out of product lists", async () => {
    const { db, journey } = await moved();
    const detail = (await getJourneyDetail(ctx, journey.id, db)).body as Record<string, unknown>;
    expect(detail).toMatchObject({
      audience: "waitlist",
      connection: null,
      launch: { id: CAMPAIGN_ID, name: "Fernlight", archived: false },
      issues: [],
      sender: { verified: true, fromEmail: "jez@sandbox.test" },
      features: { chatAuthoring: false, aiLines: false },
    });
    const list = (await listJourneys(ctx, {}, db)).body as { journeys: Array<{ id: string }> };
    expect(list.journeys.map((j) => j.id)).not.toContain(journey.id);
  });

  it("lists the launch's people, runs and stops their enrolments, and reports results without a product goal", async () => {
    const { db, journey, version } = await moved();
    const campaign = (await forTenant(system, db).campaigns.getById(CAMPAIGN_ID))!;
    await forTenant(system, db).lifecycleJourneys.update(journey.id, { deliveryMode: "test", testRecipients: { userIds: [], emails: ["ada@example.test"] } });
    const testJourney = (await forTenant(system, db).lifecycleJourneys.getById(journey.id))!;
    const ada = seedSignup(db, "ada");
    await enrolWaitlistSignup(system, { journey: testJourney, version, campaign, signup: ada, source: "trigger" }, { db, nowMs: T0 });
    const id = waitlistEnrolmentId(journey.id, "ada");

    const rows = (await listEnrolments(ctx, journey.id, {}, db)).body as { enrolments: Array<{ id: string; user: { email: string } }> };
    expect(rows.enrolments).toMatchObject([{ id, user: { email: "ada@example.test" } }]);

    const sent: string[] = [];
    const ran = await runNow(ctx, id, { db, now: () => T0 + 60_000, send: async (m) => (sent.push(m.subject), { sent: true, provider: "mandrill", id: "m" }) });
    expect(ran).toMatchObject({ status: 200, body: { outcome: "sent" } });
    expect(sent).toHaveLength(1);

    const results = (await journeyAnalytics(ctx, journey.id, db)).body as Record<string, unknown>;
    expect(results).toMatchObject({ enrolments: { total: 1, active: 1 }, goal: null });

    expect((await stopEnrolment(ctx, id, db, T0 + 120_000)).status).toBe(200);
    expect((await forTenant(system, db).waitlistEnrolments.getById(id))!.stopReason).toBe("stopped_by_admin");
  });

  it("refuses what only makes sense for a product: enrol by hand, generate, copy to a product, archive", async () => {
    const { db, journey } = await moved();
    expect((await enrolByHand(ctx, journey.id, { userId: "u1" }, db)).body).toEqual({ error: "not_for_waitlist" });
    expect((await generateJourneyDraft(ctx, journey.id, {}, { db })).body).toEqual({ error: "not_for_waitlist" });
    expect((await duplicateJourneyTo(ctx, journey.id, { connectionId: "pcn_life" }, db)).body).toEqual({ error: "not_for_waitlist" });
    expect((await setJourneyStatus(ctx, journey.id, { status: "archived" }, db)).body).toEqual({ error: "pause_instead" });
  });
});

describe("screens that show a launch's welcome journey", () => {
  it("the Journeys list links a moved launch to its journey on the lifecycle engine", async () => {
    const { db, journey } = await moved();
    const rows = await loadWaitlistJourneys(system, db);
    expect(rows).toMatchObject([{ campaignId: CAMPAIGN_ID, engine: "lifecycle", status: "active", emails: 3, href: `/admin/lifecycle/${journey.id}` }]);
  });

  it("Home counts a moved launch's welcome emails as live, but not toward a product's journeys", async () => {
    const { db } = await moved({ original: false });
    const signals = await loadGrowthSignals(system, { lifecycle: true }, db);
    expect(signals.welcomeEmailLive).toBe(true);
    expect(signals.journeys).toBe(0);
  });

  it("Review names Vizzy's draft for a launch as the launch's welcome emails", () => {
    const item = agentJourneyItem(
      { id: "lcjw_x", name: "x", authoredBy: "agent", publishedVersion: null, status: "draft", audience: { kind: "waitlist", campaignId: CAMPAIGN_ID } },
      "Fernlight",
    );
    expect(item).toMatchObject({ title: "Welcome emails for Fernlight", href: "/admin/lifecycle/lcjw_x" });
  });

  it("Insights and the Audience email history name the lifecycle engine's sends", async () => {
    const { db, journey } = await moved();
    expect((await emailNames(system, [journey.id], db)).get(journey.id)).toBe("Welcome & nurture · Fernlight");
    db.seed("contacts", "ct_1", { tenantId: TENANT_ID, email: "ada@example.test", campaigns: [{ campaignId: CAMPAIGN_ID, signupId: "ada" }] });
    db.seed("email_events", "ev1", { tenantId: TENANT_ID, campaignId: CAMPAIGN_ID, journeyId: journey.id, nodeId: "email1", signupId: "ada", variantId: "var_b", type: "send", ts: "2026-09-21T07:00:00Z" });
    const contact = (await forTenant(system, db).contacts.getById("ct_1"))!;
    const history = await getContactEmailHistory(system, contact, db);
    expect(history.map((h) => h.subject)).toEqual(["You're in, {{first_name}}"]);
  });

  it("a launch that started on the lifecycle engine gets a per-email breakdown from its journey there", async () => {
    const { db, journey } = await moved({ original: false });
    db.seed("email_events", "ev1", { tenantId: TENANT_ID, campaignId: CAMPAIGN_ID, journeyId: journey.id, nodeId: "email1", signupId: "ada", variantId: "var_b", type: "send", ts: "2026-09-21T07:00:00Z" });
    const { nodes } = await computeSequenceEmailBreakdown(system, `journey_${CAMPAIGN_ID}`, db);
    expect(nodes.map((n) => [n.nodeId, n.sent, n.abTest])).toEqual([
      ["email1", 1, true],
      ["email2", 0, false],
      ["email3", 0, false],
    ]);
    expect(nodes[0]!.arms.map((a) => [a.variantId, a.label, a.sent])).toEqual([
      ["control", "Control", 0],
      ["var_b", "Variant A", 1],
    ]);
  });
});

describe("pausing, resuming and archiving a moved launch control both engines", () => {
  it("pauses both, and resuming releases people on both without enrolling anyone new on the original", async () => {
    const { db, journey } = await moved();
    seedSignup(db, "newcomer"); // verified, never on the original journey
    expect(await setJourneyState(system, CAMPAIGN_ID, "pause", db)).toEqual({ ok: true, status: "paused" });
    expect((await forTenant(system, db).lifecycleJourneys.getById(journey.id))!.status).toBe("paused");
    expect((await forTenant(system, db).journeys.getById(`journey_${CAMPAIGN_ID}`))!.status).toBe("paused");

    const r = await setJourneyState(system, CAMPAIGN_ID, "activate", db);
    expect(r).toMatchObject({ ok: true, status: "active", enqueued: 0, moved: { released: 0, expired: 0 } });
    expect((await forTenant(system, db).lifecycleJourneys.getById(journey.id))!.status).toBe("active");
    expect((await forTenant(system, db).journeys.getById(`journey_${CAMPAIGN_ID}`))!.status).toBe("active");
    expect(await forTenant(system, db).emailJobs.find({})).toEqual([]);
  });

  it("archiving the launch pauses its journey on the lifecycle engine too", async () => {
    const { db, journey } = await moved();
    const sink = { put: async () => {} };
    const r = await setLaunchArchived(ctx, CAMPAIGN_ID, "archive", {}, db, sink);
    expect(r.journeyPaused).toBe(true);
    expect((await forTenant(system, db).lifecycleJourneys.getById(journey.id))!.status).toBe("paused");
  });
});

describe("Vizzy's welcome-journey drafts once the original editor is retired (engine move D6)", () => {
  it("won't draft on the original engine: the launch has to move first", async () => {
    vi.stubEnv("WAITLIST_LEGACY_EDITOR", "read_only");
    seedLaunch(fake);
    const graph = { nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} }], edges: [] };
    const r = await journeyCanvasKind.authorDraft({ ctx, input: { scope: { campaignId: CAMPAIGN_ID }, graph }, brief: "Welcome" });
    expect(r).toMatchObject({ ok: false, status: 409, error: "original_editor_retired" });
    expect(await forTenant(system, fake).journeys.getById(`journey_${CAMPAIGN_ID}`)).toBeNull();
  });
});

describe("Vizzy's welcome-journey drafts for a moved launch", () => {
  it("saves a lifecycle DRAFT — the live version doesn't change until someone publishes", async () => {
    const { journey } = await moved();
    const graph = {
      nodes: [
        { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
        { id: "e1", type: "email", position: { x: 0, y: 0 }, data: { label: "Welcome" } },
        { id: "w1", type: "wait", position: { x: 0, y: 0 }, data: { waitHours: 48 } },
        { id: "e2", type: "email", position: { x: 0, y: 0 }, data: { label: "Follow-up" } },
      ],
      edges: [
        { id: "a", source: "trigger", target: "e1", sourceHandle: null },
        { id: "b", source: "e1", target: "w1", sourceHandle: null },
        { id: "c", source: "w1", target: "e2", sourceHandle: null },
      ],
    };
    const r = await journeyCanvasKind.authorDraft({ ctx, input: { scope: { campaignId: CAMPAIGN_ID }, graph }, brief: "Warm welcome" });
    expect(r).toMatchObject({ ok: true, id: waitlistJourneyId(CAMPAIGN_ID), url: `/admin/lifecycle/${journey.id}`, card: { title: "Fernlight — welcome emails" } });
    const after = (await forTenant(system, fake).lifecycleJourneys.getById(journey.id))!;
    expect(after.authoredBy).toBe("agent");
    expect(after.publishedVersion).toBe(1);
    expect(after.draft.graph.nodes.filter((n) => n.type === "email").map((n) => n.id)).toEqual(["e1", "e2"]);
    expect(after.draft.pools.flatMap((p) => p.items.map((i) => i.subject))).toEqual(["Welcome aboard", "Welcome aboard"]);
    // The original journey is untouched.
    expect((await forTenant(system, fake).journeys.getById(`journey_${CAMPAIGN_ID}`))!.graph).toEqual(ORIGINAL.graph);
  });
});
