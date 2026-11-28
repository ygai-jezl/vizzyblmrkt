import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// One pasted list waiting in Review: read it, add it, or dismiss it; admins only, this brand only.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));
const limiter = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant/rateLimit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant/rateLimit")>()), ...limiter }));

const { GET, POST } = await import("./route");
const { readPaste } = await import("@/lib/crm/paste/batch");
const { DONE_WHEN_TSV } = await import("@/lib/crm/paste/testing/samples");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u_admin", role: "admin" } as const;
const member = { ...admin, userId: "u_member", role: "member" };
const theirs = { ...admin, tenantId: "ten_B", userId: "u_b" };
const SWITCHES = [
  "AUDIENCE_PERSON_LINKS_ENABLED",
  "AUDIENCE_ONE_VIEW_ENABLED",
  "ONTOLOGY_PERSON_IDS_ENABLED",
  "AUDIENCE_ADD_PERSON_ENABLED",
  "NEXT_PUBLIC_NAV_V2_ENABLED",
  "NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED",
  "NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED",
  "RAISE_PASTE_ENABLED",
];

const params = (batchId: string) => ({ params: Promise.resolve({ batchId }) });
const get = (id: string) => GET(new Request(`http://localhost/api/admin/audience/paste/${id}`), params(id));
const post = (id: string, body: unknown) =>
  POST(new Request(`http://localhost/api/admin/audience/paste/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), params(id));

let db: FakeFirestore;
let id: string;
let rev: number;
beforeEach(async () => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  for (const s of SWITCHES) vi.stubEnv(s, "true");
  session.getAdminContext.mockResolvedValue(admin);
  const r = await readPaste(admin, { text: DONE_WHEN_TSV, source: "An event", from: "box" }, { db });
  if (!r.ok || r.outcome !== "ready") throw new Error("not ready");
  id = r.batch.id;
  rev = r.batch.rev;
});
afterEach(() => vi.unstubAllEnvs());

describe("GET a pasted list", () => {
  it("gives the waiting list to an admin of its brand", async () => {
    const res = await get(id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.batch).toMatchObject({ id, rev, source: "An event", counts: { people: 10, companies: 3 } });
    expect(body.warning).toBeNull();
  });

  it("is gone for a bad id, another brand's, or one closed already, and forbidden to a member", async () => {
    expect((await get("aa_nope")).status).toBe(404);
    session.getAdminContext.mockResolvedValue(theirs);
    const other = await get(id);
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: "paste_gone" });
    session.getAdminContext.mockResolvedValue(member);
    expect((await get(id)).status).toBe(403);
    session.getAdminContext.mockResolvedValue(admin);
    expect((await post(id, { action: "dismiss", rev })).status).toBe(200);
    expect((await get(id)).status).toBe(404);
  });

  it("doesn't exist with the switch off", async () => {
    vi.stubEnv("RAISE_PASTE_ENABLED", "false");
    expect((await get(id)).status).toBe(404);
    expect((await post(id, { action: "add", rev })).status).toBe(404);
    expect(db.dump("contacts")).toHaveLength(0);
  });
});

describe("POST add or dismiss", () => {
  it("adds everyone with one press and answers the counts", async () => {
    const res = await post(id, { action: "add", rev });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: { people: 10, companies: 3 }, already: { people: 0, companies: 0 }, fieldsNotSaved: 0 });
    expect(db.dump("contacts")).toHaveLength(10);
    expect(db.dump("companies")).toHaveLength(3);
    const again = await post(id, { action: "add", rev });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "paste_gone" });
  });

  it("dismisses it with its rows cleared", async () => {
    const res = await post(id, { action: "dismiss", rev });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dismissed: true });
    expect(db.raw("agent_actions", id)).toMatchObject({ state: "declined", proposal: null, basis: null });
    expect(db.dump("contacts")).toHaveLength(0);
  });

  it("answers 409 for an old rev, 400 for an unknown action, and 403 for a member", async () => {
    const changed = await post(id, { action: "add", rev: rev + 1 });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: "changed" });
    expect((await post(id, { action: "dismiss", rev: rev + 1 })).status).toBe(409);
    expect((await post(id, { action: "publish", rev })).status).toBe(400);
    expect((await post(id, { action: "add", rev, tenantId: "ten_B" })).status).toBe(400);
    session.getAdminContext.mockResolvedValue(member);
    expect((await post(id, { action: "add", rev })).status).toBe(403);
    expect(db.dump("contacts")).toHaveLength(0);
  });

  it("can't add another brand's list", async () => {
    session.getAdminContext.mockResolvedValue(theirs);
    expect((await post(id, { action: "add", rev })).status).toBe(404);
    expect(db.dump("contacts")).toHaveLength(0);
  });

  it("answers 429 past its rate", async () => {
    limiter.isRateLimited.mockResolvedValueOnce(true);
    expect((await post(id, { action: "add", rev })).status).toBe(429);
    expect(limiter.isRateLimited).toHaveBeenCalledWith("user:ten_A:u_admin", expect.objectContaining({ prefix: "paste_apply" }));
  });
});
