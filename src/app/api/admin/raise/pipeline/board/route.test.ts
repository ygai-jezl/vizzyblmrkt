import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// The board (RAISE_PIPELINE_ENABLED): anyone on the team reads it, for the session's brand only.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const { GET } = await import("./route");
const { boardWorld } = await import("@/lib/raise/pipeline/testing/world");

const admin = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "u_admin", role: "admin" } as const;
const member = { ...admin, userId: "u_member", role: "member" };
const get = (headers: Record<string, string> = {}) => new Request("http://localhost/api/admin/raise/pipeline/board?tenantId=ten_b", { headers });

let db: FakeFirestore;
beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "RAISE_PIPELINE_ENABLED"]) vi.stubEnv(k, "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/admin/raise/pipeline/board", () => {
  it("doesn't exist with the switch off", async () => {
    vi.stubEnv("RAISE_PIPELINE_ENABLED", "false");
    expect((await GET(get())).status).toBe(404);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("blocks another site and needs a session", async () => {
    expect((await GET(get({ "sec-fetch-site": "cross-site" }))).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await GET(get())).status).toBe(401);
  });

  it("says when there is no board yet", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ setUp: false });
  });

  it("reads the session's brand to anyone on the team, members without moving", async () => {
    const w = await boardWorld(db, { ctx: admin });
    await w.add({ email: "sam@example.com", stage: "contacted" });
    const other = await boardWorld(db, { ctx: { ...admin, tenantId: "ten_b" } });
    await other.add({ email: "lee@example.com", stage: "contacted" });
    session.getAdminContext.mockResolvedValue(member);
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ setUp: true, canMove: false, totals: { people: 1 } });
    expect(JSON.stringify(body)).not.toContain("lee@example.com");
  });
});
