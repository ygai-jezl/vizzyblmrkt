import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mailchimp", () => ({ syncSignupToAudience: vi.fn(), syncSignupToWeekly: vi.fn() }));
vi.mock("@/lib/journey/router", () => ({ enrolSignupInWaitlistJourney: vi.fn() }));
vi.mock("@/lib/crm/contactService", () => ({ recordSignupContact: vi.fn() }));

import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { createSiteKey, setSiteConfirmedUrl } from "./siteKeys";
import { handleSiteConfirmPost, safeThankYouUrl } from "./siteConfirmHttp";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const NOW = Date.parse("2026-10-22T10:00:00Z");

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});
beforeEach(() => vi.stubEnv("LAUNCH_SITE_SIGNUPS_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const db = new FakeFirestore();
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
  db.seed("campaigns", "news", { tenantId: "ten_A", waitlistName: "Acme newsletter", createdAt: "2026-10-01T00:00:00Z" });
  db.seed("signups", "su1", {
    tenantId: "ten_A",
    campaignId: "news",
    email: "sam@example.com",
    status: "unverified",
    verified: false,
    verificationToken: "tok123",
    joinedVia: "site",
    locale: "fr",
    createdAt: "2026-10-22T09:00:00Z",
  });
  await createSiteKey(ctx, "news", { db, nowMs: NOW });
  return db;
}

function post(token: string | null, headers: Record<string, string> = {}): Request {
  const body = new URLSearchParams(token === null ? {} : { token });
  return new Request("https://yougrow.test/api/waitlist/news/confirm?t=ten_A", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", host: "yougrow.test", origin: "https://yougrow.test", ...headers },
    body,
  });
}

describe("the Confirm subscription button", () => {
  it("confirms, then shows the page's own result in their language", async () => {
    const db = await setup();
    const res = await handleSiteConfirmPost(post("tok123"), "news", { db, nowMs: NOW });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/waitlist/news/confirm?state=done&lng=fr&t=ten_A");
    expect((await forTenant(ctx, db).signups.getById("su1"))?.status).toBe("verified_active");
  });

  it("goes to the brand's thank-you page when it has one", async () => {
    const db = await setup();
    await setSiteConfirmedUrl(ctx, "news", "https://example.com/thanks", { db });
    const res = await handleSiteConfirmPost(post("tok123"), "news", { db, nowMs: NOW });
    expect(res.headers.get("location")).toBe("https://example.com/thanks");
  });

  it("a wrong or missing token confirms nothing", async () => {
    const db = await setup();
    expect((await handleSiteConfirmPost(post("nope"), "news", { db })).headers.get("location")).toBe("/waitlist/news/confirm?state=invalid&t=ten_A");
    expect((await handleSiteConfirmPost(post(null), "news", { db })).headers.get("location")).toBe("/waitlist/news/confirm?state=invalid&t=ten_A");
    expect((await forTenant(ctx, db).signups.getById("su1"))?.status).toBe("unverified");
  });

  it("refuses a post from another site", async () => {
    const db = await setup();
    expect((await handleSiteConfirmPost(post("tok123", { "sec-fetch-site": "cross-site" }), "news", { db })).status).toBe(403);
    expect((await handleSiteConfirmPost(post("tok123", { origin: "https://evil.test" }), "news", { db })).status).toBe(403);
    expect((await forTenant(ctx, db).signups.getById("su1"))?.status).toBe("unverified");
  });

  it("does nothing while the switch is off", async () => {
    const db = await setup();
    vi.stubEnv("LAUNCH_SITE_SIGNUPS_ENABLED", "false");
    expect((await handleSiteConfirmPost(post("tok123"), "news", { db })).status).toBe(404);
    expect((await forTenant(ctx, db).signups.getById("su1"))?.status).toBe("unverified");
  });

  it("only ever sends people to an https thank-you page", () => {
    expect(safeThankYouUrl("https://example.com/t")).toBe("https://example.com/t");
    expect(safeThankYouUrl("http://example.com/t")).toBeNull();
    expect(safeThankYouUrl("javascript:alert(1)")).toBeNull();
    expect(safeThankYouUrl("")).toBeNull();
  });
});
