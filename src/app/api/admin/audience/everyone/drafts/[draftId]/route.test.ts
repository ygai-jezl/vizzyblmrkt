import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// A New person form Vizzy filled in (AUDIENCE_VIZZY_ADD_PERSON_ENABLED): admins open, add or dismiss it.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));
const limiter = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant/rateLimit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant/rateLimit")>()), ...limiter }));
const usage = vi.hoisted(() => ({ checkAllowance: vi.fn() }));
vi.mock("@/lib/plans/usage", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/plans/usage")>()), ...usage }));

const route = await import("./route");
const people = await import("../../route");
const { draftNewPerson } = await import("@/lib/audience/personDrafts");
const { getAgentAction } = await import("@/lib/ontology/agentActions");
const { deterministicContactId } = await import("@/lib/crm/identifiers");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u_admin", role: "admin" } as const;
const member = { ...admin, userId: "u_member", role: "member" };
const vizzy = { ...admin, source: "agent" } as const;
const ALEX = deterministicContactId("ten_A", "alex.kim@example.com");

const params = (draftId: string) => ({ params: Promise.resolve({ draftId }) });
const get = (id: string) => route.GET(new Request("http://localhost/x"), params(id));
const dismiss = (id: string) => route.DELETE(new Request("http://localhost/x", { method: "DELETE" }), params(id));
const add = (body: unknown) =>
  people.POST(new Request("http://localhost/api/admin/audience/everyone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

let db: FakeFirestore;
async function draft() {
  const r = await draftNewPerson(vizzy, { email: "alex.kim@example.com", firstName: "Alex", lastName: "Kim" }, { db });
  if (!r.ok || r.outcome === "existing") throw new Error("not drafted");
  return r.action;
}

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_ADD_PERSON_ENABLED", "AUDIENCE_VIZZY_ADD_PERSON_ENABLED"]) vi.stubEnv(k, "true");
  session.getAdminContext.mockResolvedValue(admin);
  usage.checkAllowance.mockResolvedValue({ allowed: true, used: null, limit: null, organisationId: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("a New person form Vizzy filled in", () => {
  it("doesn't exist while the switch is off, and is for admins only", async () => {
    const a = await draft();
    vi.stubEnv("AUDIENCE_VIZZY_ADD_PERSON_ENABLED", "false");
    expect((await get(a.id)).status).toBe(404);
    vi.stubEnv("AUDIENCE_VIZZY_ADD_PERSON_ENABLED", "true");
    session.getAdminContext.mockResolvedValue(member);
    expect((await get(a.id)).status).toBe(403);
    expect((await dismiss(a.id)).status).toBe(403);
  });

  it("opens with what Vizzy filled in, and no consent", async () => {
    const a = await draft();
    const res = await get(a.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft).toEqual({ id: a.id, rev: 1, expiresAt: a.expiresAt, email: "alex.kim@example.com", phone: null, firstName: "Alex", lastName: "Kim", fields: {} });
    expect(JSON.stringify(body)).not.toMatch(/agreed|consent/);
  });

  it("adding them closes it, keeping only their id; the details are gone", async () => {
    const a = await draft();
    const res = await add({ email: "alex.kim@example.com", firstName: "Alex", lastName: "Kim", agreed: { how: "in_person" }, via: "vizzy", draftId: a.id });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ personId: ALEX });
    expect(db.raw("contacts", ALEX)).toMatchObject({ addedBy: { kind: "member", id: "u_admin", via: "vizzy" }, consent: { marketing_email: { how: "in_person", recordedBy: "u_admin" } } });
    const closed = await getAgentAction(admin, a.id, { db });
    expect(closed).toMatchObject({ state: "acted", proposal: null, basis: null, result: { personId: ALEX }, actedBy: { type: "member", id: "u_admin" } });
    expect(closed?.detailsClearedAt).toBeTruthy();
    expect(JSON.stringify(db.dump("agent_actions"))).not.toContain("alex.kim@example.com");
    expect((await get(a.id)).status).toBe(404);
  });

  it("an address already in People closes it too", async () => {
    const a = await draft();
    db.seed("contacts", ALEX, { tenantId: "ten_A", contactKey: "alex.kim@example.com", email: "alex.kim@example.com" });
    const res = await add({ email: "alex.kim@example.com", via: "vizzy", draftId: a.id });
    expect(await res.json()).toEqual({ existing: true, personId: ALEX });
    expect(await getAgentAction(admin, a.id, { db })).toMatchObject({ state: "acted", proposal: null, result: { personId: ALEX } });
  });

  it("dismiss clears what was typed, and then it is gone", async () => {
    const a = await draft();
    const res = await dismiss(a.id);
    expect(await res.json()).toEqual({ dismissed: true });
    expect(await getAgentAction(admin, a.id, { db })).toMatchObject({ state: "declined", declined: { reason: "dismissed" }, proposal: null });
    expect((await get(a.id)).status).toBe(404);
    expect((await dismiss(a.id)).status).toBe(404);
    expect((await get("aa_not-an-id")).status).toBe(404);
  });

  it("never opens another brand's draft", async () => {
    const a = await draft();
    session.getAdminContext.mockResolvedValue({ ...admin, tenantId: "ten_B" });
    expect((await get(a.id)).status).toBe(404);
  });
});
