import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Remove company (RAISE_PASTE_ENABLED): admins only, a company with no people, this brand only.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));
const limiter = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant/rateLimit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant/rateLimit")>()), ...limiter }));

const { DELETE, GET } = await import("./route");
const { deterministicCompanyId, deterministicContactId } = await import("@/lib/crm/identifiers");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u_admin", role: "admin" } as const;
const member = { ...admin, userId: "u_member", role: "member" };
const CO = deterministicCompanyId("ten_A", "meadow-seed.test");
const SWITCHES = ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_ADD_PERSON_ENABLED", "RAISE_PASTE_ENABLED"];

const params = (companyId: string) => ({ params: Promise.resolve({ companyId }) });
const remove = (id: string, origin?: string) =>
  DELETE(new Request(`http://localhost/api/admin/crm/companies/${id}`, { method: "DELETE", headers: origin ? { origin } : {} }), params(id));

let db: FakeFirestore;
beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  for (const s of SWITCHES) vi.stubEnv(s, "true");
  session.getAdminContext.mockResolvedValue(admin);
  db.seed("companies", CO, { tenantId: "ten_A", domain: "meadow-seed.test", name: "Meadow Seed Fund", enrichmentStatus: "manual", contactCount: 0, searchTokens: [] });
});
afterEach(() => vi.unstubAllEnvs());

describe("DELETE /api/admin/crm/companies/[companyId]", () => {
  it("doesn't exist with the switch off", async () => {
    vi.stubEnv("RAISE_PASTE_ENABLED", "false");
    expect((await remove(CO)).status).toBe(404);
    expect(db.raw("companies", CO)).toBeDefined();
    // Reading a company is unchanged.
    expect((await GET(new Request(`http://localhost/api/admin/crm/companies/${CO}`), params(CO))).status).toBe(200);
  });

  it("is for admins, from the same origin, signed in", async () => {
    session.getAdminContext.mockResolvedValue(member);
    expect((await remove(CO)).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await remove(CO)).status).toBe(401);
    session.getAdminContext.mockResolvedValue(admin);
    expect((await remove(CO, "https://evil.example.com")).status).toBe(403);
    expect(db.raw("companies", CO)).toBeDefined();
  });

  it("refuses a company with people (409)", async () => {
    db.seed("contacts", deterministicContactId("ten_A", "jo@meadow-seed.test"), { tenantId: "ten_A", contactKey: "jo@meadow-seed.test", companyId: CO });
    const res = await remove(CO);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "has_people" });
    expect(db.raw("companies", CO)).toBeDefined();
  });

  it("removes a company with no people (200), and can't find another brand's (404)", async () => {
    const theirs = deterministicCompanyId("ten_B", "meadow-seed.test");
    db.seed("companies", theirs, { tenantId: "ten_B", domain: "meadow-seed.test", name: "Theirs", enrichmentStatus: "manual", contactCount: 0, searchTokens: [] });
    const res = await remove(CO);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    expect(db.raw("companies", CO)).toBeUndefined();
    expect((await remove(theirs)).status).toBe(404);
    expect(db.raw("companies", theirs)).toBeDefined();
  });

  it("answers 429 past its rate", async () => {
    limiter.isRateLimited.mockResolvedValueOnce(true);
    expect((await remove(CO)).status).toBe(429);
    expect(limiter.isRateLimited).toHaveBeenCalledWith("user:ten_A:u_admin", expect.objectContaining({ prefix: "company_remove", burstLimit: 20, hourlyLimit: 200 }));
  });
});
