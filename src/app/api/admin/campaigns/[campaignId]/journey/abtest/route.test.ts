import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { EmailMessage } from "@/lib/email";

// The pick a person makes on a launch's Analytics tab (Promote), through the real route and
// libraries on the fake database: which email does someone who joins afterwards get?
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const { POST } = await import("./route");
const { forTenant } = await import("@/lib/tenant");
const { allocateVariant } = await import("@/lib/journey/allocation");
const { enrolSignupInWaitlistJourney } = await import("@/lib/journey/router");
const { switchEngine } = await import("@/lib/lifecycle/waitlist/engineSwitch");
const { waitlistJourneyId } = await import("@/lib/lifecycle/waitlist/ids");
const { runWaitlistTick } = await import("@/lib/lifecycle/waitlist/tick");
const { CAMPAIGN_ID, ctx, publishWaitlist, seedLaunch, seedSignup, system, T0, TENANT_ID, welcomeDraft } = await import("@/lib/lifecycle/waitlist/testing/fixtures");

const H = 3600_000;
const AB = { enabled: true, status: "running" as const, splitPercent: 50, variants: [{ variantId: "var_b", subject: "Welcome B", body: "Hi from B" }] };
const GRAPH = {
  nodes: [
    { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
    { id: "welcome", type: "email", position: { x: 0, y: 0 }, data: { subject: "Welcome", body: "Hi {{first_name}}", abTest: AB } },
  ],
  edges: [{ id: "a", source: "trigger", target: "welcome", sourceHandle: null }],
};
const params = { params: Promise.resolve({ campaignId: CAMPAIGN_ID }) };
const pick = (winnerVariantId: string, nodeId = "welcome") =>
  POST(
    new Request(`http://localhost/api/admin/campaigns/${CAMPAIGN_ID}/journey/abtest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "promote", nodeId, winnerVariantId }),
    }),
    params,
  );

/** Someone the test would give the control: only a pick can get them Variant B. */
const CONTROL_PERSON = ["grace", "lin", "noor", "omar", "priya", "quinn", "rosa", "sam"].find(
  (id) => allocateVariant("welcome", id, AB).variantId === "control",
)!;

function world(opts: { original?: boolean; launch?: Record<string, unknown> } = {}) {
  const db = new FakeFirestore();
  store.db = db;
  seedLaunch(db, opts.launch);
  if (opts.original !== false) {
    db.seed("journeys", `journey_${CAMPAIGN_ID}`, {
      tenantId: TENANT_ID,
      campaignId: CAMPAIGN_ID,
      status: "active",
      graph: GRAPH,
      createdAt: new Date(T0 - 48 * H).toISOString(),
      updatedAt: new Date(T0 - 48 * H).toISOString(),
    });
  }
  /** Sends of one arm, enough to pass the 50 send gate. */
  const sends = (variantId: string, opts: { n?: number; nodeId?: string; journeyId?: string } = {}) => {
    const { n = 50, nodeId = "welcome", journeyId = waitlistJourneyId(CAMPAIGN_ID) } = opts;
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
  const lifecycleSends: EmailMessage[] = [];
  const join = async (id: string) => {
    const s = seedSignup(db, id);
    expect(await enrolSignupInWaitlistJourney(system, CAMPAIGN_ID, s, db)).toBe("enqueued");
    await runWaitlistTick(system, { db, now: () => Date.now(), send: async (m) => (lifecycleSends.push(m), { sent: true, provider: "mandrill", id: "lc" }) });
    return lifecycleSends.filter((m) => m.to === `${id}@example.test`).map((m) => m.subject);
  };
  return { db, sends, join };
}

beforeEach(() => {
  vi.clearAllMocks();
  session.getAdminContext.mockResolvedValue(ctx);
  vi.stubEnv("WAITLIST_ENGINE_ENABLED", "true");
  vi.stubEnv("WAITLIST_ENGINE_PILOT_TENANTS", TENANT_ID);
  vi.stubEnv("WAITLIST_AB_WINNER_ENABLED", "true");
  vi.stubEnv("EMAIL_LINK_ORIGIN", "https://mk.test");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("picking an email test winner on a launch moved to the lifecycle engine", () => {
  it("sends the winner to someone who joins afterwards", async () => {
    expect(CONTROL_PERSON).toBeTruthy();
    const w = world();
    expect(await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 })).toMatchObject({ ok: true, value: { engine: "lifecycle" } });
    w.sends("var_b");

    const res = await pick("var_b");
    expect(res.status).toBe(200);

    expect(await w.join(CONTROL_PERSON)).toEqual(["Welcome B"]);
  });

  it("records a pick on a launch that started on the lifecycle engine", async () => {
    const w = world({ original: false, launch: { waitlistEngine: "lifecycle" } });
    await publishWaitlist(w.db, { draft: welcomeDraft({ abTest: { splitPercent: 50 } }), nowMs: T0 - H });
    w.sends("var_b", { nodeId: "email1" });

    const res = await pick("var_b", "email1");
    expect(res.status).toBe(200);
    expect((await forTenant(system, w.db).lifecycleJourneys.getById(waitlistJourneyId(CAMPAIGN_ID)))!.abWinners).toEqual({ p_email1: "var_b" });
  });

  it("answers 409 for another winner once one is picked, and 409 until the winner has 50 sends", async () => {
    const w = world();
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    w.sends("var_b", { n: 49 });
    expect(await (await pick("var_b")).json()).toEqual({ error: "insufficient_data" });
    w.sends("var_b", { n: 1, journeyId: `journey_${CAMPAIGN_ID}` });
    expect((await pick("var_b")).status).toBe(200);
    expect((await pick("var_b")).status).toBe(200);
    const other = await pick("control");
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: "already_promoted" });
    expect((await pick("var_b", "nope")).status).toBe(404);
  });

  it("is for signed-in admins only, and checks what it is sent", async () => {
    const w = world();
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    w.sends("var_b");
    session.getAdminContext.mockResolvedValue(null);
    expect((await pick("var_b")).status).toBe(401);
    session.getAdminContext.mockResolvedValue({ ...ctx, role: "member" });
    expect((await pick("var_b")).status).toBe(403);
    session.getAdminContext.mockResolvedValue(ctx);
    const bad = await POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ action: "promote", nodeId: "" }) }), params);
    expect(bad.status).toBe(400);
    expect((await forTenant(system, w.db).lifecycleJourneys.getById(waitlistJourneyId(CAMPAIGN_ID)))!.abWinners).toBeUndefined();
  });
});

describe("with the switch off", () => {
  it("changes the original journey only, as before", async () => {
    vi.stubEnv("WAITLIST_AB_WINNER_ENABLED", "false");
    const w = world();
    await switchEngine(ctx, CAMPAIGN_ID, "switch", { db: w.db, nowMs: T0 });
    w.sends("var_b");

    expect(await (await pick("var_b")).json()).toEqual({ ok: true });
    const original = (await forTenant(system, w.db).journeys.getById(`journey_${CAMPAIGN_ID}`))!;
    expect(original.graph.nodes.find((n) => n.id === "welcome")!.data.abTest).toMatchObject({ status: "promoted", winnerVariantId: "var_b" });
    expect((await forTenant(system, w.db).lifecycleJourneys.getById(waitlistJourneyId(CAMPAIGN_ID)))!.abWinners).toBeUndefined();
    // A second pick is refused as before: the original's test is over.
    expect(await (await pick("var_b")).json()).toEqual({ error: "no_ab_test" });
  });
});
