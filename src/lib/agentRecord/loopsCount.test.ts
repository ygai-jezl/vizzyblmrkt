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
import { authorJourneyStyle } from "@/lib/canvas/kinds/journeyStyle";
import { ctx as invitesAdmin, seedConnection, seedLaunch, seedSignup } from "@/lib/invites/testing/fixtures";
import { removeWave, sendWave } from "@/lib/invites/adminApi";
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

/** A brand's counts for one kind this week, at version 0 and arm none (the canvas route's made isn't run here). */
function answers(db: FakeFirestore, tenantId: string, kind: string): Record<string, number> {
  const tree = sumWeek(db, tenantId, week()) as { c?: Record<string, Record<string, Record<string, Record<string, Record<string, number>>>>> };
  return tree.c?.[kind]?.[kind]?.v0?.none ?? {};
}

async function records(db: FakeFirestore, ctx: TenantContext): Promise<AgentAction[]> {
  return (await forTenant(ctx, db).agentActions.find({ limit: 100 })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.rev - b.rev);
}

beforeEach(() => {
  __resetRateLimitState();
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

  it("counts one answer when Vizzy rewrote it first: the record it superseded counts nothing", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const r = await draftIt(db, 2);
    if (!r.ok) throw new Error(r.error);
    const again = await draftIt(db, 1, r.id);
    if (!again.ok) throw new Error(again.error);
    expect(again).toMatchObject({ id: r.id, saved: "rewritten" });
    expect((await records(db, agent)).map((a) => `${a.state}:${a.declined?.reason ?? ""}`).sort()).toEqual(["declined:superseded", "proposed:"]);
    await publishJourney(lifecycleAdmin, r.id, undefined, db);
    expect(answers(db, agent.tenantId, "canvas.lifecycle")).toEqual({ kept: 1 });
  });

  it("a style Vizzy then suggests stays one draft, its answer counted under the journey Vizzy drafted", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const r = await draftIt(db);
    if (!r.ok) throw new Error(r.error);
    vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
    vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
    const styled = await authorJourneyStyle(
      { ctx: { ...agent, role: "admin" }, input: { journeyId: r.id, mode: "custom", headerColor: "#225533", buttonColor: "#aa3300" }, made: await vizzyStamp(agent, "canvas.journey_style"), brief: "green header" },
      { db },
    );
    expect(styled).toMatchObject({ ok: true, saved: "created" });
    const [open] = await openRecordsFor(agent, { kind: "lifecycle_journey", ref: r.id }, db);
    expect(open).toMatchObject({ action: "lifecycle_journey.draft", made: { kind: "canvas.lifecycle" } });
    await publishJourney(lifecycleAdmin, r.id, undefined, db);
    expect(answers(db, agent.tenantId, "canvas.lifecycle")).toEqual({ kept: 1 });
    expect(answers(db, agent.tenantId, "canvas.journey_style")).toEqual({});
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
