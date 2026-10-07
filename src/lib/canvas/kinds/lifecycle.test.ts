import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { CONNECTION_ID, ctx as adminCtx, publishOnboarding, seedWorld, system } from "@/lib/lifecycle/testing/fixtures";
import { agentLifecycleContext, agentLifecycleJourney } from "@/lib/lifecycle/agentApi";
import { seedUser } from "@/lib/lifecycle/testing/fixtures";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import { JOURNEY_COMPLETED_EVENT, type LifecycleDraft } from "@/lib/types/lifecycle";
import { authorLifecycleDraft, wholeDayWaitNotes } from "./lifecycle";

const agent: TenantContext = { tenantId: adminCtx.tenantId, region: "eu", userId: "usr_1", role: "admin", source: "agent" };
const generate = async () =>
  JSON.stringify({ subject: "Hi {{user.first_name|there}}", previewText: "Quick note", body: "<p>Hello {{user.first_name|there}}</p>" });

beforeEach(() => {
  process.env.LIFECYCLE_ENABLED = "true";
  process.env.LIFECYCLE_CHAT_AUTHORING_ENABLED = "true";
  __resetRateLimitState();
});
afterEach(() => {
  delete process.env.LIFECYCLE_ENABLED;
  delete process.env.LIFECYCLE_CHAT_AUTHORING_ENABLED;
  delete process.env.EMAIL_STYLE_ENABLED;
  delete process.env.EMAIL_JOURNEY_STYLE_ENABLED;
  delete process.env.LIFECYCLE_JOURNEY_LINKS_ENABLED;
});

describe("lifecycle canvas kind (Vizzy chat authoring)", () => {
  it("drafts a journey from the template: an agent-authored DRAFT in test mode, with a canvas card", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const r = await authorLifecycleDraft(
      { ctx: agent, input: { scope: { connectionId: CONNECTION_ID }, mode: "template", options: { reminders: 2 } }, brief: "Warm and short" },
      { db, generate },
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.url).toBe(`/admin/lifecycle/${r.id}`);
    expect(r.card).toMatchObject({ kind: "lifecycle", title: "Sandbox onboarding", stats: [{ label: "emails", value: 8 }, { label: "splits", value: 4 }, { label: "waits", value: 5 }], warnings: 0 });
    expect(r.summary).toContain("nothing sends until you do");
    const saved = await forTenant(system, db).lifecycleJourneys.getById(r.id);
    expect(saved).toMatchObject({ status: "draft", deliveryMode: "test", authoredBy: "agent", publishedVersion: null });
    expect(saved!.draft.pools[0]!.items[0]!.subject).toBe("Hi {{user.first_name|there}}");
  });

  it("a chat edit changes only the draft — never the published version", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey } = await publishOnboarding(db);
    const draft = structuredClone(journey.draft);
    draft.pools[1]!.items[1]!.subject = "Shorter last reminder";
    const r = await authorLifecycleDraft(
      { ctx: agent, input: { scope: { connectionId: CONNECTION_ID, journeyId: journey.id }, mode: "graph", ...draft }, brief: "make it shorter" },
      { db },
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.summary).toContain("The live version hasn't changed");
    const v1 = await forTenant(system, db).lifecycleVersions.getById(`${journey.id}_v1`);
    expect(v1!.pools[1]!.items[1]!.subject).not.toBe("Shorter last reminder");
    const now = await forTenant(system, db).lifecycleJourneys.getById(journey.id);
    expect(now!.draft.pools[1]!.items[1]!.subject).toBe("Shorter last reminder");
    expect(now!.publishedVersion).toBe(1);
  });

  it("a chat edit keeps the journey's email style: a damaged echo of it still saves, and a new one isn't this kind's to set", async () => {
    process.env.EMAIL_JOURNEY_STYLE_ENABLED = "true";
    const NAVY = { headerColor: "#0b1f3a", accentColor: "#ff6b35" };
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey } = await publishOnboarding(db);
    const doc = structuredClone(db.raw("lifecycle_journeys", journey.id)) as { draft: { settings: Record<string, unknown> } };
    doc.draft.settings.emailStyle = NAVY;
    db.seed("lifecycle_journeys", journey.id, doc);

    for (const echo of [{ headerColor: "navy", accentColor: 7 }, { headerColor: "#0f766e", accentColor: "#f59e0b" }, null]) {
      const draft = structuredClone(journey.draft);
      draft.pools[1]!.items[1]!.subject = "Shorter last reminder";
      const r = await authorLifecycleDraft(
        {
          ctx: agent,
          input: { scope: { connectionId: CONNECTION_ID, journeyId: journey.id }, mode: "graph", ...draft, settings: { ...draft.settings, emailStyle: echo } },
          brief: "make it shorter",
        },
        { db },
      );
      expect(r.ok).toBe(true);
      const raw = db.raw("lifecycle_journeys", journey.id) as { draft: { settings: Record<string, unknown>; pools: Array<{ items: Array<{ subject: string }> }> } };
      expect(raw.draft.pools[1]!.items[1]!.subject).toBe("Shorter last reminder");
      expect(raw.draft.settings.emailStyle).toStrictEqual(NAVY);
    }

    // A new journey drafted in graph mode starts on the brand's style, whatever its settings say.
    const fresh = await authorLifecycleDraft(
      {
        ctx: agent,
        input: { scope: { connectionId: CONNECTION_ID }, mode: "graph", ...journey.draft, settings: { ...journey.draft.settings, emailStyle: NAVY } },
        brief: "",
      },
      { db },
    );
    if (!fresh.ok) throw new Error(fresh.error);
    expect((db.raw("lifecycle_journeys", fresh.id) as { draft: { settings: object } }).draft.settings).not.toHaveProperty("emailStyle");
  });

  it("returns structured problems for a malformed graph, and saves an incomplete one with its issues", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const bad = await authorLifecycleDraft(
      { ctx: agent, input: { scope: { connectionId: CONNECTION_ID }, mode: "graph", graph: { nodes: [{ id: "x" }], edges: [] } }, brief: "" },
      { db },
    );
    expect(bad).toMatchObject({ ok: false, status: 422, error: "invalid_graph" });
    expect((bad as { issues: string[] }).issues.length).toBeGreaterThan(0);

    const incomplete = await authorLifecycleDraft(
      {
        ctx: agent,
        input: {
          scope: { connectionId: CONNECTION_ID },
          mode: "graph",
          graph: {
            nodes: [
              { id: "t", type: "trigger", position: { x: 0, y: 0 } },
              { id: "c", type: "condition", position: { x: 1, y: 0 }, data: { branches: [{ id: "b", conditions: [{ field: "trait.nope", operator: "eq", value: "x" }] }] } },
            ],
            edges: [{ id: "e1", source: "t", target: "c" }],
          },
        },
        brief: "",
      },
      { db },
    );
    if (!incomplete.ok) throw new Error(incomplete.error);
    expect(incomplete.warnings.join(" ")).toMatch(/unknown_field/);
    expect(incomplete.warnings.join(" ")).toMatch(/condition_missing_default_edge/);
    expect(incomplete.card.warnings).toBeGreaterThan(0);
  });

  it("only sees its own tenant, and is off unless the flags are on", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const other: TenantContext = { ...agent, tenantId: "ten_other" };
    expect(await authorLifecycleDraft({ ctx: other, input: { scope: { connectionId: CONNECTION_ID } }, brief: "" }, { db, generate })).toMatchObject({
      ok: false,
      status: 404,
      error: "connection_not_found",
    });
    delete process.env.LIFECYCLE_CHAT_AUTHORING_ENABLED;
    expect(await authorLifecycleDraft({ ctx: agent, input: { scope: { connectionId: CONNECTION_ID } }, brief: "" }, { db, generate })).toMatchObject({
      ok: false,
      status: 503,
      error: "unavailable",
    });
  });
});

describe("a journey that continues from another (journey links)", () => {
  it("drafts the sequence that follows a journey, and says when it starts and where its emails land", async () => {
    process.env.LIFECYCLE_JOURNEY_LINKS_ENABLED = "true";
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey: first } = await publishOnboarding(db);
    const r = await authorLifecycleDraft(
      { ctx: agent, input: { scope: { connectionId: CONNECTION_ID }, mode: "template", afterJourneyId: first.id, options: { emails: 3 } }, brief: "Useful and short" },
      { db, generate },
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.card.title).toBe("After Onboarding");
    expect(r.card.stats).toEqual([{ label: "emails", value: 3 }, { label: "splits", value: 0 }, { label: "waits", value: 3 }]);
    expect(r.summary).toContain('It starts when someone finishes "Onboarding", which sends 5 emails over about');
    expect(r.summary).toMatch(/Its 3 emails then go out about 3, \d+ and \d+ days after that/);
    expect(r.summary).toContain("nothing sends until you do");
    const saved = (await forTenant(system, db).lifecycleJourneys.getById(r.id))!;
    expect(saved).toMatchObject({ status: "draft", authoredBy: "agent", publishedVersion: null });
    expect(saved.draft.settings.trigger).toMatchObject({ event: JOURNEY_COMPLETED_EVENT, afterJourneyId: first.id });
    // The journey it follows is untouched.
    expect((await forTenant(system, db).lifecycleJourneys.getById(first.id))!.publishedVersion).toBe(1);

    // A rebuild keeps it continuing from that journey without being told again.
    __resetRateLimitState();
    const again = await authorLifecycleDraft(
      { ctx: agent, input: { scope: { connectionId: CONNECTION_ID, journeyId: r.id }, mode: "template", options: { emails: 2 } }, brief: "Shorter" },
      { db, generate },
    );
    if (!again.ok) throw new Error(again.error);
    const rebuilt = (await forTenant(system, db).lifecycleJourneys.getById(r.id))!;
    expect(rebuilt.draft.pools[0]!.items).toHaveLength(2);
    expect(rebuilt.draft.settings.trigger.afterJourneyId).toBe(first.id);
  });

  it("a custom structure can continue from a journey too, and is told when a wait will land a day late", async () => {
    process.env.LIFECYCLE_JOURNEY_LINKS_ENABLED = "true";
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey: first } = await publishOnboarding(db);
    const graph = {
      nodes: [
        { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
        { id: "wait_a", type: "wait", position: { x: 1, y: 0 }, data: { wait: { minHours: 72 } } },
        { id: "email_a", type: "email", position: { x: 2, y: 0 }, data: { poolId: "tips" } },
        { id: "exit", type: "exit", position: { x: 3, y: 0 }, data: {} },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "wait_a" },
        { id: "e2", source: "wait_a", target: "email_a" },
        { id: "e3", source: "email_a", target: "exit" },
      ],
    };
    const pools = [{ id: "tips", label: "Tips", items: [{ id: "t1", label: "T1", subject: "A tip", body: "<p>Hi</p>" }] }];
    const r = await authorLifecycleDraft(
      { ctx: agent, input: { scope: { connectionId: CONNECTION_ID }, mode: "graph", afterJourneyId: first.id, graph, pools, name: "Tips" }, brief: "tips after onboarding" },
      { db },
    );
    if (!r.ok) throw new Error(r.error);
    const saved = (await forTenant(system, db).lifecycleJourneys.getById(r.id))!;
    expect(saved.draft.settings.trigger).toMatchObject({ event: JOURNEY_COMPLETED_EVENT, afterJourneyId: first.id });
    expect(r.warnings).toEqual([expect.stringContaining('wait_a waits 72 hours, which reaches the send window a day later than 3 days — use "minHours": 64')]);

    const fine = { ...saved.draft, graph: { ...saved.draft.graph, nodes: saved.draft.graph.nodes.map((n) => (n.id === "wait_a" ? { ...n, data: { wait: { minHours: 64, differentLocalDay: true } } } : n)) } };
    expect(wholeDayWaitNotes(fine as LifecycleDraft)).toEqual([]);
  });

  it("refuses a journey that isn't this product's, and all of it while journey links are off", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey: first } = await publishOnboarding(db);
    const input = { scope: { connectionId: CONNECTION_ID }, mode: "template", afterJourneyId: first.id, options: { writeCopy: false } };
    expect(await authorLifecycleDraft({ ctx: agent, input, brief: "" }, { db })).toMatchObject({ ok: false, status: 409, error: "journey_links_unavailable" });
    process.env.LIFECYCLE_JOURNEY_LINKS_ENABLED = "true";
    expect(await authorLifecycleDraft({ ctx: agent, input: { ...input, afterJourneyId: "lcj_nope" }, brief: "" }, { db })).toMatchObject({
      ok: false,
      status: 404,
      error: "after_journey_not_found",
    });
  });

  it("the agent reads each journey's timeline and what it continues from, only while it's on", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey: first } = await publishOnboarding(db);
    type Ctx = { journeyLinks?: unknown; journeys: Array<{ id: string; continuesFrom?: unknown; timeline?: { summary: string; emails: number; sendTime: string } }> };
    const off = (await agentLifecycleContext(agent, db)).body as Ctx;
    expect(off.journeyLinks).toBeUndefined();
    expect(off.journeys[0]).not.toHaveProperty("timeline");

    process.env.LIFECYCLE_JOURNEY_LINKS_ENABLED = "true";
    const on = (await agentLifecycleContext(agent, db)).body as Ctx;
    expect(on.journeyLinks).toEqual({ enabled: true });
    expect(on.journeys[0]).toMatchObject({ id: first.id, continuesFrom: null, timeline: { emails: 5, sendTime: "09:00" } });
    expect(on.journeys[0]!.timeline!.summary).toMatch(/^5 emails over about/);
    const one = (await agentLifecycleJourney(agent, first.id, db)).body as { journey: { timeline: { emailDays: Array<{ day: number }> } } };
    expect(one.journey.timeline.emailDays.map((s) => s.day)).toEqual([1, 2, 4, 8, 10]);
  });
});

describe("agent read endpoints", () => {
  it("context: catalogs, aggregate stats and journeys — no people", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedUser(db, "alex", { steps: { create_brand: { doneAt: "2026-09-21T09:00:00.000Z" } } });
    seedUser(db, "bea");
    await publishOnboarding(db);
    const r = await agentLifecycleContext(agent, db);
    expect(r.status).toBe(200);
    const body = r.body as { connections: Array<{ stats: { users: number; steps: Array<{ id: string; completedShare: number | null; medianHoursToComplete: number | null }> } }> };
    expect(body.connections[0]!.stats.users).toBe(2);
    expect(body.connections[0]!.stats.steps[0]).toMatchObject({ id: "create_brand", completedShare: 0.5, medianHoursToComplete: 2 });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("@customer.test");
    expect(text).not.toContain("alex");
    expect(text).toContain("verifiedSendingDomains");
  });

  it("context: says whether an Email style is saved, and only while the flag is on", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const tenant = db.raw("tenants", adminCtx.tenantId)!;
    db.seed("tenants", adminCtx.tenantId, {
      ...tenant,
      emailStyle: { logo: null, companyName: null, headerColor: "#0b1f3a", accentColor: "#ff6b35" },
    });
    expect((await agentLifecycleContext(agent, db)).body).not.toHaveProperty("emailStyle");
    process.env.EMAIL_STYLE_ENABLED = "true";
    expect((await agentLifecycleContext(agent, db)).body).toMatchObject({ emailStyle: { configured: true } });
    db.seed("tenants", adminCtx.tenantId, tenant);
    expect((await agentLifecycleContext(agent, db)).body).toMatchObject({ emailStyle: { configured: false } });
  });

  it("journey: the draft without test recipients or the shadow inbox", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const { journey } = await publishOnboarding(db, { testUserIds: ["alex"], shadowInbox: "jez@sandbox.test" });
    const r = await agentLifecycleJourney(agent, journey.id, db);
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("testRecipients");
    expect(text).not.toContain("shadowInbox");
    expect((r.body as { journey: { draft: { pools: unknown[] } } }).journey.draft.pools.length).toBe(5);
    expect((await agentLifecycleJourney({ ...agent, tenantId: "ten_other" }, journey.id, db)).status).toBe(404);
  });
});
