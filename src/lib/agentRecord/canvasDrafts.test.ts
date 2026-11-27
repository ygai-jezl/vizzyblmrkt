import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant")>();
  return { ...actual, getTenantById: vi.fn(async () => null) };
});

import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant/types";
import { CONNECTION_ID, ctx as lifecycleAdmin, seedWorld } from "@/lib/lifecycle/testing/fixtures";
import { publishJourney, saveDraft, setJourneyStatus } from "@/lib/lifecycle/adminApi";
import { publishLifecycleJourney } from "@/lib/lifecycle/service";
import { authorLifecycleDraft } from "@/lib/canvas/kinds/lifecycle";
import { authorInviteWaveDraft } from "@/lib/canvas/kinds/inviteWave";
import { authorImageStyleSuggestion } from "@/lib/canvas/kinds/imageStyle";
import { authorBrandMapSuggestions } from "@/lib/canvas/kinds/brandMap";
import { ctx as invitesAdmin, seedConnection, seedLaunch, seedSignup } from "@/lib/invites/testing/fixtures";
import { removeWave, sendWave } from "@/lib/invites/adminApi";
import type { AgentAction } from "@/lib/types/agentAction";
import type { ContentPlan } from "@/lib/types/contentPlan";
import { closePlanDraft, planRef, recordJourneyDraft, recordPlanDraft } from "./drafts";
import { closeStyle, openRecordsFor } from "./record";
import { imageStylePrint } from "./fingerprints";

/** What the canvas route hands a kind with LOOPS_ENABLED off: no stamp (src/lib/agentRecord/loopsCount.test.ts counts with one). */
const LOOPS_OFF = { unstamped: "loops_off" } as const;

const generate = async () => JSON.stringify({ subject: "Hi {{user.first_name|there}}", previewText: "Quick note", body: "<p>Hello {{user.first_name|there}}</p>" });

async function records(db: FakeFirestore, ctx: TenantContext): Promise<AgentAction[]> {
  return (await forTenant(ctx, db).agentActions.find({ limit: 100 })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.rev - b.rev);
}

beforeEach(() => {
  __resetRateLimitState();
  vi.stubEnv("AGENT_RECORD_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("a lifecycle journey Vizzy drafts", () => {
  const agent: TenantContext = { ...lifecycleAdmin, source: "agent", userId: "usr_1" };
  const draftIt = (db: FakeFirestore, input: Record<string, unknown> = {}) =>
    authorLifecycleDraft({ ctx: agent, input: { scope: { connectionId: CONNECTION_ID }, mode: "template", options: { reminders: 2 }, ...input }, made: LOOPS_OFF, brief: "Warm" }, { db, generate });

  beforeEach(() => {
    vi.stubEnv("LIFECYCLE_ENABLED", "true");
    vi.stubEnv("LIFECYCLE_CHAT_AUTHORING_ENABLED", "true");
  });

  it("is recorded with the member who asked, and kept unedited when published as it was", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const r = await draftIt(db);
    if (!r.ok) throw new Error(r.error);
    const [open] = await records(db, agent);
    expect(open).toMatchObject({
      action: "lifecycle_journey.draft",
      state: "proposed",
      draft: { kind: "lifecycle_journey", ref: r.id },
      requestedBy: { type: "member", id: "usr_1" },
      review: { kind: "agent_draft", href: `/admin/lifecycle/${r.id}` },
      proposal: { label: "Sandbox onboarding", fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) },
    });
    const published = await publishJourney(lifecycleAdmin, r.id, undefined, db);
    expect(published.status).toBe(200);
    expect((await records(db, agent))[0]).toMatchObject({ state: "acted", actedBy: { type: "member", id: "usr_1" }, result: { edited: false } });
  });

  it("is kept after a person's edits when they changed an email first", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const r = await draftIt(db);
    if (!r.ok) throw new Error(r.error);
    const journey = await forTenant(lifecycleAdmin, db).lifecycleJourneys.getById(r.id);
    const draft = structuredClone(journey!.draft);
    draft.pools[0]!.items[0]!.subject = "Welcome to the shop";
    expect((await saveDraft(lifecycleAdmin, r.id, draft, db)).status).toBe(200);
    await publishJourney(lifecycleAdmin, r.id, undefined, db);
    expect((await records(db, agent))[0]).toMatchObject({ state: "acted", result: { edited: true } });
  });

  it("records nothing when the engine itself publishes, and is dismissed when archived", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const r = await draftIt(db);
    if (!r.ok) throw new Error(r.error);
    await publishLifecycleJourney(lifecycleAdmin, r.id, { db });
    expect((await records(db, agent))[0]!.state).toBe("proposed");
    expect((await setJourneyStatus(lifecycleAdmin, r.id, { status: "archived" }, db)).status).toBe(200);
    expect((await records(db, agent))[0]).toMatchObject({ state: "declined", declined: { reason: "dismissed" }, decidedBy: { type: "member", id: "usr_1" } });
  });

  it("stays one draft when Vizzy then styles it, keeping its first action", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const r = await draftIt(db);
    if (!r.ok) throw new Error(r.error);
    const journey = await forTenant(lifecycleAdmin, db).lifecycleJourneys.getById(r.id);
    const styled = structuredClone(journey!);
    (styled.draft.settings as Record<string, unknown>).emailStyle = { headerColor: "#225533", accentColor: "#aa3300" };
    expect((await recordJourneyDraft(agent, "journey_style.suggest", styled, { db })).outcome).toBe("recorded");
    const open = await openRecordsFor(agent, { kind: "lifecycle_journey", ref: r.id }, db);
    expect(open).toHaveLength(1);
    expect(open[0]!.action).toBe("lifecycle_journey.draft");
    expect((await records(db, agent)).map((a) => a.state).sort()).toEqual(["declined", "proposed"]);
  });

  it("records nothing new while the switch is off", async () => {
    vi.stubEnv("AGENT_RECORD_ENABLED", "false");
    const db = new FakeFirestore();
    seedWorld(db);
    const r = await draftIt(db);
    expect(r.ok).toBe(true);
    expect(await records(db, agent)).toEqual([]);
  });
});

describe("an invite wave Vizzy drafts", () => {
  const write = vi.fn(async () => ({ subject: "You're in", body: "Hi {{first_name}}, it is ready for you." }));
  const world = () => {
    const db = new FakeFirestore();
    seedLaunch(db);
    seedSignup(db, "s1");
    seedSignup(db, "s2");
    seedConnection(db);
    return db;
  };
  beforeEach(() => {
    vi.stubEnv("INVITES_ENABLED", "true");
    vi.stubEnv("EMAIL_LINK_ORIGIN", "https://yougrow.test");
  });

  it("is recorded about its launch, and kept by the admin who sends it", async () => {
    const db = world();
    const r = await authorInviteWaveDraft({ ctx: invitesAdmin, input: { scope: { campaignId: "beta" }, size: 2 }, made: LOOPS_OFF, brief: "Short" }, { db, write });
    if (!r.ok) throw new Error(r.error);
    const [open] = await records(db, invitesAdmin);
    expect(open).toMatchObject({ action: "invite_wave.draft", target: { type: "idea", id: "beta" }, draft: { kind: "invite_wave", ref: r.id } });
    const sent = await sendWave(invitesAdmin, "beta", r.id, { db, kick: async () => undefined });
    expect(sent.status).toBe(200);
    expect((await records(db, invitesAdmin))[0]).toMatchObject({ state: "acted", actedBy: { type: "member", id: "u_admin" }, result: { edited: false } });
  });

  it("is dismissed when deleted unsent", async () => {
    const db = world();
    const r = await authorInviteWaveDraft({ ctx: invitesAdmin, input: { scope: { campaignId: "beta" }, size: 2 }, made: LOOPS_OFF, brief: "Short" }, { db, write });
    if (!r.ok) throw new Error(r.error);
    expect((await removeWave(invitesAdmin, "beta", r.id, db)).status).toBe(200);
    expect((await records(db, invitesAdmin))[0]).toMatchObject({ state: "declined", declined: { reason: "dismissed" } });
  });
});

describe("a content plan an agent drafts", () => {
  const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_a", role: "admin" };
  const plan = (status: string, hub: string, body = "Care tips for new plant owners"): ContentPlan =>
    ({
      id: "pl_1",
      name: "Care tips",
      status,
      authoredBy: "agent",
      graph: { nodes: [{ id: "hub", type: "hub", role: "Hub: Blog", status: hub, body }], edges: [] },
    }) as unknown as ContentPlan;

  it("is kept when a save approves a piece, edited when its words changed", async () => {
    const db = new FakeFirestore();
    expect(await recordPlanDraft(A, "ws1", plan("ready", "generated"), "vizzy", { db })).toBe("recorded");
    expect(await closePlanDraft(A, "ws1", plan("ready", "generated"), plan("ready", "generated", "Changed"), { db })).toBe(0);
    expect(await closePlanDraft(A, "ws1", plan("ready", "generated"), plan("ready", "approved", "Care tips, edited"), { db })).toBe(1);
    expect((await records(db, A))[0]).toMatchObject({ state: "acted", draft: { kind: "content_plan", ref: planRef("ws1", "pl_1") }, result: { edited: true } });
  });

  it("is dismissed when archived or deleted, and a person's own plan is never recorded", async () => {
    const db = new FakeFirestore();
    await recordPlanDraft(A, "ws1", plan("ready", "generated"), "vizzy", { db });
    await closePlanDraft(A, "ws1", plan("ready", "generated"), plan("archived", "generated"), { db });
    expect((await records(db, A))[0]).toMatchObject({ state: "declined", declined: { reason: "dismissed" } });
    expect(await recordPlanDraft(A, "ws1", { ...plan("ready", "generated"), authoredBy: "human" } as ContentPlan, "vizzy", { db })).toBe("same");
    expect(await records(db, A)).toHaveLength(1);
  });

  it("is the autopilot's, asked for by the system, when the autopilot finishes it", async () => {
    const db = new FakeFirestore();
    await recordPlanDraft(A, "ws1", plan("ready", "generated"), "autopilot", { db });
    expect((await records(db, A))[0]).toMatchObject({ agent: "autopilot", action: "autopilot.draft", requestedBy: { type: "system", id: "autopilot" } });
  });
});

describe("an image style Vizzy suggests", () => {
  const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_admin", role: "admin" };
  const world = () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_A", {
      id: "ten_A",
      tenantName: "Example Co",
      rootDomain: "example.com",
      status: "active",
      region: "us",
      allowedOrigins: ["https://example.com"],
      billingTier: "mvp_free",
      ownerId: "usr_owner",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    return db;
  };
  beforeEach(() => vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true"));

  it("is superseded by a newer suggestion, and the newer one is applied unedited from its suggestedAt", async () => {
    const db = world();
    const suggest = (id: string) => authorImageStyleSuggestion({ ctx: admin, input: { defaultStyleId: id, reason: "Fits the shop" }, made: LOOPS_OFF, brief: "" }, { db });
    expect((await suggest("headline_card")).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect((await suggest("natural_photo")).ok).toBe(true);
    const rows = await records(db, admin);
    expect(rows.map((a) => [a.state, a.declined?.reason ?? null])).toEqual([
      ["declined", "superseded"],
      ["proposed", null],
    ]);
    const tenant = db.raw("tenants", "ten_A") as { imageStyleSuggestion: { suggestedAt: string } };
    const applied = await closeStyle(admin, "image_style.suggest", tenant.imageStyleSuggestion.suggestedAt, {
      to: "acted",
      by: { type: "member", id: "usr_admin" },
      fingerprint: imageStylePrint({ defaultStyleId: "natural_photo" }),
    }, { db });
    expect(applied).toBe(true);
    expect((await records(db, admin))[1]).toMatchObject({ state: "acted", result: { edited: false } });
  });
});

describe("brand map suggestions from chat", () => {
  const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_admin", role: "admin" };
  beforeEach(() => {
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_CHAT_ENABLED", "true");
  });

  it("are one record per call, holding hashes of the keys it filed, never the words", async () => {
    const db = new FakeFirestore();
    const r = await authorBrandMapSuggestions(
      { ctx: admin, input: { mode: "add", changes: [{ type: "add_name", name: "Rivalco", kind: "alternative" }, { type: "add_avoid", term: "cheap" }] }, made: LOOPS_OFF, brief: "Add those" },
      { db, nowMs: Date.parse("2026-12-01T10:00:00Z") },
    );
    expect(r.ok).toBe(true);
    const [run] = await records(db, admin);
    expect(run).toMatchObject({ action: "brand_map.suggest", draft: { kind: "brand_map" }, review: { kind: "brand_map", href: "/admin/brand-kit/map" } });
    const keys = run!.proposal!.keys as string[];
    expect(keys).toHaveLength(2);
    expect(JSON.stringify(run!.proposal)).not.toMatch(/Rivalco|cheap/i);
  });
});
