import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Open early: origin, switches, sign-in, input, limit, in that order. Any member may. The brand is
// always the session's, and a brand without Coming up never gets it from here.
const fake = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => fake.db,
}));
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant/rateLimit", () => limits);

const { POST } = await import("./route");

const AT = "2026-11-25T10:00:00.000Z";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const req = (body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/admin/nav/open", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

let db: FakeFirestore;

function seedBrand(id: string, over: Record<string, unknown> = {}) {
  db.seed("tenants", id, {
    tenantName: `Brand ${id}`,
    rootDomain: `${id}.example.com`,
    status: "active",
    region: "us",
    allowedOrigins: [`https://${id}.example.com`],
    ownerId: "usr_owner",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  fake.db = db;
  vi.stubEnv("NEXT_PUBLIC_NAV_V2_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED", "true");
  vi.stubEnv("ONBOARDING_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  seedBrand("ten_A", { sidebarReveal: { shown: ["content"], opened: [], startedAt: AT } });
  seedBrand("ten_B", { sidebarReveal: { shown: [], opened: [], startedAt: AT } });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/nav/open", () => {
  it("404s with the switch off, or without nav v2 phase 2, before sign-in", async () => {
    vi.stubEnv("ONBOARDING_ENABLED", "");
    expect((await POST(req({ key: "products" }))).status).toBe(404);
    vi.stubEnv("ONBOARDING_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED", "");
    expect((await POST(req({ key: "products" }))).status).toBe(404);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("403s a request from another site", async () => {
    expect((await POST(req({ key: "products" }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("401s signed out", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await POST(req({ key: "products" }))).status).toBe(401);
  });

  it.each([
    ["no body", undefined],
    ["a section that always shows", { key: "home" }],
    ["an unknown section", { key: "people" }],
    ["a brand in the body", { key: "products", tenantId: "ten_B" }],
  ])("400s for %s", async (_label, body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
    expect(db.writeCountFor("tenants", "ten_A")).toBe(0);
  });

  it("shows the section for good and records it, for a member too", async () => {
    session.getAdminContext.mockResolvedValue(member);
    const res = await POST(req({ key: "products" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ shown: ["content", "products"] });
    const stored = db.raw("tenants", "ten_A")!.sidebarReveal as { shown: string[]; opened: { key: string; at: string }[] };
    expect(stored.shown).toEqual(["content", "products"]);
    expect(stored.opened).toEqual([{ key: "products", at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) }]);
    expect(JSON.stringify(stored)).not.toContain("usr_member");
    expect(db.raw("tenants", "ten_B")!.sidebarReveal).toEqual({ shown: [], opened: [], startedAt: AT });
    expect(limits.isRateLimited).toHaveBeenCalledWith("user:ten_A:usr_member", expect.objectContaining({ prefix: "nav_open" }));
  });

  it("writes nothing for a section already shown", async () => {
    const res = await POST(req({ key: "content" }));
    expect(await res.json()).toEqual({ shown: ["content"] });
    expect(db.writeCountFor("tenants", "ten_A")).toBe(0);
  });

  it("409s for a brand without Coming up, and never starts it", async () => {
    seedBrand("ten_A", { businessProfile: { status: "skipped", answers: {}, rev: 0, startedAt: AT } });
    const res = await POST(req({ key: "products" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no_profile" });
    expect(db.raw("tenants", "ten_A")!.sidebarReveal).toBeUndefined();
  });

  it("429s over the limit", async () => {
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await POST(req({ key: "products" }))).status).toBe(429);
    expect(db.writeCountFor("tenants", "ten_A")).toBe(0);
  });
});
