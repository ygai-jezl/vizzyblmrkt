import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// A person's timeline (AUDIENCE_TIMELINE_ENABLED): anyone on the team reads it.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const route = await import("./route");
const { deterministicContactId } = await import("@/lib/crm/identifiers");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u_admin", role: "admin" } as const;
const member = { ...admin, userId: "u_member", role: "member" };
const SAM = deterministicContactId("ten_A", "sam@example.com");

const get = (personId: string, q = "") => route.GET(new Request(`http://localhost/x${q}`), { params: Promise.resolve({ personId }) });

let db: FakeFirestore;
beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
  vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_TIMELINE_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  db.seed("contacts", SAM, {
    tenantId: "ten_A",
    contactKey: "sam@example.com",
    campaigns: [{ campaignId: "spring", signupId: "sig_1", status: "verified_active", joinedAt: "2026-11-01T10:00:00.000Z" }],
  });
  db.seed("campaigns", "spring", { tenantId: "ten_A", waitlistName: "Spring launch" });
});
afterEach(() => vi.unstubAllEnvs());

describe("GET a person's timeline", () => {
  it("doesn't exist while the switch is off", async () => {
    vi.stubEnv("AUDIENCE_TIMELINE_ENABLED", "false");
    expect((await get(SAM)).status).toBe(404);
  });

  it("needs a session, and a member may read it", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await get(SAM)).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    const res = await get(SAM);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entries: [{ id: "signup:sig_1", at: "2026-11-01T10:00:00.000Z", kind: "signup", text: "Joined the Spring launch waitlist", detail: "Confirmed their email" }],
      next: null,
    });
  });

  it("answers 400 for a cursor it didn't make, and 404 for nobody", async () => {
    expect((await get(SAM, "?cursor=bm9wZQ")).status).toBe(400);
    expect((await get(deterministicContactId("ten_A", "nobody@example.com"))).status).toBe(404);
    expect((await get("ct_..%2F")).status).toBe(404);
  });
});
