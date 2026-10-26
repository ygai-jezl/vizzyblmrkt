import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);

import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { getLaunchKey } from "@/lib/tenant";
import {
  handleCreateSiteKey,
  handleGetSiteKey,
  handlePatchSiteKey,
  handleRevokeSiteKey,
  handleRotateSiteKey,
} from "./siteKeyAdmin";

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const other = { ...admin, tenantId: "ten_B" };
const NOW = Date.parse("2026-10-22T10:00:00Z");

const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("https://yougrow.test/api/admin/campaigns/news/site-key", {
    method,
    headers: { "content-type": "application/json", host: "yougrow.test", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function world() {
  const db = new FakeFirestore();
  db.seed("campaigns", "news", { tenantId: "ten_A", waitlistName: "Acme newsletter", createdAt: "2026-10-01T00:00:00Z" });
  return { db, deps: { db, nowMs: NOW } };
}
type KeyView = { keyId: string; status: string; rotating: boolean; weekSignups: number; siteConfirmedUrl: string | null };
type Body = { key: KeyView; secret: string; endpoint: string; canCreate: boolean; revoked?: boolean };
const json = async (res: Response) => (await res.json()) as Body;

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LAUNCH_SITE_SIGNUPS_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("site key admin", () => {
  it("creates a key, shows the secret once, and never again", async () => {
    const w = world();
    const res = await handleCreateSiteKey(req("POST"), "news", w.deps);
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.secret).toMatch(/^ygls_/);
    expect(body.key).toMatchObject({ status: "active", weekSignups: 0, siteConfirmedUrl: null });
    expect(await getLaunchKey(body.key.keyId, w.db)).toMatchObject({ tenantId: "ten_A", campaignId: "news" });

    const view = await json(await handleGetSiteKey(req("GET"), "news", w.deps));
    expect(view.key.keyId).toBe(body.key.keyId);
    expect(view.endpoint).toBe("https://yougrow.test/api/v2/signups");
    expect(JSON.stringify(view)).not.toContain(body.secret);

    expect((await handleCreateSiteKey(req("POST"), "news", w.deps)).status).toBe(409);
  });

  it("rotates and revokes", async () => {
    const w = world();
    const created = await json(await handleCreateSiteKey(req("POST"), "news", w.deps));
    const rotated = await json(await handleRotateSiteKey(req("POST"), "news", w.deps));
    expect(rotated.secret).toMatch(/^ygls_/);
    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.key).toMatchObject({ keyId: created.key.keyId, rotating: true });

    expect(await json(await handleRevokeSiteKey(req("DELETE"), "news", w.deps))).toEqual({ revoked: true });
    expect(await getLaunchKey(created.key.keyId, w.db)).toBeNull();
    expect((await json(await handleGetSiteKey(req("GET"), "news", w.deps))).key).toBeNull();
    expect((await handleRevokeSiteKey(req("DELETE"), "news", w.deps)).status).toBe(404);
    expect((await handleRotateSiteKey(req("POST"), "news", w.deps)).status).toBe(404);
  });

  it("sets Send them to, https only, and clears it with an empty box", async () => {
    const w = world();
    expect((await handlePatchSiteKey(req("PATCH", { siteConfirmedUrl: "https://example.com/thanks" }), "news", w.deps)).status).toBe(404);
    await handleCreateSiteKey(req("POST"), "news", w.deps);
    const ok = await handlePatchSiteKey(req("PATCH", { siteConfirmedUrl: "https://example.com/thanks" }), "news", w.deps);
    expect((await json(ok)).key.siteConfirmedUrl).toBe("https://example.com/thanks");
    expect((await handlePatchSiteKey(req("PATCH", { siteConfirmedUrl: "http://example.com/thanks" }), "news", w.deps)).status).toBe(400);
    expect((await handlePatchSiteKey(req("PATCH", { siteConfirmedUrl: "javascript:alert(1)" }), "news", w.deps)).status).toBe(400);
    expect((await handlePatchSiteKey(req("PATCH", { siteConfirmedUrl: "https://example.com", extra: 1 }), "news", w.deps)).status).toBe(400);
    const cleared = await handlePatchSiteKey(req("PATCH", { siteConfirmedUrl: "" }), "news", w.deps);
    expect((await json(cleared)).key.siteConfirmedUrl).toBeNull();
  });

  it("is off, before anything else, while the switch is off", async () => {
    const w = world();
    vi.stubEnv("LAUNCH_SITE_SIGNUPS_ENABLED", "");
    expect((await handleCreateSiteKey(req("POST"), "news", w.deps)).status).toBe(503);
    expect((await handleGetSiteKey(req("GET"), "news", w.deps)).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("needs sign-in; members may look but change nothing", async () => {
    const w = world();
    session.getAdminContext.mockResolvedValue(null);
    expect((await handleGetSiteKey(req("GET"), "news", w.deps)).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    expect((await handleGetSiteKey(req("GET"), "news", w.deps)).status).toBe(200);
    expect((await handleCreateSiteKey(req("POST"), "news", w.deps)).status).toBe(403);
    expect((await handlePatchSiteKey(req("PATCH", { siteConfirmedUrl: null }), "news", w.deps)).status).toBe(403);
    expect((await handleRevokeSiteKey(req("DELETE"), "news", w.deps)).status).toBe(403);
    expect((await handleRotateSiteKey(req("POST"), "news", w.deps)).status).toBe(403);
  });

  it("another brand's launch is not found, and its key untouched", async () => {
    const w = world();
    await handleCreateSiteKey(req("POST"), "news", w.deps);
    session.getAdminContext.mockResolvedValue(other);
    expect((await handleGetSiteKey(req("GET"), "news", w.deps)).status).toBe(404);
    expect((await handleRevokeSiteKey(req("DELETE"), "news", w.deps)).status).toBe(404);
    session.getAdminContext.mockResolvedValue(admin);
    expect((await json(await handleGetSiteKey(req("GET"), "news", w.deps))).key).not.toBeNull();
  });

  it("refuses a cross-site request", async () => {
    const w = world();
    expect((await handleCreateSiteKey(req("POST", undefined, { "sec-fetch-site": "cross-site" }), "news", w.deps)).status).toBe(403);
    expect((await handleCreateSiteKey(req("POST", undefined, { origin: "https://evil.test" }), "news", w.deps)).status).toBe(403);
  });

  it("says when keys can't be made on this YouGrow", async () => {
    const w = world();
    const saved = process.env.CONNECT_SECRET_ENC_KEY;
    delete process.env.CONNECT_SECRET_ENC_KEY;
    try {
      expect((await handleCreateSiteKey(req("POST"), "news", w.deps)).status).toBe(503);
      expect((await json(await handleGetSiteKey(req("GET"), "news", w.deps))).canCreate).toBe(false);
    } finally {
      process.env.CONNECT_SECRET_ENC_KEY = saved;
    }
  });
});
