import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Settings › Data model (AUDIENCE_FIELDS_ENABLED): the field lists and their history. The switch,
// then same origin, a session, and admins for changes.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));
const names = vi.hoisted(() => ({ teamMemberNames: vi.fn(async () => ({ u_admin: "Alex Morgan" }) as Record<string, string>) }));
vi.mock("@/lib/team/names", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/team/names")>()), ...names }));

const fields = await import("./route");
const history = await import("./history/route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u_admin", role: "admin" };
const member = { ...admin, userId: "u_member", role: "member" };

const req = (path: string, method = "GET", body?: unknown, origin = "http://localhost") =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", origin, host: "localhost" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const listReq = (method: string, body?: unknown) => req("/api/admin/audience/fields", method, body);
const add = (body: Record<string, unknown>) => fields.POST(listReq("POST", { object: "person", baseRev: 0, ...body }));

let db: FakeFirestore;
beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
  vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  db.seed("tenant_users", "m1", { tenantId: "ten_A", userId: "u_admin", role: "admin" });
});
afterEach(() => vi.unstubAllEnvs());

describe("the fields routes", () => {
  it("don't exist while the switch is off, or without the person ids", async () => {
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "false");
    expect((await fields.GET(listReq("GET"))).status).toBe(404);
    expect((await history.GET(req("/api/admin/audience/fields/history"))).status).toBe(404);
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "true");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "false");
    expect((await add({ change: { op: "add", label: "Plan", type: "text" } })).status).toBe(404);
  });

  it("need a session from this site, and admins for changes", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await fields.GET(listReq("GET"))).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    expect((await fields.GET(listReq("GET"))).status).toBe(200);
    expect((await add({ change: { op: "add", label: "Plan", type: "text" } })).status).toBe(403);
    expect((await history.POST(req("/h", "POST", { object: "person", rev: 1, baseRev: 1 }))).status).toBe(403);
    session.getAdminContext.mockResolvedValue(admin);
    expect((await fields.POST(req("/api/admin/audience/fields", "POST", { object: "person", baseRev: 0, change: { op: "add", label: "Plan", type: "text" } }, "https://evil.example.com"))).status).toBe(403);
  });

  it("add a field, read it back with the team, and list the change with who made it", async () => {
    const res = await add({ change: { op: "add", label: "Plan", type: "select", options: ["Free", "Pro"] } });
    expect(res.status).toBe(200);
    const { list } = await res.json();
    expect(list).toMatchObject({ object: "person", rev: 1, items: [{ label: "Plan", type: "select" }] });
    const got = await (await fields.GET(listReq("GET"))).json();
    expect(got.lists.person.rev).toBe(1);
    expect(got.lists.company).toMatchObject({ rev: 0, items: [] });
    expect(got.team).toEqual([{ id: "u_admin", name: "Alex Morgan" }]);
    const h = await (await history.GET(req("/api/admin/audience/fields/history?object=person"))).json();
    expect(h.versions).toEqual([
      { rev: 1, savedAt: expect.any(String), by: "Alex Morgan", message: "Added ‘Plan’", source: "editor", restoredFrom: null, items: [{ key: list.items[0].key, label: "Plan", change: "added" }], moreItems: 0 },
    ]);
    names.teamMemberNames.mockResolvedValueOnce({});
    expect((await (await history.GET(req("/api/admin/audience/fields/history?object=person"))).json()).versions[0].by).toBe("Former team member");
  });

  it("answer 400 for a bad change, field_list_full past a cap, 404 for a missing field and 409 for a stale rev", async () => {
    expect((await add({ change: { op: "add", label: "Plan", type: "nope" } })).status).toBe(400);
    expect((await add({ change: { op: "rename", key: "fld_000000000001", label: "X" } })).status).toBe(400);
    expect((await fields.PATCH(listReq("PATCH", { object: "person", baseRev: 0, change: { op: "add", label: "X", type: "text" } }))).status).toBe(400);
    for (let i = 0; i < 100; i += 1) expect((await add({ baseRev: i, change: { op: "add", label: `F${i}`, type: "text" } })).status).toBe(200);
    const full = await add({ baseRev: 100, change: { op: "add", label: "One more", type: "text" } });
    expect(full.status).toBe(400);
    expect(await full.json()).toEqual({ error: "field_list_full" });
    const missing = await fields.PATCH(listReq("PATCH", { object: "person", baseRev: 100, change: { op: "archive", key: "fld_999999999999" } }));
    expect(missing.status).toBe(404);
    const stale = await fields.PATCH(listReq("PATCH", { object: "person", baseRev: 3, change: { op: "archive", key: "fld_999999999999" } }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "fields_changed", list: { rev: 100 } });
  });

  it("restore an earlier version as a new one", async () => {
    const { list } = await (await add({ change: { op: "add", label: "Plan", type: "text" } })).json();
    await fields.PATCH(listReq("PATCH", { object: "person", baseRev: 1, change: { op: "rename", key: list.items[0].key, label: "Tier" } }));
    const res = await history.POST(req("/h", "POST", { object: "person", rev: 1, baseRev: 2 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ list: { rev: 3, items: [{ label: "Plan" }] } });
    expect((await history.POST(req("/h", "POST", { object: "person", rev: 1, baseRev: 2 }))).status).toBe(409);
    expect((await history.POST(req("/h", "POST", { object: "person", rev: 0, baseRev: 3 }))).status).toBe(400);
  });
});
