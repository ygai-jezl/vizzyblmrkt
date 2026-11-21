import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Values on a person and a company (AUDIENCE_FIELDS_ENABLED): admins only, through the one writer.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const personValues = await import("./route");
const companyValues = await import("../../../../crm/companies/[companyId]/fields/route");
const { saveFieldListChange } = await import("@/lib/audience/fieldList");
const { deterministicCompanyId, deterministicContactId } = await import("@/lib/crm/identifiers");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u_admin", role: "admin" } as const;
const member = { ...admin, userId: "u_member", role: "member" };
const by = { type: "member", id: "u_admin" } as const;
const PERSON = deterministicContactId("ten_A", "sam@example.com");
const COMPANY = deterministicCompanyId("ten_A", "example.com");
const SEATS = "fld_000000000001";
const REGION = "fld_000000000002";

const req = (body: unknown) => new Request("http://localhost/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const person = (personId: string, changes: unknown) => personValues.PATCH(req({ changes }), { params: Promise.resolve({ personId }) });
const company = (companyId: string, changes: unknown) => companyValues.PATCH(req({ changes }), { params: Promise.resolve({ companyId }) });

let db: FakeFirestore;
beforeEach(async () => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
  vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  db.seed("contacts", PERSON, { tenantId: "ten_A", contactKey: "sam@example.com", memberOf: ["all"] });
  db.seed("companies", COMPANY, { tenantId: "ten_A", domain: "example.com" });
  await saveFieldListChange({ ...admin }, "person", { baseRev: 0, change: { op: "add", label: "Seats", type: "number" }, by, newFieldId: () => SEATS }, db);
  await saveFieldListChange({ ...admin }, "company", { baseRev: 0, change: { op: "add", label: "Region", type: "text" }, by, newFieldId: () => REGION }, db);
});
afterEach(() => vi.unstubAllEnvs());

describe("PATCH a person's or a company's field values", () => {
  it("doesn't exist while the switch is off", async () => {
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "false");
    expect((await person(PERSON, { [SEATS]: 1 })).status).toBe(404);
    expect((await company(COMPANY, { [REGION]: "Europe" })).status).toBe(404);
  });

  it("needs a session and an admin", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await person(PERSON, { [SEATS]: 1 })).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    expect((await person(PERSON, { [SEATS]: 1 })).status).toBe(403);
    expect((await company(COMPANY, { [REGION]: "Europe" })).status).toBe(403);
  });

  it("sets a person's values and answers with all of them", async () => {
    const res = await person(PERSON, { [SEATS]: 12 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ values: { [SEATS]: 12 }, changed: [SEATS] });
  });

  it("refuses bad input, unknown fields and bad values in plain codes, and finds nobody for a bad id", async () => {
    const bad = await person(PERSON, { [SEATS]: "twelve" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_value", fieldId: SEATS });
    expect((await person(PERSON, { fld_999999999999: 1 })).status).toBe(400);
    expect((await person(PERSON, "not an object")).status).toBe(400);
    expect((await person(deterministicContactId("ten_A", "nobody@example.com"), { [SEATS]: 1 })).status).toBe(404);
    expect((await person("ct_..%2F", { [SEATS]: 1 })).status).toBe(404);
  });

  it("sets a company's values, and a People field doesn't fit a company", async () => {
    const res = await company(COMPANY, { [REGION]: "Europe" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ values: { [REGION]: "Europe" }, changed: [REGION] });
    expect((await company(COMPANY, { [SEATS]: 1 })).status).toBe(400);
  });

  it("never touches another brand's person", async () => {
    session.getAdminContext.mockResolvedValue({ ...admin, tenantId: "ten_B" });
    await expect(person(PERSON, { [SEATS]: 1 })).rejects.toThrow(/another tenant/);
    expect(db.raw("contacts", PERSON)).not.toHaveProperty("fields");
  });
});
