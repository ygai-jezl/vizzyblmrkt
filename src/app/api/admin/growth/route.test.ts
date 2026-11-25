import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// The growth path for the sidebar's dots, and with getting to know you on, the sections a brand
// with Coming up shows now. Any member may read it; the brand is always the session's. The
// database is the in-memory fake behind every store.
const fake = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => fake.db,
}));
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);

const { GET } = await import("./route");

const AT = "2026-11-25T10:00:00.000Z";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const req = (headers: Record<string, string> = {}) => new Request("http://localhost/api/admin/growth", { headers });

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

const withReveal = {
  businessProfile: { status: "done", answers: { who: "solo", run: "app", stage: "idea", want: "waitlist" }, rev: 4, startedAt: AT },
  sidebarReveal: { shown: [], opened: [], startedAt: AT },
};

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  fake.db = db;
  vi.stubEnv("NEXT_PUBLIC_NAV_V2_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED", "true");
  vi.stubEnv("ONBOARDING_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  seedBrand("ten_A", withReveal);
  seedBrand("ten_B", withReveal);
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/admin/growth", () => {
  it("404s without nav v2 phase 2", async () => {
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED", "");
    expect((await GET(req())).status).toBe(404);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("403s another site and 401s signed out", async () => {
    expect((await GET(req({ "sec-fetch-site": "cross-site" }))).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it("has no reveal with the switch off, even for a brand that has one, and reads no brand doc", async () => {
    vi.stubEnv("ONBOARDING_ENABLED", "");
    db.seed("workspaces", "w1", { tenantId: "ten_A", name: "Weekly" });
    const body = await (await GET(req())).json();
    expect(body.stages).toEqual(expect.any(Array));
    expect(body).not.toHaveProperty("reveal");
    expect(db.collectionCalls("tenants")).toBe(0);
  });

  it("has no reveal for a brand without one: today's sidebar, and nothing written", async () => {
    seedBrand("ten_A", { businessProfile: { status: "skipped", answers: {}, rev: 0, startedAt: AT } });
    db.seed("contacts", "ct_1", { tenantId: "ten_A", email: "pat@example.com" });
    const body = await (await GET(req())).json();
    expect(body).not.toHaveProperty("reveal");
    expect(db.raw("tenants", "ten_A")!.sidebarReveal).toBeUndefined();
  });

  it("shows and stores a waiting section once it holds data, writing only when the set grows", async () => {
    expect((await (await GET(req())).json()).reveal).toEqual({ shown: [] });
    expect(db.writeCountFor("tenants", "ten_A")).toBe(0);

    db.seed("workspaces", "w1", { tenantId: "ten_A", name: "Weekly" });
    db.seed("contacts", "ct_1", { tenantId: "ten_A", email: "pat@example.com" });
    expect((await (await GET(req())).json()).reveal).toEqual({ shown: ["content", "audience", "insights"] });
    expect(db.raw("tenants", "ten_A")!.sidebarReveal).toMatchObject({ shown: ["content", "audience", "insights"] });
    const writes = db.writeCountFor("tenants", "ten_A");

    expect((await (await GET(req())).json()).reveal).toEqual({ shown: ["content", "audience", "insights"] });
    expect(db.writeCountFor("tenants", "ten_A")).toBe(writes);
    expect(db.raw("tenants", "ten_B")!.sidebarReveal).toEqual(withReveal.sidebarReveal);
  });

  it("works for a member, who may read and grow it like an admin", async () => {
    session.getAdminContext.mockResolvedValue(member);
    db.seed("signups", "s1", { tenantId: "ten_A", status: "verified_active", email: "sam@example.com" });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).reveal).toEqual({ shown: ["audience", "insights"] });
  });

  it("passes allRunning through beside the reveal", async () => {
    db.seed("campaigns", "c1", { tenantId: "ten_A", waitlistName: "Example waitlist", createdAt: AT });
    db.seed("journeys", "journey_c1", { tenantId: "ten_A", status: "active" });
    db.seed("workspaces", "w1", { tenantId: "ten_A", name: "Weekly", createdAt: AT });
    db.seed("campaign_scheduled_posts", "p1", { tenantId: "ten_A", jobKind: "publish", status: "pending" });
    const body = await (await GET(req())).json();
    expect(body.allRunning).toBe(true);
    expect(body.reveal.shown).toEqual(["content", "journeys", "insights"]);
  });
});
