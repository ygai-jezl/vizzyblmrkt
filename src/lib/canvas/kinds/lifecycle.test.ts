import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { CONNECTION_ID, ctx as adminCtx, publishOnboarding, seedWorld, system } from "@/lib/lifecycle/testing/fixtures";
import { agentLifecycleContext, agentLifecycleJourney } from "@/lib/lifecycle/agentApi";
import { seedUser } from "@/lib/lifecycle/testing/fixtures";
import { authorLifecycleDraft } from "./lifecycle";

const agent: TenantContext = { tenantId: adminCtx.tenantId, region: "eu", userId: "usr_1", role: "admin", source: "agent" };
const generate = async () =>
  JSON.stringify({ subject: "Hi {{user.first_name|there}}", previewText: "Quick note", body: "<p>Hello {{user.first_name|there}}</p>" });

beforeEach(() => {
  process.env.LIFECYCLE_ENABLED = "true";
  process.env.LIFECYCLE_CHAT_AUTHORING_ENABLED = "true";
});
afterEach(() => {
  delete process.env.LIFECYCLE_ENABLED;
  delete process.env.LIFECYCLE_CHAT_AUTHORING_ENABLED;
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
