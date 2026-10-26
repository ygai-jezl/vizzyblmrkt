import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mailchimp", () => ({ syncSignupToAudience: vi.fn(), syncSignupToWeekly: vi.fn() }));
vi.mock("@/lib/journey/router", () => ({ enrolSignupInWaitlistJourney: vi.fn() }));
vi.mock("@/lib/crm/contactService", () => ({ recordSignupContact: vi.fn() }));

import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant/types";
import type { EmailMessage } from "@/lib/email";
import { createConnection } from "@/lib/connect/keys";
import { __resetSiteKeyCaches } from "./siteKeyAuth";
import { createSiteKey } from "./siteKeys";
import { handleSiteSignup, type SiteSignupHttpDeps } from "./siteSignupHttp";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const NOW = Date.parse("2026-10-22T10:00:00Z");

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});
beforeEach(() => {
  vi.stubEnv("LAUNCH_SITE_SIGNUPS_ENABLED", "true");
  vi.stubEnv("EMAIL_LINK_ORIGIN", "https://yougrow.test");
  __resetSiteKeyCaches();
  __resetRateLimitState();
});
afterEach(() => vi.unstubAllEnvs());

type Auth = { keyId: string; secret: string };
function request(auth: Auth | null, body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = `Basic ${Buffer.from(`${auth.keyId}:${auth.secret}`).toString("base64")}`;
  return new Request("https://yougrow.test/api/v2/signups", {
    method: "POST",
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

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
  db.seed("campaigns", "news", { tenantId: "ten_A", waitlistName: "Acme newsletter", spotsToMoveUponReferral: 0, questions: [], createdAt: "2026-10-01T00:00:00Z" });
  const r = await createSiteKey(ctx, "news", { db, nowMs: NOW });
  if ("error" in r) throw new Error(r.error);
  const sent: EmailMessage[] = [];
  const deps: SiteSignupHttpDeps = {
    db,
    nowMs: () => NOW,
    send: async (m) => {
      sent.push(m);
      return { sent: true, provider: "mandrill" };
    },
  };
  return { db, deps, sent, auth: { keyId: r.key.keyId, secret: r.secret } };
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("POST /api/v2/signups", () => {
  it("adds the sign-up and answers 202", async () => {
    const w = await setup();
    const res = await handleSiteSignup(request(w.auth, { email: "sam@example.com", source: "blog/one" }), w.deps);
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ status: "confirmation_sent" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(w.sent).toHaveLength(1);
    const again = await handleSiteSignup(request(w.auth, { email: "sam@example.com" }), w.deps);
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual({ status: "not_sent", reason: "recently_sent" });
  });

  it("answers 404 while the switch is off, and touches nothing", async () => {
    const w = await setup();
    vi.stubEnv("LAUNCH_SITE_SIGNUPS_ENABLED", "false");
    const res = await handleSiteSignup(request(w.auth, { email: "sam@example.com" }), w.deps);
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ error: "site_signups_disabled" });
    expect(w.sent).toHaveLength(0);
  });

  it("needs the site key", async () => {
    const w = await setup();
    expect((await handleSiteSignup(request(null, { email: "sam@example.com" }), w.deps)).status).toBe(401);
    expect((await handleSiteSignup(request({ ...w.auth, secret: "ygls_wrong" }, { email: "sam@example.com" }), w.deps)).status).toBe(401);
    const res = await handleSiteSignup(request(null, { email: "sam@example.com" }), w.deps);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
    expect(w.sent).toHaveLength(0);
  });

  it("refuses a product key", async () => {
    const w = await setup();
    const { connection, secret } = await createConnection(ctx, { name: "Acme", kind: "custom" }, w.db);
    expect((await handleSiteSignup(request({ keyId: connection.keyId, secret }, { email: "sam@example.com" }), w.deps)).status).toBe(401);
  });

  it("names the field that's wrong", async () => {
    const w = await setup();
    const bad = await handleSiteSignup(request(w.auth, { email: "not an email" }), w.deps);
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({ error: "invalid", fields: [{ path: "email" }] });
    const extra = await handleSiteSignup(request(w.auth, { email: "sam@example.com", tenantId: "ten_B" }), w.deps);
    expect(extra.status).toBe(400);
    const notJson = await handleSiteSignup(request(w.auth, "{"), w.deps);
    expect(await json(notJson)).toEqual({ error: "invalid_json" });
    expect(w.sent).toHaveLength(0);
  });

  it("refuses a body over 8 KB", async () => {
    const w = await setup();
    const res = await handleSiteSignup(request(w.auth, { email: "sam@example.com", source: "x".repeat(9000) }), w.deps);
    expect(res.status).toBe(413);
  });

  it("limits calls per key, after the key is checked", async () => {
    const w = await setup();
    const seen: string[] = [];
    const deps = { ...w.deps, rateLimit: async (k: string) => (seen.push(k), true) };
    expect((await handleSiteSignup(request({ ...w.auth, secret: "ygls_wrong" }, { email: "sam@example.com" }), deps)).status).toBe(401);
    expect(seen).toHaveLength(0); // a bad secret never counts against the key
    const res = await handleSiteSignup(request(w.auth, { email: "sam@example.com" }), deps);
    expect(res.status).toBe(429);
    expect(seen).toEqual([w.auth.keyId]);
  });

  it("an archived launch answers 409", async () => {
    const w = await setup();
    w.db.seed("campaigns", "news", { ...w.db.raw("campaigns", "news"), archivedAt: "2026-10-10T00:00:00Z" });
    const res = await handleSiteSignup(request(w.auth, { email: "sam@example.com" }), w.deps);
    expect(res.status).toBe(409);
  });

  it("a failed send answers 503 with Retry-After", async () => {
    const w = await setup();
    const res = await handleSiteSignup(request(w.auth, { email: "sam@example.com" }), {
      ...w.deps,
      send: async () => ({ sent: false, provider: "mandrill", reason: "down" }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
  });
});
