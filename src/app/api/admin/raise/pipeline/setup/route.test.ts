import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Ready-made fields (RAISE_PIPELINE_ENABLED): admins only, the brand from the session, one version a press.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const { GET, POST } = await import("./route");
const { readFieldList } = await import("@/lib/audience/fieldList");

const admin = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "u_admin", role: "admin" } as const;
const member = { ...admin, userId: "u_member", role: "member" };
const URL_ = "http://localhost/api/admin/raise/pipeline/setup";
const get = (query = "", headers: Record<string, string> = {}) => new Request(`${URL_}${query}`, { headers });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

let db: FakeFirestore;
beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "RAISE_PIPELINE_ENABLED"]) vi.stubEnv(k, "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/admin/raise/pipeline/setup", () => {
  it("doesn't exist with the switch off, before anything else", async () => {
    vi.stubEnv("RAISE_PIPELINE_ENABLED", "false");
    expect((await GET(get("?kit=raising"))).status).toBe(404);
    expect((await POST(post({ kit: "raising" }))).status).toBe(404);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("blocks another site, needs a session and an admin", async () => {
    expect((await POST(post({ kit: "raising" }, { origin: "https://elsewhere.test" }))).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await POST(post({ kit: "raising" }))).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    const res = await POST(post({ kit: "raising" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect((await GET(get("?kit=raising"))).status).toBe(403);
    expect((await readFieldList(admin, "person", db)).rev).toBe(0);
  });

  it("refuses bad input", async () => {
    expect((await POST(post({ kit: "loan" }))).status).toBe(400);
    expect((await POST(post({ kit: "raising", tenantId: "ten_b" }))).status).toBe(400);
    expect((await POST(post({ kit: "raising", currency: "pounds" }))).status).toBe(400);
    expect((await GET(get("?kit=loan"))).status).toBe(400);
  });

  it("previews, then presses once, and a second press adds nothing", async () => {
    const preview = await GET(get("?kit=funding&currency=GBP"));
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("no-store");
    expect(await preview.json()).toMatchObject({ kit: "funding", currency: "GBP", firstKit: "raising", plan: { nothing: false } });
    const res = await POST(post({ kit: "funding", currency: "GBP" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ added: { fields: 10, options: 5 + 3 + 5 + 23 }, rev: 1, boardHref: "/admin/crm?tab=investors", board: "funding" });
    const again = await POST(post({ kit: "funding" }));
    expect(await again.json()).toMatchObject({ added: { fields: 0, options: 0 }, message: "Everything is already here. Nothing was added.", rev: 1 });
    expect((await GET(get("?kit=funding"))).status).toBe(200);
  });

  it("sets up the session's brand only", async () => {
    await POST(post({ kit: "raising" }));
    expect((await readFieldList({ ...admin, tenantId: "ten_b" }, "person", db)).items).toEqual([]);
    expect((await readFieldList(admin, "person", db)).items).toHaveLength(10);
  });
});
