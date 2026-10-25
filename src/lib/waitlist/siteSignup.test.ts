import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { syncAudience, syncWeekly, enrol, contact } = vi.hoisted(() => ({
  syncAudience: vi.fn(async () => ({ ok: true })),
  syncWeekly: vi.fn(async () => ({ ok: true })),
  enrol: vi.fn(async () => undefined),
  contact: vi.fn(async () => undefined),
}));
vi.mock("@/lib/mailchimp", () => ({ syncSignupToAudience: syncAudience, syncSignupToWeekly: syncWeekly }));
vi.mock("@/lib/journey/router", () => ({ enrolSignupInWaitlistJourney: enrol }));
vi.mock("@/lib/crm/contactService", () => ({ recordSignupContact: contact }));

import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { EmailMessage, EmailResult } from "@/lib/email";
import type { SiteKey } from "@/lib/types/siteKey";
import { suppressEmail } from "@/lib/email/suppression";
import { deterministicSignupId } from "./identifiers";
import { createSiteKey, siteKeyView } from "./siteKeys";
import { addSiteSignup, confirmSiteSignup, launchHasWeeklyStep, peekSiteConfirm } from "./siteSignup";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "api_key" };
const NOW = Date.parse("2026-10-22T10:00:00Z");
const DAY = 86_400_000;

function seed(db: FakeFirestore, over: Record<string, unknown> = {}) {
  db.seed("tenants", "ten_A", {
    tenantName: "Acme",
    rootDomain: "acme.test",
    status: "active",
    region: "us",
    allowedOrigins: [],
    billingTier: "free",
    ownerId: "usr_1",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  });
  db.seed("campaigns", "news", {
    tenantId: "ten_A",
    waitlistName: "Acme newsletter",
    waitlistUrlLocation: null,
    spotsToMoveUponReferral: 0,
    usesFirstnameLastname: false,
    usesLeaderboard: false,
    usesSignupVerification: false,
    hideCounts: true,
    removeWidgetHeaders: false,
    requiredContactDetail: "EMAIL",
    questions: [],
    sendEmailCongratulationsOnReferral: false,
    leaderboardLength: 0,
    configurationStyleJson: {},
    createdAt: "2026-10-01T00:00:00Z",
    ...over,
  });
}

async function world(over: Record<string, unknown> = {}) {
  const db = new FakeFirestore();
  seed(db, over);
  const r = await createSiteKey(ctx, "news", { db, nowMs: NOW });
  if ("error" in r) throw new Error(r.error);
  const sent: EmailMessage[] = [];
  let result: EmailResult = { sent: true, provider: "mandrill" };
  const send = async (m: EmailMessage) => {
    sent.push(m);
    return result;
  };
  const key = (await forTenant(ctx, db).siteKeys.getById("news")) as SiteKey;
  const add = (body: { email: string; firstName?: string; locale?: string; source?: string }, nowMs = NOW) =>
    addSiteSignup(ctx, key, body, { db, nowMs, send });
  const signup = (email = "sam@example.com") => forTenant(ctx, db).signups.getById(deterministicSignupId("news", email));
  return { db, key, sent, add, signup, failSends: () => (result = { sent: false, provider: "mandrill", reason: "down" }), fixSends: () => (result = { sent: true, provider: "mandrill" }) };
}

const tokenFrom = (m: EmailMessage) => /token=([^&\s"]+)/.exec(m.text ?? "")?.[1] ?? "";

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});
beforeEach(() => {
  process.env.EMAIL_LINK_ORIGIN = "https://yougrow.test";
  vi.clearAllMocks();
});
afterEach(() => {
  delete process.env.EMAIL_LINK_ORIGIN;
});

describe("addSiteSignup", () => {
  it("adds an unconfirmed site sign-up and sends the newsletter confirmation", async () => {
    const w = await world();
    const r = await w.add({ email: "Sam@Example.com", firstName: "Sam", source: "blog/one" });
    expect(r).toEqual({ ok: true, reply: { status: "confirmation_sent" } });
    const s = await w.signup();
    expect(s).toMatchObject({ status: "unverified", verified: false, joinedVia: "site", siteSource: "blog/one", firstName: "Sam" });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.to).toBe("sam@example.com");
    expect(w.sent[0]!.subject).toBe("Confirm your subscription to Acme newsletter");
    expect(w.sent[0]!.subject).not.toMatch(/waitlist/i);
    expect(w.sent[0]!.text).toContain(`https://yougrow.test/waitlist/news/confirm?token=${s!.verificationToken}&t=ten_A`);
    expect(siteKeyView((await forTenant(ctx, w.db).siteKeys.getById("news"))!, NOW).weekSignups).toBe(1);
  });

  it("confirms by email even when the launch doesn't ask for it", async () => {
    const w = await world({ usesSignupVerification: false });
    await w.add({ email: "sam@example.com" });
    expect((await w.signup())?.status).toBe("unverified");
  });

  it("sends at most one confirmation a day", async () => {
    const w = await world();
    await w.add({ email: "sam@example.com" });
    const token = (await w.signup())!.verificationToken;
    expect(await w.add({ email: "sam@example.com" }, NOW + 3600_000)).toEqual({ ok: true, reply: { status: "not_sent", reason: "recently_sent" } });
    expect(w.sent).toHaveLength(1);
    expect(await w.add({ email: "sam@example.com" }, NOW + DAY + 1)).toEqual({ ok: true, reply: { status: "confirmation_sent" } });
    expect(w.sent).toHaveLength(2);
    expect(tokenFrom(w.sent[1]!)).toBe(token); // the same link still works
  });

  it("says when someone is already on the list, and sends nothing", async () => {
    const w = await world();
    await w.add({ email: "sam@example.com" });
    await confirmSiteSignup(ctx, "news", tokenFrom(w.sent[0]!), { db: w.db, nowMs: NOW });
    expect(await w.add({ email: "sam@example.com" }, NOW + 2 * DAY)).toEqual({ ok: true, reply: { status: "already_confirmed" } });
    expect(w.sent).toHaveLength(1);
  });

  it.each(["spam", "hard_bounce"] as const)("never emails an address suppressed for %s", async (reason) => {
    const w = await world();
    await suppressEmail(ctx, { email: "sam@example.com", reason, source: "test" }, w.db);
    expect(await w.add({ email: "sam@example.com" })).toEqual({ ok: true, reply: { status: "not_sent", reason: "blocked" } });
    expect(w.sent).toHaveLength(0);
    expect(await w.signup()).toBeNull();
  });

  it("someone removed from the launch isn't emailed", async () => {
    const w = await world();
    await w.add({ email: "sam@example.com" });
    await forTenant(ctx, w.db).signups.update(deterministicSignupId("news", "sam@example.com"), { status: "offboarded" });
    expect(await w.add({ email: "sam@example.com" }, NOW + 2 * DAY)).toEqual({ ok: true, reply: { status: "not_sent", reason: "removed" } });
  });

  it("a failed send answers email_unavailable and lets the next call try again", async () => {
    const w = await world();
    w.failSends();
    expect(await w.add({ email: "sam@example.com" })).toEqual({ ok: false, error: "email_unavailable" });
    expect((await w.signup())?.confirmationSentAt).toBeNull();
    w.fixSends();
    expect(await w.add({ email: "sam@example.com" }, NOW + 60_000)).toEqual({ ok: true, reply: { status: "confirmation_sent" } });
  });

  it("refuses an archived launch, a suspended brand, and a server with no link address", async () => {
    const archived = await world({ archivedAt: "2026-10-10T00:00:00Z" });
    expect(await archived.add({ email: "sam@example.com" })).toEqual({ ok: false, error: "launch_closed" });

    const suspended = await world();
    suspended.db.seed("tenants", "ten_A", { ...suspended.db.raw("tenants", "ten_A"), status: "suspended" });
    expect(await suspended.add({ email: "sam@example.com" })).toEqual({ ok: false, error: "unauthorized" });

    const noOrigin = await world();
    delete process.env.EMAIL_LINK_ORIGIN;
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_ORIGIN", "");
    try {
      expect(await noOrigin.add({ email: "sam@example.com" })).toEqual({ ok: false, error: "email_unavailable" });
      expect(noOrigin.sent).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps a language the launch offers", async () => {
    const w = await world({ strategy: { defaultLocale: "en", supportedLocales: ["en", "fr"] } });
    await w.add({ email: "sam@example.com", locale: "fr-FR" });
    expect((await w.signup())?.locale).toBe("fr");
    expect(w.sent[0]!.subject).toBe("Confirmez votre abonnement à Acme newsletter");
  });
});

describe("confirming a site sign-up", () => {
  it("shows the page, then confirms and runs the usual follow-up once", async () => {
    const w = await world();
    await w.add({ email: "sam@example.com" });
    const token = tokenFrom(w.sent[0]!);
    expect(await peekSiteConfirm(ctx, "news", token, w.db)).toEqual({ state: "ready", backAgain: false });
    const r = await confirmSiteSignup(ctx, "news", token, { db: w.db, nowMs: NOW });
    expect(r).toMatchObject({ outcome: "confirmed", backAgain: false });
    expect((await w.signup())?.status).toBe("verified_active");
    expect(syncAudience).toHaveBeenCalledTimes(1);
    expect(enrol).toHaveBeenCalledTimes(1);
    expect(contact).toHaveBeenCalledTimes(1);
    // Pressing again changes nothing.
    expect(await confirmSiteSignup(ctx, "news", token, { db: w.db, nowMs: NOW })).toMatchObject({ outcome: "already" });
    expect(enrol).toHaveBeenCalledTimes(1);
    expect(await peekSiteConfirm(ctx, "news", token, w.db)).toEqual({ state: "done" });
  });

  it("a wrong token, or another launch's, confirms nothing", async () => {
    const w = await world();
    await w.add({ email: "sam@example.com" });
    const token = tokenFrom(w.sent[0]!);
    expect(await confirmSiteSignup(ctx, "news", "nope", { db: w.db })).toEqual({ outcome: "invalid" });
    expect(await confirmSiteSignup(ctx, "other", token, { db: w.db })).toEqual({ outcome: "invalid" });
    expect(await confirmSiteSignup({ ...ctx, tenantId: "ten_B" }, "news", token, { db: w.db })).toEqual({ outcome: "invalid" });
    expect(await peekSiteConfirm(ctx, "news", "", w.db)).toEqual({ state: "invalid" });
    expect((await w.signup())?.status).toBe("unverified");
  });

  it("never confirms an address that bounced or reported spam", async () => {
    const w = await world();
    await w.add({ email: "sam@example.com" });
    const token = tokenFrom(w.sent[0]!);
    await suppressEmail(ctx, { email: "sam@example.com", reason: "spam", source: "test" }, w.db);
    expect(await peekSiteConfirm(ctx, "news", token, w.db)).toEqual({ state: "blocked" });
    expect(await confirmSiteSignup(ctx, "news", token, { db: w.db })).toEqual({ outcome: "blocked" });
    expect(syncAudience).not.toHaveBeenCalled();
  });

  it("someone who unsubscribed and signs up again is asked again, and confirming lets them back in", async () => {
    const w = await world();
    seedWeeklyJourney(w.db);
    await w.add({ email: "sam@example.com" });
    await confirmSiteSignup(ctx, "news", tokenFrom(w.sent[0]!), { db: w.db, nowMs: NOW });
    await suppressEmail(ctx, { email: "sam@example.com", reason: "unsubscribe", source: "footer" }, w.db);
    vi.clearAllMocks();

    expect(await w.add({ email: "sam@example.com" }, NOW + 2 * DAY)).toEqual({ ok: true, reply: { status: "confirmation_sent" } });
    const fresh = tokenFrom(w.sent[1]!);
    expect(fresh).not.toBe(tokenFrom(w.sent[0]!));
    expect(await peekSiteConfirm(ctx, "news", fresh, w.db)).toEqual({ state: "ready", backAgain: true });

    const r = await confirmSiteSignup(ctx, "news", fresh, { db: w.db, nowMs: NOW + 2 * DAY });
    expect(r).toMatchObject({ outcome: "confirmed", backAgain: true });
    expect(await forTenant(ctx, w.db).emailSuppressions.find({})).toHaveLength(0);
    expect(await w.signup()).toMatchObject({ resubscribedAt: new Date(NOW + 2 * DAY).toISOString(), unsubscribedAt: null });
    expect(syncAudience).toHaveBeenCalledWith(ctx, expect.anything(), expect.anything(), { resubscribe: true });
    expect(syncWeekly).toHaveBeenCalledWith(ctx, expect.anything(), expect.anything(), { resubscribe: true });
    expect(enrol).not.toHaveBeenCalled(); // a journey takes a person once
  });

  it("only an unsubscribe is ever lifted", async () => {
    const w = await world();
    await suppressEmail(ctx, { email: "sam@example.com", reason: "hard_bounce", source: "mandrill" }, w.db);
    await w.add({ email: "sam@example.com" });
    expect(await forTenant(ctx, w.db).emailSuppressions.find({})).toHaveLength(1);
  });
});

function seedWeeklyJourney(db: FakeFirestore) {
  db.seed("journeys", "journey_news", {
    tenantId: "ten_A",
    campaignId: "news",
    status: "active",
    graph: { nodes: [{ id: "x", type: "exit", data: { exitTargetKind: "weekly" } }], edges: [] },
  });
}

describe("launchHasWeeklyStep", () => {
  it("reads the launch's live journey", async () => {
    const db = new FakeFirestore();
    seed(db);
    const campaign = (await forTenant(ctx, db).campaigns.getById("news"))!;
    expect(await launchHasWeeklyStep(ctx, campaign, db)).toBe(false);
    seedWeeklyJourney(db);
    expect(await launchHasWeeklyStep(ctx, campaign, db)).toBe(true);
    db.seed("journeys", "journey_news", { ...db.raw("journeys", "journey_news"), status: "paused" });
    expect(await launchHasWeeklyStep(ctx, campaign, db)).toBe(false);
  });
});
