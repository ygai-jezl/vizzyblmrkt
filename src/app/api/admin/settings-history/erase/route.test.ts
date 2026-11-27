import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Erase values: the switch (404), same origin, a session (401), then who may erase, read live
// (an owner of the organisation with a real admin row for the brand).
const session = vi.hoisted(() => ({ getAdminContextWithHome: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const { GET, POST } = await import("./route");

const TENANT = "ten_fernhill";
const T0 = "2026-09-01T00:00:00.000Z";
const ctx = { tenantId: TENANT, region: "eu", source: "idtoken", role: "admin", userId: "usr_maya" };
const get = (q: string, headers: Record<string, string> = {}) => new Request(`http://localhost/api/admin/settings-history/erase${q}`, { headers: { host: "localhost", ...headers } });
const post = (body: unknown) => new Request("http://localhost/api/admin/settings-history/erase", { method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  for (const n of ["SETTINGS_HISTORY_ENABLED", "AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "PLANS_ENABLED", "SETTINGS_ERASE_ENABLED"]) vi.stubEnv(n, "true");
  const db = new FakeFirestore();
  db.seed("tenants", TENANT, { tenantName: "Fernhill Plants", rootDomain: "fernhill.example", status: "active", region: "eu", allowedOrigins: [], billingTier: "pro", ownerId: "usr_maya", organisationId: "org_f", createdAt: T0, updatedAt: T0 });
  db.seed("organisations", "org_f", { name: "Fernhill Group", plan: "ultra", planSince: T0, brandIds: [TENANT], ownerIds: ["usr_sam"], createdBy: "usr_sam", createdAt: T0, updatedAt: T0 });
  store.db = db;
  session.getAdminContextWithHome.mockResolvedValue({ ctx, homeTenantId: "ten_home", homeRole: "admin" });
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/admin/settings-history/erase", () => {
  it("doesn't exist with its switch off, or without plans", async () => {
    vi.stubEnv("SETTINGS_ERASE_ENABLED", "false");
    expect((await GET(get("?object=person&fieldId=fld_000000000001"))).status).toBe(404);
    vi.stubEnv("SETTINGS_ERASE_ENABLED", "true");
    vi.stubEnv("PLANS_ENABLED", "false");
    expect((await POST(post({ action: "count", object: "person", fieldId: "fld_000000000001" }))).status).toBe(404);
    expect(session.getAdminContextWithHome).not.toHaveBeenCalled();
  });

  it("refuses another site, anyone signed out, and bad input", async () => {
    expect((await GET(get("?object=person&fieldId=fld_000000000001", { origin: "https://evil.example" }))).status).toBe(403);
    session.getAdminContextWithHome.mockResolvedValueOnce(null);
    expect((await GET(get("?object=person&fieldId=fld_000000000001"))).status).toBe(401);
    expect((await GET(get("?object=idea&fieldId=fld_000000000001"))).status).toBe(400);
    expect((await POST(post({ action: "erase", object: "person", fieldId: "fld_000000000001" }))).status).toBe(400);
    expect((await POST(post({ action: "wipe", object: "person", fieldId: "fld_000000000001" }))).status).toBe(400);
  });

  it("refuses an admin who doesn't own the organisation", async () => {
    const res = await POST(post({ action: "count", object: "person", fieldId: "fld_000000000001" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_owner" });
  });
});
