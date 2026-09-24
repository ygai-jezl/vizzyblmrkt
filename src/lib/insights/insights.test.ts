import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { insightsTiles } from "./tiles";
import { loadInsightsOverview, loadSignupSources, loadWeeklySignups } from "./overview";
import { loadEmailInsights } from "./email";
import { loadJourneyInsights } from "./journeys";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const NOW = new Date("2026-09-24T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function signup(db: FakeFirestore, id: string, createdAt: string, over: Record<string, unknown> = {}) {
  db.seed("signups", id, { tenantId: "ten_A", campaignId: "beta", status: "verified_active", verified: true, createdAt, ...over });
}

describe("Insights tiles", () => {
  it("compares weeks, prefers content, and falls back to Verified without a product", () => {
    const [signups, emails, content, conv] = insightsTiles({
      signupsThisWeek: 76,
      signupsLastWeek: 68,
      emails: { sends: 200, opens: 116 },
      sources: { content: 71, referral: 10, total: 120, basis: "recent_signups" },
      activation: null,
      verified: { verified: 89, total: 100 },
    });
    expect(signups).toMatchObject({ value: "76", hint: "+8 on the week before" });
    expect(emails).toMatchObject({ value: "58%" });
    expect(content).toMatchObject({ label: "Signups from content", value: "71" });
    expect(conv).toMatchObject({ label: "Verified", value: "89%" });
  });

  it("shows referral share when nothing came from content, and activation with a product", () => {
    const [, , content, conv] = insightsTiles({
      signupsThisWeek: null,
      signupsLastWeek: null,
      emails: { sends: 0, opens: 0 },
      sources: { content: 0, referral: 24, total: 100, basis: "bigquery" },
      activation: { activated: 131, users: 212 },
      verified: null,
    });
    expect(content).toMatchObject({ label: "Referral share", value: "24%" });
    expect(conv).toMatchObject({ label: "Activation rate", value: "62%", hint: "131 of 212 product users" });
  });
});

describe("Insights loaders (Firestore fallbacks)", () => {
  it("counts twelve weeks of signups, oldest first", async () => {
    const db = new FakeFirestore();
    signup(db, "a", daysAgo(1));
    signup(db, "b", daysAgo(3));
    signup(db, "c", daysAgo(10));
    signup(db, "old", daysAgo(200));
    const weeks = await loadWeeklySignups(ctx, NOW, db);
    expect(weeks).toHaveLength(12);
    expect(weeks.at(-1)).toMatchObject({ signups: 2 });
    expect(weeks.at(-2)).toMatchObject({ signups: 1 });
    expect(weeks[0]!.start < weeks.at(-1)!.start).toBe(true);
  });

  it("estimates sources from recent signups without BigQuery", async () => {
    const db = new FakeFirestore();
    signup(db, "li", daysAgo(2), { utm: { source: "linkedin", campaign: "dinner-carousel" } });
    signup(db, "li2", daysAgo(4), { referrerUrl: "https://www.linkedin.com/" });
    signup(db, "ref", daysAgo(5), { referredBySignupToken: "t1" });
    signup(db, "dir", daysAgo(6));
    signup(db, "gone", daysAgo(6), { status: "deleted" });
    signup(db, "old", daysAgo(40), { utm: { source: "linkedin" } });
    const s = await loadSignupSources(ctx, NOW, db);
    expect(s).toMatchObject({ basis: "recent_signups", total: 4, sampled: false });
    expect(s.rows.map((r) => `${r.key}:${r.count}`)).toEqual(["linkedin:2", "referral:1", "direct:1"]);
    expect(s.contentCampaigns).toEqual([{ value: "dinner-carousel", count: 1 }]);
  });

  it("samples a busy month from its newest 5,000 signups", async () => {
    const db = new FakeFirestore();
    signup(db, "oldest", daysAgo(20), { utm: { source: "linkedin" } });
    for (let i = 0; i < 5000; i += 1) signup(db, `s${i}`, new Date(NOW.getTime() - i * 60_000).toISOString());
    const s = await loadSignupSources(ctx, NOW, db);
    expect(s).toMatchObject({ total: 5000, sampled: true });
    expect(s.rows.map((r) => r.key)).toEqual(["direct"]);
  });

  it("builds the overview with activation from production products and the funnel", async () => {
    const db = new FakeFirestore();
    signup(db, "a", daysAgo(1));
    db.seed("product_connections", "pcn", { tenantId: "ten_A", kind: "custom", status: "active", environment: "production", name: "Fernlight" });
    db.seed("product_connections", "stg", { tenantId: "ten_A", kind: "custom", status: "active", environment: "staging", name: "Fernlight (staging)" });
    const user = (id: string, connectionId: string, activated: boolean) =>
      db.seed("product_users", id, { tenantId: "ten_A", connectionId, status: "active", activated });
    user("u1", "pcn", true);
    user("u2", "pcn", false);
    user("u3", "stg", true);
    const o = await loadInsightsOverview(ctx, { lifecycle: true, invites: true, now: NOW }, db);
    expect(o.tiles.map((t) => t.label)).toEqual(["Signups this week", "Email opens", "Signups from content", "Activation rate"]);
    expect(o.tiles[3]).toMatchObject({ value: "50%" });
    expect(o.funnel).toMatchObject({ waitlisted: 1 });
    expect(o.weeks).toHaveLength(12);
  });
});

describe("Insights email and journeys", () => {
  it("lists each email programme with all-time rates, and recent broadcasts", async () => {
    const db = new FakeFirestore();
    db.seed("campaigns", "beta", { tenantId: "ten_A", waitlistName: "Fernlight Beta" });
    db.seed("journeys", "journey_beta", { tenantId: "ten_A", campaignId: "beta", status: "active", graph: { nodes: [], edges: [] } });
    const ev = (id: string, type: string) => db.seed("email_events", id, { tenantId: "ten_A", journeyId: "journey_beta", type });
    ["s1", "s2", "s3", "s4"].forEach((id) => ev(id, "send"));
    ["o1", "o2"].forEach((id) => ev(id, "open"));
    ev("c1", "click");
    db.seed("broadcasts", "b1", { tenantId: "ten_A", campaignId: "beta", name: "Beta dates", status: "sent", sentAt: daysAgo(3), stats: { emailsSent: 400, openRate: 0.5, clickRate: 0.1 } });
    const e = await loadEmailInsights(ctx, { lifecycle: false, invites: false }, db);
    expect(e.basis).toBe("all time");
    expect(e.programmes).toEqual([
      { id: "journey_beta", name: "Welcome & nurture · Fernlight Beta", href: "/admin/launches/beta/journey", sends: 4, openRate: 0.5, clickRate: 0.25 },
    ]);
    expect(e.broadcasts[0]).toMatchObject({ name: "Beta dates", sends: 400, openRate: 0.5 });
  });

  it("shows both engines' journeys", async () => {
    const db = new FakeFirestore();
    db.seed("campaigns", "beta", { tenantId: "ten_A", waitlistName: "Fernlight Beta", createdAt: daysAgo(30) });
    db.seed("journeys", "journey_beta", { tenantId: "ten_A", campaignId: "beta", status: "active", graph: { nodes: [{ id: "e", type: "email" }], edges: [] } });
    db.seed("email_jobs", "j1", { tenantId: "ten_A", campaignId: "beta", type: "journey_step", status: "pending" });
    db.seed("lifecycle_journeys", "lcj_1", { tenantId: "ten_A", name: "7-day onboarding", status: "active", deliveryMode: "live" });
    db.seed("lifecycle_enrolments", "en1", { tenantId: "ten_A", journeyId: "lcj_1", status: "active" });
    const j = await loadJourneyInsights(ctx, { lifecycle: true, now: NOW }, db);
    expect(j.welcome[0]).toMatchObject({ launchName: "Fernlight Beta", inProgress: 1 });
    expect(j.lifecycle[0]).toMatchObject({ name: "7-day onboarding", active: 1, completed: 0, sends7d: 0 });
  });
});
