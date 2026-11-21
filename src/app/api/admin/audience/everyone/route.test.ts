import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// New person (AUDIENCE_ADD_PERSON_ENABLED): admins only, a known address opens that person.
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
const consent = await import("./[personId]/consent/route");
const withdrawRoute = await import("./[personId]/consent/withdraw/route");
const { deterministicCompanyId, deterministicContactId } = await import("@/lib/crm/identifiers");
const { saveFieldListChange } = await import("@/lib/audience/fieldList");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u_admin", role: "admin" } as const;
const member = { ...admin, userId: "u_member", role: "member" };
const SAM = deterministicContactId("ten_A", "sam@labs.example.com");
const PLAN = "fld_000000000001";

const post = (body: unknown, origin?: string) =>
  route.POST(new Request("http://localhost/api/admin/audience/everyone", { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) }));
const get = (q = "") => route.GET(new Request(`http://localhost/api/admin/audience/everyone${q}`));
const agree = (personId: string, body: unknown) =>
  consent.PATCH(new Request("http://localhost/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ personId }) });

const withdraw = (personId: string, body: unknown, origin?: string) =>
  withdrawRoute.POST(
    new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) }),
    { params: Promise.resolve({ personId }) },
  );

let db: FakeFirestore;
beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
  vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_ADD_PERSON_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  usage.checkAllowance.mockResolvedValue({ allowed: true, used: null, limit: null, organisationId: null });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("POST a new person", () => {
  it("doesn't exist while the switch is off", async () => {
    vi.stubEnv("AUDIENCE_ADD_PERSON_ENABLED", "false");
    expect((await post({ email: "sam@labs.example.com" })).status).toBe(404);
    expect((await get()).status).toBe(404);
    expect((await agree(SAM, { how: "in_person" })).status).toBe(404);
  });

  it("needs a session, an admin and the same origin", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await post({ email: "sam@labs.example.com" })).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    expect((await post({ email: "sam@labs.example.com" })).status).toBe(403);
    expect((await get()).status).toBe(403);
    expect((await agree(SAM, { how: "in_person" })).status).toBe(403);
    session.getAdminContext.mockResolvedValue(admin);
    expect((await post({ email: "sam@labs.example.com" }, "https://evil.example.com")).status).toBe(403);
    expect(db.dump("contacts")).toHaveLength(0);
  });

  it("refuses a missing or bad email or phone in plain codes", async () => {
    for (const [body, error] of [
      [{ firstName: "Sam" }, "email_or_phone"],
      [{ email: "sam at labs" }, "invalid_email"],
      [{ phone: "ring me" }, "invalid_phone"],
      [{ email: "sam@labs.example.com", agreed: { how: "other" } }, "note_needed"],
      [{ email: "sam@labs.example.com", role: "admin" }, "invalid_input"],
    ] as const) {
      const res = await post(body);
      expect(res.status, error).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
  });

  it("adds them (201), then opens them on a second try (200) with nothing written", async () => {
    const res = await post({ email: "Sam@Labs.example.com", firstName: "Sam", agreed: { how: "in_person" } });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ personId: SAM, fields: "none" });
    expect(db.raw("contacts", SAM)).toMatchObject({ addedBy: { kind: "member", id: "u_admin", via: "form" }, reach: "yes", tenantId: "ten_A" });
    const events = db.dump("ontology_events").length;
    const again = await post({ email: "sam@labs.example.com", firstName: "Someone else" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ existing: true, personId: SAM });
    expect(db.raw("contacts", SAM)).toMatchObject({ firstName: "Sam" });
    expect(db.dump("ontology_events")).toHaveLength(events);
  });

  it("sets field values only while fields are on", async () => {
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "true");
    await saveFieldListChange(admin, "person", { baseRev: 0, change: { op: "add", label: "Seats", type: "number" }, by: { type: "member", id: "u_admin" }, newFieldId: () => PLAN }, db);
    const bad = await post({ email: "kim@labs.example.com", fields: { [PLAN]: "lots" } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_value", fieldId: PLAN });
    const res = await post({ email: "kim@labs.example.com", fields: { [PLAN]: 12 } });
    expect(await res.json()).toMatchObject({ fields: "saved" });
  });

  it("answers 429 past its rate, adding nobody", async () => {
    limiter.isRateLimited.mockResolvedValueOnce(true);
    const res = await post({ email: "sam@labs.example.com" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(db.dump("contacts")).toHaveLength(0);
  });
});

describe("GET what the form shows first", () => {
  it("gives the plan's people when they are counted, and the company a work address matches", async () => {
    usage.checkAllowance.mockResolvedValue({ allowed: true, used: 9_960, limit: 10_000, organisationId: "org_ten_A" });
    db.seed("companies", deterministicCompanyId("ten_A", "example.com"), { tenantId: "ten_A", domain: "example.com", name: "Acme Labs" });
    const res = await get("?email=sam@labs.example.com");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowance: { used: 9_960, limit: 10_000 }, company: { name: "Acme Labs", domain: "example.com" } });
    expect(usage.checkAllowance).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "ten_A" }), "people", 1, undefined);
  });

  it("gives no allowance with plans off, and no company for a personal address", async () => {
    expect(await (await get("?email=sam@gmail.com")).json()).toEqual({ allowance: null, company: null });
    expect(await (await get()).json()).toEqual({ allowance: null, company: null });
  });
});

describe("PATCH how someone added by hand agreed", () => {
  it("records it for someone added by hand, and refuses anyone else with 409", async () => {
    await post({ email: "sam@labs.example.com" });
    const res = await agree(SAM, { how: "replied_by_email" });
    expect(res.status).toBe(400);
    const ok = await agree(SAM, { how: "email_reply" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ recorded: true, consent: { how: "email_reply", recordedBy: "u_admin" } });
    expect(db.raw("contacts", SAM)).toMatchObject({ reach: "yes" });

    const ada = deterministicContactId("ten_A", "ada@example.com");
    db.seed("contacts", ada, { tenantId: "ten_A", contactKey: "ada@example.com", memberOf: ["all"] });
    const other = await agree(ada, { how: "in_person" });
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: "consent_elsewhere" });
    expect((await agree(deterministicContactId("ten_A", "nobody@example.com"), { how: "in_person" })).status).toBe(404);
    expect((await agree("ct_..%2F", { how: "in_person" })).status).toBe(404);
  });
});

describe("POST a withdrawal of what the team recorded", () => {
  const consentOf = () => (db.raw("contacts", SAM) as { consent?: { marketing_email?: { state: string } }; reach?: string }) ?? {};
  const consentEvents = () => db.dump("ontology_events").filter((e) => e.kind === "consent.recorded");

  it("doesn't exist while the switch, or the person ids it needs, are off", async () => {
    await post({ email: "sam@labs.example.com", agreed: { how: "in_person" } });
    vi.stubEnv("AUDIENCE_ADD_PERSON_ENABLED", "false");
    expect((await withdraw(SAM, {})).status).toBe(404);
    vi.stubEnv("AUDIENCE_ADD_PERSON_ENABLED", "true");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "false");
    expect((await withdraw(SAM, {})).status).toBe(404);
    expect(consentOf()).toMatchObject({ reach: "yes", consent: { marketing_email: { state: "granted" } } });
  });

  it("needs the same origin, a session and an admin, in that order, then good input", async () => {
    await post({ email: "sam@labs.example.com", agreed: { how: "in_person" } });
    expect((await withdraw(SAM, {}, "https://evil.example.com")).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await withdraw(SAM, {})).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    const forbidden = await withdraw(SAM, {});
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });
    session.getAdminContext.mockResolvedValue(admin);
    for (const bad of [{ note: 42 }, { how: "in_person" }, { note: "x".repeat(501) }]) {
      const res = await withdraw(SAM, bad);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_input" });
    }
    expect((await withdraw("ct_..%2F", {})).status).toBe(404);
    expect(consentOf()).toMatchObject({ reach: "yes", consent: { marketing_email: { state: "granted" } } });
    expect(consentEvents()).toHaveLength(1);
  });

  it("withdraws it with a note, so they can't be emailed, then agreeing again works as before", async () => {
    // Each step a minute apart: a consent event is keyed by its moment.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-21T10:00:00.000Z"));
    await post({ email: "sam@labs.example.com", agreed: { how: "in_person" } });
    vi.setSystemTime(Date.parse("2026-11-21T10:01:00.000Z"));
    const res = await withdraw(SAM, { note: "Asked us to stop" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ withdrawn: true, consent: { state: "withdrawn", note: "Asked us to stop", recordedBy: "u_admin" } });
    expect(consentOf()).toMatchObject({ reach: "no", consent: { marketing_email: { state: "withdrawn" } } });
    const again = await withdraw(SAM, {});
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ withdrawn: false });
    expect(consentEvents()).toHaveLength(2);

    vi.setSystemTime(Date.parse("2026-11-21T10:02:00.000Z"));
    expect((await agree(SAM, { how: "email_reply" })).status).toBe(200);
    vi.useRealTimers();
    expect(consentOf()).toMatchObject({ reach: "yes", consent: { marketing_email: { state: "granted" } } });
    expect(consentEvents()).toHaveLength(3);
  });

  it("answers 409 with nothing recorded or for anyone not added by hand", async () => {
    await post({ email: "sam@labs.example.com" });
    const none = await withdraw(SAM, {});
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ error: "nothing_to_withdraw" });
    const ada = deterministicContactId("ten_A", "ada@example.com");
    db.seed("contacts", ada, { tenantId: "ten_A", contactKey: "ada@example.com", memberOf: ["all"] });
    const other = await withdraw(ada, {});
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: "consent_elsewhere" });
    expect((await withdraw(deterministicContactId("ten_A", "nobody@example.com"), {})).status).toBe(404);
  });

  it("never touches another brand's person", async () => {
    await post({ email: "sam@labs.example.com", agreed: { how: "in_person" } });
    session.getAdminContext.mockResolvedValue({ ...admin, tenantId: "ten_B" });
    const res = await withdraw(SAM, {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(consentOf()).toMatchObject({ reach: "yes", consent: { marketing_email: { state: "granted" } } });
    expect(consentEvents()).toHaveLength(1);
  });
});
