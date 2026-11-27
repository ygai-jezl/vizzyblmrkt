import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// A card move (RAISE_PIPELINE_ENABLED): admins only, through the one field writer.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const { POST } = await import("./route");
const { boardWorld } = await import("@/lib/raise/pipeline/testing/world");

const admin = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "u_admin", role: "admin" } as const;
const member = { ...admin, userId: "u_member", role: "member" };
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/admin/raise/pipeline/move", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

let db: FakeFirestore;
beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "RAISE_PIPELINE_ENABLED"]) vi.stubEnv(k, "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/raise/pipeline/move", () => {
  it("doesn't exist with the switch off", async () => {
    vi.stubEnv("RAISE_PIPELINE_ENABLED", "false");
    expect((await POST(post({}))).status).toBe(404);
  });

  it("blocks another site, needs a session and an admin, and refuses bad input", async () => {
    const w = await boardWorld(db, { ctx: admin });
    const sam = await w.add({ email: "sam@example.com", stage: "contacted" });
    const body = { personId: sam, from: w.stage("contacted"), to: w.stage("replied") };
    expect((await POST(post(body, { origin: "https://elsewhere.test" }))).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await POST(post(body))).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    expect((await POST(post(body))).status).toBe(403);
    session.getAdminContext.mockResolvedValue(admin);
    expect((await POST(post({ ...body, tenantId: "ten_b" }))).status).toBe(400);
    expect((db.raw("contacts", sam)!.fields as Record<string, unknown>)[w.ids.stage]).toBe(w.stage("contacted"));
  });

  it("moves the card and answers it", async () => {
    const w = await boardWorld(db, { ctx: admin });
    const sam = await w.add({ email: "sam@example.com", stage: "contacted" });
    const res = await POST(post({ personId: sam, from: w.stage("contacted"), to: w.stage("replied") }));
    expect(res.status).toBe(200);
    expect((await res.json()).card).toMatchObject({ id: sam, stageOptionId: w.stage("replied") });
  });

  it("reads another brand's person as nobody", async () => {
    const w = await boardWorld(db, { ctx: admin });
    const other = await boardWorld(db, { ctx: { ...admin, tenantId: "ten_b" } });
    const lee = await other.add({ email: "lee@example.com", stage: "contacted" });
    const res = await POST(post({ personId: lee, from: other.stage("contacted"), to: w.stage("replied") }));
    expect(res.status).toBe(404);
    expect((db.raw("contacts", lee)!.fields as Record<string, unknown>)[other.ids.stage]).toBe(other.stage("contacted"));
  });
});
