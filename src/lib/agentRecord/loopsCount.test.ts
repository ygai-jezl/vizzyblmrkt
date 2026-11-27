import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// The launch journey canvas reads and writes with no injected database: every repository, 0e
// writer and count falls back to this test's fake one. Every other test here passes its own.
let fake = new FakeFirestore();
vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant")>();
  return {
    ...actual,
    getTenantById: vi.fn(async () => null),
    forTenant: (ctx: Parameters<typeof actual.forTenant>[0], db?: Parameters<typeof actual.forTenant>[1]) => actual.forTenant(ctx, db ?? fake),
    proposeAgentAction: (ctx: Parameters<typeof actual.proposeAgentAction>[0], p: Parameters<typeof actual.proposeAgentAction>[1], opts: { db?: FakeFirestore } = {}) =>
      actual.proposeAgentAction(ctx, p, { db: opts.db ?? fake }),
    transitionAgentAction: (ctx: Parameters<typeof actual.transitionAgentAction>[0], id: string, t: Parameters<typeof actual.transitionAgentAction>[2], opts: { db?: FakeFirestore } = {}) =>
      actual.transitionAgentAction(ctx, id as never, t, { db: opts.db ?? fake }),
  };
});
vi.mock("@/lib/tenant/loops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant/loops")>();
  return { ...actual, addToLoopDay: (...[ctx, id, tree, opts, db]: Parameters<typeof actual.addToLoopDay>) => actual.addToLoopDay(ctx, id, tree, opts, db ?? fake) };
});
vi.mock("@/lib/agents/creative", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/creative")>();
  return { ...actual, draftCopy: vi.fn(async () => ({ variants: [{ subject: "Welcome aboard", body: "Hi {{first_name}}" }], source: "agent3" })) };
});
vi.mock("@/lib/content/create/activeBrandVoice", () => ({ activeBrandVoiceText: vi.fn(async () => null) }));

import { forTenant } from "@/lib/tenant";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant/types";
import { CONNECTION_ID, ctx as lifecycleAdmin, seedWorld } from "@/lib/lifecycle/testing/fixtures";
import { publishJourney, saveDraft, setJourneyStatus } from "@/lib/lifecycle/adminApi";
import { publishLifecycleJourney } from "@/lib/lifecycle/service";
import { authorLifecycleDraft } from "@/lib/canvas/kinds/lifecycle";
import { authorInviteWaveDraft } from "@/lib/canvas/kinds/inviteWave";
import { authorImageStyleSuggestion } from "@/lib/canvas/kinds/imageStyle";
import { authorJourneyStyle } from "@/lib/canvas/kinds/journeyStyle";
import { ctx as invitesAdmin, seedConnection, seedLaunch, seedSignup } from "@/lib/invites/testing/fixtures";
import { removeWave, sendWave } from "@/lib/invites/adminApi";
import { createWave } from "@/lib/invites/adminApi";
import { createLifecycleJourney } from "@/lib/lifecycle/service";
import { journeyCanvasKind } from "@/lib/canvas/kinds/journey";
import { authorContentPlanDraft } from "@/lib/canvas/kinds/contentPlan";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import type { ContentGraph, ContentNode } from "@/lib/types/contentPlan";
import { countCanvasMade } from "@/lib/canvas/made";
import type { CanvasKindName } from "@/lib/canvas/names";
import type { CanvasAuthorOutcome } from "@/lib/canvas/types";
import { CAMPAIGN_ID, publishWaitlist, seedLaunch as seedWaitlistLaunch } from "@/lib/lifecycle/waitlist/testing/fixtures";
import { agentSuggestNotes } from "@/lib/brandNotes/agentApi";
import { removeFromRequest, updateFromRequest } from "@/lib/brandNotes/api";
import { loopWeekOf } from "@/lib/loops/count";
import { learnedFor } from "@/lib/loops/read";
import type { LoopKind } from "@/lib/loops/registry";
import { sumWeek } from "@/lib/loops/testing/sumWeek";
import type { AgentAction } from "@/lib/types/agentAction";
import type { LoopStamp } from "@/lib/types/loopStamp";
import { catchUpBrand } from "./catchUp";
import { imageStylePrint } from "./fingerprints";
import { closePlanDraft } from "./drafts";
import { closeStyle, openRecordsFor, stampOf } from "./record";
import { lineFor, SOURCES, type SourceLine } from "./sources";

/**
 * The agent record (ADR-0026) beside learning loops step 5 (ADR-0029): a draft whose outcome the
 * loops count where its record closes (`countsAt: "transition"`) keeps Vizzy's stamp on its
 * record, so the person's answer counts once, through transitionAgentAction; a draft counted at
 * its own path keeps none, so closing its record never counts it a second time. Made counts
 * stay the canvas route's, once per new draft. Made up brands only.
 */

const generate = async () => JSON.stringify({ subject: "Hi {{user.first_name|there}}", previewText: "Quick note", body: "<p>Hello {{user.first_name|there}}</p>" });
const week = () => loopWeekOf(new Date());

/** The stamp the canvas route hands a kind (learnedFor with by: vizzy), with LOOPS_ENABLED on. */
async function vizzyStamp(ctx: TenantContext, kind: LoopKind): Promise<LoopStamp> {
  const { stamp } = await learnedFor(ctx, kind, { by: "vizzy" });
  if ("unstamped" in stamp) throw new Error(`no stamp: ${stamp.unstamped}`);
  return stamp;
}

/**
 * A canvas save with its made counted exactly as the canvas route counts it (countCanvasMade), so
 * a test can see made never outrun the answers.
 */
async function viaRoute(kind: CanvasKindName, ctx: TenantContext, save: (made: LoopStamp) => Promise<CanvasAuthorOutcome>, db?: FakeFirestore) {
  const made = await vizzyStamp(ctx, `canvas.${kind}`);
  const r = await save(made);
  if (!r.ok) throw new Error(r.error);
  await countCanvasMade(ctx, kind, r.saved, made, { db });
  return r;
}

/** A brand's counts for one kind this week, at version 0 and arm none (made only where a test counts it through viaRoute). */
function answers(db: FakeFirestore, tenantId: string, kind: string): Record<string, number> {
  const tree = sumWeek(db, tenantId, week()) as { c?: Record<string, Record<string, Record<string, Record<string, Record<string, number>>>>> };
  return tree.c?.[kind]?.[kind]?.v0?.none ?? {};
}

async function records(db: FakeFirestore, ctx: TenantContext): Promise<AgentAction[]> {
  return (await forTenant(ctx, db).agentActions.find({ limit: 100 })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.rev - b.rev);
}

beforeEach(() => {
  __resetRateLimitState();
  fake = new FakeFirestore();
  vi.stubEnv("AGENT_RECORD_ENABLED", "true");
  vi.stubEnv("LOOPS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("which stamp a record keeps (stampOf)", () => {
  const at = "2026-11-27T10:00:00.000Z";
  const stamp = (kind: LoopKind, made = `${kind}.0.n`): LoopStamp =>
    ({ made, kind, scope: kind, v: 0, arm: "none", items: [], prompt: null, tokens: { rules: 0, examples: 0 }, by: "vizzy", at }) as LoopStamp;
  const open = (made?: LoopStamp) => ({ made }) as AgentAction;
  const transition = { countsAt: "transition" } as const;

  it("keeps none for a line counted at its own path, so closing its record counts nothing", () => {
    for (const l of (SOURCES as readonly SourceLine[]).filter((s) => s.countsAt === "own_path")) {
      expect(stampOf(l, stamp(l.loop), undefined), l.key).toBeUndefined();
    }
  });

  it("takes the newest save's stamp of the same kind, and keeps the draft's own when a save of another kind lands on it", () => {
    const first = stamp("canvas.lifecycle");
    const again = { ...stamp("canvas.lifecycle"), at: "2026-11-28T10:00:00.000Z" };
    expect(stampOf(transition, first, undefined)).toBe(first);
    expect(stampOf(transition, again, open(first))).toBe(again);
    expect(stampOf(transition, stamp("canvas.journey_style"), open(first))).toBe(first);
    // No stamp on the save (LOOPS_ENABLED was off when it was made): the draft's own stays.
    expect(stampOf(transition, { unstamped: "loops_off" }, open(first))).toBe(first);
    expect(stampOf(transition, { unstamped: "loops_off" }, open())).toBeUndefined();
  });

  it("names every transition line the tests below count", () => {
    expect((SOURCES as readonly SourceLine[]).filter((s) => s.countsAt === "transition").map((s) => s.action).sort()).toEqual([
      "brand_note.suggest",
      "email_style.suggest",
      "image_style.suggest",
      "journey_style.suggest",
      "launch_journey.draft",
      "lifecycle_journey.draft",
      "product_map.learn",
    ]);
    expect(lineFor("invite_wave.draft")?.countsAt).toBe("own_path");
  });
});

describe("a lifecycle journey Vizzy drafts, counted where its record closes", () => {
  const agent: TenantContext = { ...lifecycleAdmin, source: "agent", userId: "usr_1" };
  const draftIt = async (db: FakeFirestore, reminders = 2, journeyId?: string) =>
    authorLifecycleDraft(
      { ctx: agent, input: { scope: { connectionId: CONNECTION_ID, journeyId }, mode: "template", options: { reminders } }, made: await vizzyStamp(agent, "canvas.lifecycle"), brief: "Warm" },
      { db, generate },
    );
  /** The same draft through the canvas route's made count. */
  const draftViaRoute = (db: FakeFirestore, reminders = 2, journeyId?: string) =>
    viaRoute(
      "lifecycle",
      agent,
      (made) => authorLifecycleDraft({ ctx: agent, input: { scope: { connectionId: CONNECTION_ID, journeyId }, mode: "template", options: { reminders } }, made, brief: "Warm" }, { db, generate }),
      db,
    );
  const styleViaRoute = (db: FakeFirestore, journeyId: string) => {
    vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
    vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
    return viaRoute(
      "journey_style",
      agent,
      (made) => authorJourneyStyle({ ctx: { ...agent, role: "admin" }, input: { journeyId, mode: "custom", headerColor: "#225533", buttonColor: "#aa3300" }, made, brief: "green header" }, { db }),
      db,
    );
  };

  beforeEach(() => {
    vi.stubEnv("LIFECYCLE_ENABLED", "true");
    vi.stubEnv("LIFECYCLE_CHAT_AUTHORING_ENABLED", "true");
  });

  it("keeps Vizzy's stamp on the record and counts publishing it kept once", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const r = await draftIt(db);
    if (!r.ok) throw new Error(r.error);
    const [open] = await records(db, agent);
    expect(open!.made).toMatchObject({ kind: "canvas.lifecycle", by: "vizzy" });
    expect((await publishJourney(lifecycleAdmin, r.id, undefined, db)).status).toBe(200);
    expect(answers(db, agent.tenantId, "canvas.lifecycle")).toEqual({ kept: 1 });
    // The catch-up finds nothing open, so it counts nothing more.
    await catchUpBrand(agent, { deadlineMs: Date.now() + 10_000, db });
    expect(answers(db, agent.tenantId, "canvas.lifecycle")).toEqual({ kept: 1 });
  });

  it("counts edited when a person changed an email first, and dismissed once when archived", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const r = await draftIt(db);
    if (!r.ok) throw new Error(r.error);
    const journey = await forTenant(lifecycleAdmin, db).lifecycleJourneys.getById(r.id);
    const draft = structuredClone(journey!.draft);
    draft.pools[0]!.items[0]!.subject = "Welcome to the shop";
    expect((await saveDraft(lifecycleAdmin, r.id, draft, db)).status).toBe(200);
    await publishJourney(lifecycleAdmin, r.id, undefined, db);
    expect(answers(db, agent.tenantId, "canvas.lifecycle")).toEqual({ edited: 1 });

    const other = new FakeFirestore();
    seedWorld(other);
    const d = await draftIt(other);
    if (!d.ok) throw new Error(d.error);
    expect((await setJourneyStatus(lifecycleAdmin, d.id, { status: "archived" }, other)).status).toBe(200);
    expect(answers(other, agent.tenantId, "canvas.lifecycle")).toEqual({ declined: 1 });
  });

  it("counts made once and one answer when Vizzy rewrote it first: the record it superseded counts nothing", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const r = await draftViaRoute(db, 2);
    expect(r.saved).toBe("created");
    const again = await draftViaRoute(db, 1, r.id);
    expect(again).toMatchObject({ id: r.id, saved: "rewritten" });
    expect((await records(db, agent)).map((a) => `${a.state}:${a.declined?.reason ?? ""}`).sort()).toEqual(["declined:superseded", "proposed:"]);
    await publishJourney(lifecycleAdmin, r.id, undefined, db);
    expect(answers(db, agent.tenantId, "canvas.lifecycle")).toEqual({ made: 1, kept: 1 });
  });

  it("counts a new draft after a person published the first as made again, so each answer has its made", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const r = await draftViaRoute(db, 2);
    await publishJourney(lifecycleAdmin, r.id, undefined, db);
    // The first record is closed: the redraft opens a new one, a new thing to answer.
    const again = await draftViaRoute(db, 1, r.id);
    expect(again).toMatchObject({ id: r.id, saved: "created" });
    await publishJourney(lifecycleAdmin, r.id, undefined, db);
    expect(answers(db, agent.tenantId, "canvas.lifecycle")).toEqual({ made: 2, kept: 2 });
  });

  it("counts Vizzy's first draft of a journey a person built as made once", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const mine = await createLifecycleJourney(lifecycleAdmin, { name: "Hearth onboarding", connectionId: CONNECTION_ID, template: "product_onboarding" }, { db, authoredBy: "human" });
    if (!mine.ok) throw new Error(String(mine.error));
    const r = await draftViaRoute(db, 2, mine.value.journey.id);
    expect(r).toMatchObject({ id: mine.value.journey.id, saved: "created" });
    await publishJourney(lifecycleAdmin, r.id, undefined, db);
    expect(answers(db, agent.tenantId, "canvas.lifecycle")).toEqual({ made: 1, kept: 1 });
  });

  it("a style Vizzy then suggests stays one draft, its answer and its one made counted under the journey Vizzy drafted", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const r = await draftViaRoute(db);
    const styled = await styleViaRoute(db, r.id);
    // The journey's made already waits for this draft's answer: the style counts no made of its own.
    expect(styled).toMatchObject({ ok: true, saved: "rewritten" });
    const [open] = await openRecordsFor(agent, { kind: "lifecycle_journey", ref: r.id }, db);
    expect(open).toMatchObject({ action: "lifecycle_journey.draft", made: { kind: "canvas.lifecycle" } });
    await publishJourney(lifecycleAdmin, r.id, undefined, db);
    expect(answers(db, agent.tenantId, "canvas.lifecycle")).toEqual({ made: 1, kept: 1 });
    expect(answers(db, agent.tenantId, "canvas.journey_style")).toEqual({});
  });

  it("counts a style on a person's own journey made once, and its answer under the style", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const mine = await createLifecycleJourney(lifecycleAdmin, { name: "Hearth onboarding", connectionId: CONNECTION_ID, template: "product_onboarding" }, { db, authoredBy: "human" });
    if (!mine.ok) throw new Error(String(mine.error));
    const styled = await styleViaRoute(db, mine.value.journey.id);
    expect(styled).toMatchObject({ ok: true, saved: "created" });
    // Styled again before anyone answers: the same draft, already counted.
    expect(await styleViaRoute(db, mine.value.journey.id)).toMatchObject({ ok: true, saved: "rewritten" });
    await publishJourney(lifecycleAdmin, mine.value.journey.id, undefined, db);
    expect(answers(db, agent.tenantId, "canvas.journey_style")).toEqual({ made: 1, kept: 1 });
  });

  it("counts kept once when the catch-up finds it published another way, and nothing when it expires", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const r = await draftIt(db);
    if (!r.ok) throw new Error(r.error);
    // The engine publishes it, not the editor's Publish: the record waits for the catch-up.
    await new Promise((done) => setTimeout(done, 5));
    await publishLifecycleJourney(lifecycleAdmin, r.id, { db });
    expect(answers(db, agent.tenantId, "canvas.lifecycle")).toEqual({});
    await catchUpBrand(agent, { deadlineMs: Date.now() + 10_000, db });
    expect((await records(db, agent))[0]).toMatchObject({ state: "acted", actedBy: { type: "system", id: "agent_record" } });
    expect(answers(db, agent.tenantId, "canvas.lifecycle")).toEqual({ kept: 1 });

    const later = new FakeFirestore();
    seedWorld(later);
    const d = await draftIt(later);
    if (!d.ok) throw new Error(d.error);
    const ahead = 91 * 86_400_000;
    await catchUpBrand(agent, { deadlineMs: Date.now() + ahead + 10_000, db: later, now: () => Date.now() + ahead });
    expect((await records(later, agent))[0]).toMatchObject({ state: "declined", declined: { reason: "expired" } });
    expect(answers(later, agent.tenantId, "canvas.lifecycle")).toEqual({});
  });

  it("with LOOPS_ENABLED off keeps no stamp on the record and counts nothing", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    vi.stubEnv("LOOPS_ENABLED", "true");
    const made = await vizzyStamp(agent, "canvas.lifecycle");
    vi.stubEnv("LOOPS_ENABLED", "false");
    const r = await authorLifecycleDraft({ ctx: agent, input: { scope: { connectionId: CONNECTION_ID }, mode: "template", options: { reminders: 2 } }, made, brief: "Warm" }, { db, generate });
    if (!r.ok) throw new Error(r.error);
    expect((await records(db, agent))[0]).not.toHaveProperty("made");
    await publishJourney(lifecycleAdmin, r.id, undefined, db);
    expect(db.dump("loop_days")).toEqual([]);
  });
});

describe("a launch's welcome emails Vizzy drafts on the lifecycle engine", () => {
  const agent: TenantContext = { ...lifecycleAdmin, source: "agent" };
  const graph = () => ({
    nodes: [
      { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
      { id: "e1", type: "email", position: { x: 0, y: 100 }, data: { label: "Welcome" } },
    ],
    edges: [{ id: "a", source: "trigger", target: "e1", sourceHandle: null }],
  });
  const draftViaRoute = () =>
    viaRoute("journey", agent, (made) => journeyCanvasKind.authorDraft({ ctx: agent, input: { scope: { campaignId: CAMPAIGN_ID }, graph: graph() }, made, brief: "Warm welcome" }));

  beforeEach(() => {
    vi.stubEnv("WAITLIST_ENGINE_ENABLED", "true");
    vi.stubEnv("EMAIL_LINK_ORIGIN", "https://mk.test");
  });

  it("counts Vizzy's first draft made once, though the launch's welcome journey was there from the start", async () => {
    seedWaitlistLaunch(fake, { waitlistEngine: "lifecycle" });
    const { journey } = await publishWaitlist(fake);
    const r = await draftViaRoute();
    expect(r).toMatchObject({ id: journey.id, saved: "created" });
    // Vizzy's new words before anyone answered: the same draft, already counted.
    expect(await draftViaRoute()).toMatchObject({ id: journey.id, saved: "rewritten" });
    await publishJourney({ ...lifecycleAdmin, userId: "usr_2" }, journey.id, undefined, fake);
    expect(answers(fake, agent.tenantId, "canvas.journey")).toEqual({ made: 1, kept: 1 });
  });
});

describe("an invite wave Vizzy drafts, counted at its own path", () => {
  const write = vi.fn(async () => ({ subject: "You're in", body: "Hi {{first_name}}, it is ready for you." }));
  const world = () => {
    const db = new FakeFirestore();
    seedLaunch(db);
    seedSignup(db, "s1");
    seedSignup(db, "s2");
    seedConnection(db);
    return db;
  };
  const draftIt = async (db: FakeFirestore) =>
    authorInviteWaveDraft({ ctx: invitesAdmin, input: { scope: { campaignId: "beta" }, size: 2 }, made: await vizzyStamp(invitesAdmin, "canvas.invite_wave"), brief: "Short" }, { db, write });

  beforeEach(() => {
    vi.stubEnv("INVITES_ENABLED", "true");
    vi.stubEnv("EMAIL_LINK_ORIGIN", "https://yougrow.test");
  });

  it("keeps the stamp on the wave, not the record, so sending counts kept once and closing the record nothing", async () => {
    const db = world();
    const r = await draftIt(db);
    if (!r.ok) throw new Error(r.error);
    const [open] = await records(db, invitesAdmin);
    expect(open).not.toHaveProperty("made");
    expect((await sendWave(invitesAdmin, "beta", r.id, { db, kick: async () => undefined })).status).toBe(200);
    expect((await records(db, invitesAdmin))[0]!.state).toBe("acted");
    expect(answers(db, invitesAdmin.tenantId, "canvas.invite_wave")).toEqual({ kept: 1 });
  });

  it("counts Vizzy's rewrite of a person's wave made once, and its send kept once", async () => {
    const db = world();
    const mine = await createWave(invitesAdmin, "beta", { connectionId: "pcn_prod", size: 2, subject: "You're in", body: "Hi {{first_name}}, come in: {{invite_link}}" }, db);
    expect(mine.status).toBe(201);
    const waveId = (mine.body as { wave: { id: string } }).wave.id;
    const r = await viaRoute("invite_wave", invitesAdmin, (made) => authorInviteWaveDraft({ ctx: invitesAdmin, input: { scope: { campaignId: "beta", waveId }, size: 2 }, made, brief: "Warmer" }, { db, write }), db);
    expect(r).toMatchObject({ id: waveId, saved: "created" });
    expect((await sendWave(invitesAdmin, "beta", waveId, { db, kick: async () => undefined })).status).toBe(200);
    const tree = sumWeek(db, invitesAdmin.tenantId, week()) as { u?: Record<string, unknown> };
    expect(answers(db, invitesAdmin.tenantId, "canvas.invite_wave")).toEqual({ made: 1, kept: 1 });
    expect(tree.u?.["canvas.invite_wave"]).toBeUndefined();
  });

  it("counts a wave deleted unsent declined once", async () => {
    const db = world();
    const r = await draftIt(db);
    if (!r.ok) throw new Error(r.error);
    expect((await removeWave(invitesAdmin, "beta", r.id, db)).status).toBe(200);
    expect((await records(db, invitesAdmin))[0]).toMatchObject({ state: "declined", declined: { reason: "dismissed" } });
    expect(answers(db, invitesAdmin.tenantId, "canvas.invite_wave")).toEqual({ declined: 1 });
  });
});

describe("an image style Vizzy suggests, counted where its record closes", () => {
  const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_admin", role: "admin" };
  const MEMBER = { type: "member" as const, id: "usr_admin" };
  const world = () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_A", {
      id: "ten_A",
      tenantName: "Hearth Bakery",
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
  const suggest = async (db: FakeFirestore, id: string) =>
    authorImageStyleSuggestion({ ctx: admin, input: { defaultStyleId: id, reason: "Fits the shop" }, made: await vizzyStamp(admin, "canvas.image_style"), brief: "" }, { db });
  const suggestedAt = (db: FakeFirestore) => (db.raw("tenants", "ten_A") as { imageStyleSuggestion: { suggestedAt: string } }).imageStyleSuggestion.suggestedAt;
  beforeEach(() => vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true"));

  it("counts applying the newest suggestion kept, or edited when the admin changed it, and the one it superseded nothing", async () => {
    const db = world();
    expect((await suggest(db, "headline_card")).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect((await suggest(db, "natural_photo")).ok).toBe(true);
    expect(await closeStyle(admin, "image_style.suggest", suggestedAt(db), { to: "acted", by: MEMBER, fingerprint: imageStylePrint({ defaultStyleId: "natural_photo" }) }, { db })).toBe(true);
    expect(answers(db, admin.tenantId, "canvas.image_style")).toEqual({ kept: 1 });

    const other = world();
    await suggest(other, "natural_photo");
    await closeStyle(admin, "image_style.suggest", suggestedAt(other), { to: "acted", by: MEMBER, fingerprint: imageStylePrint({ defaultStyleId: "headline_card" }) }, { db: other });
    expect(answers(other, admin.tenantId, "canvas.image_style")).toEqual({ edited: 1 });
  });

  it("counts a dismissal declined once, and a second close of the same suggestion nothing", async () => {
    const db = world();
    await suggest(db, "natural_photo");
    const at = suggestedAt(db);
    expect(await closeStyle(admin, "image_style.suggest", at, { to: "declined", reason: "dismissed", by: MEMBER }, { db })).toBe(true);
    expect(await closeStyle(admin, "image_style.suggest", at, { to: "declined", reason: "dismissed", by: MEMBER }, { db })).toBe(false);
    expect(answers(db, admin.tenantId, "canvas.image_style")).toEqual({ declined: 1 });
  });
});

describe("notes Vizzy suggests in a chat, counted where their records close", { timeout: 30_000 }, () => {
  const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
  const deps = (db: FakeFirestore) => ({ db, embed: vi.fn(async (items: unknown[]) => items.map(() => [0.1])), limited: async () => false });
  beforeEach(() => {
    vi.stubEnv("BRAND_NOTES_ENABLED", "true");
    vi.stubEnv("BRAND_NOTES_CHAT_ENABLED", "true");
  });

  it("count made once per note at the filing, and each keep or remove once against the same stamp", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = new FakeFirestore();
      const d = deps(db);
      const r = await agentSuggestNotes(admin, { notes: [{ text: "Buyers order sourdough before the weekend." }, { text: "Most orders come in after a market day." }] }, d);
      expect(r.status).toBe(200);
      const [first, second] = await records(db, admin);
      expect(first!.made).toMatchObject({ kind: "brand_notes", by: "vizzy" });
      expect(answers(db, admin.tenantId, "brand_notes")).toEqual({ made: 2 });
      await updateFromRequest(admin, first!.draft!.ref, { status: "kept" }, d);
      await removeFromRequest(admin, second!.draft!.ref, d);
      expect(answers(db, admin.tenantId, "brand_notes")).toEqual({ made: 2, kept: 1, declined: 1 });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a content plan Vizzy drafts, counted only through its pieces", () => {
  const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_admin", role: "admin" };
  const node = (id: string, type: ContentNode["type"], x: number): ContentNode =>
    ({ id, type, channel: type === "hub" ? "newsletter" : "linkedin", role: id, position: { x, y: 0 }, body: "", placeholderValues: {}, status: "empty", warnings: [] }) as unknown as ContentNode;
  const graph = { nodes: [node("hub", "hub", 0), node("spoke_1", "spoke", 200)], edges: [{ id: "e1", source: "hub", target: "spoke_1" }] } as ContentGraph;
  const intake = {
    name: "Weekend bakes",
    strategy: { objective: "newsletter_signups" },
    scope: { topics: ["audience"], spark: "sourdough before the weekend" },
    knowledge: {},
    topology: { hubChannel: "newsletter", spokeChannels: ["linkedin"] },
  };
  const deps = (db: FakeFirestore) => ({
    db,
    architect: vi.fn(async () => ({ ok: true as const, graph })),
    generate: vi.fn(async (input: { node: ContentNode }) => ({ body: `Copy for ${input.node.id}`, placeholderValues: {}, status: "generated" as const, warnings: [], format: "post" })) as never,
    budgetMs: 10_000,
  });

  beforeEach(() => vi.stubEnv("CONTENT_CHAT_AUTHORING_ENABLED", "true"));

  it("counts no made of its own through the route, and an approving save counts nothing for it, so made never outruns the answers", async () => {
    const db = new FakeFirestore();
    db.seed("workspaces", "ws1", { tenantId: "ten_A", name: "Hearth Bakery", createdAt: "2026-09-01T00:00:00.000Z" });
    const r = await viaRoute("content_plan", admin, (made) => authorContentPlanDraft({ ctx: admin, input: { scope: { workspaceId: "ws1" }, intake }, made, brief: "Warm" }, deps(db)), db);
    expect(r).toMatchObject({ ok: true, saved: "none" });
    const plan = (await getContentPlan(admin, "ws1", r.id, db))!;
    expect(plan).not.toHaveProperty("made");
    // Its record is open; a save that approves the hub closes it as acted, and counts nothing.
    expect((await records(db, admin)).map((a) => a.state)).toEqual(["proposed"]);
    const approved = { ...plan, graph: { ...plan.graph, nodes: plan.graph.nodes.map((n) => (n.id === "hub" ? { ...n, status: "approved" as const } : n)) } };
    expect(await closePlanDraft(admin, "ws1", plan, approved, { db })).toBe(1);
    expect(answers(db, admin.tenantId, "canvas.content_plan")).toEqual({});
    expect(JSON.stringify(sumWeek(db, admin.tenantId, week()) ?? {})).not.toContain("canvas.content_plan");
  });
});
