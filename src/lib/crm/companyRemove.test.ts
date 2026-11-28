import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { appendEvents } from "@/lib/tenant";
import { recordCreatedEvent } from "@/lib/ontology/eventBuilders";
import { deterministicCompanyId, deterministicContactId } from "./identifiers";
import { removeCompany } from "./companyRemove";

const ctx = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" } as const;
const CO = deterministicCompanyId("ten_A", "meadow-seed.test");
const AT = "2026-11-26T10:00:00.000Z";

function seed(db: FakeFirestore, tenantId = "ten_A", id = CO) {
  db.seed("companies", id, { tenantId, domain: "meadow-seed.test", name: "Meadow Seed Fund", enrichmentStatus: "manual", contactCount: 0, searchTokens: [], fields: { fld_000000000fhq: "Leeds" } });
}

describe("removeCompany", () => {
  it("removes a company with no people, its field values and its history", async () => {
    const db = new FakeFirestore();
    seed(db);
    await appendEvents(ctx, [recordCreatedEvent({ subject: { type: "company", id: CO }, personId: null, via: "paste", source: "An event", actor: { type: "member", id: "usr_admin" }, at: AT })], { db });
    expect(db.dump("ontology_events")).toHaveLength(1);
    expect(await removeCompany(ctx, CO, { db })).toEqual({ ok: true, events: 1, agentActions: 0 });
    expect(db.raw("companies", CO)).toBeUndefined();
    expect(db.dump("ontology_events")).toHaveLength(0);
    expect(await removeCompany(ctx, CO, { db })).toEqual({ ok: false, error: "not_found" });
  });

  it("refuses a company with people", async () => {
    const db = new FakeFirestore();
    seed(db);
    db.seed("contacts", deterministicContactId("ten_A", "jo@meadow-seed.test"), { tenantId: "ten_A", contactKey: "jo@meadow-seed.test", companyId: CO });
    expect(await removeCompany(ctx, CO, { db })).toEqual({ ok: false, error: "has_people" });
    expect(db.raw("companies", CO)).toBeDefined();
  });

  it("can't find another brand's company, or an id that isn't one", async () => {
    const db = new FakeFirestore();
    const theirs = deterministicCompanyId("ten_B", "meadow-seed.test");
    seed(db, "ten_B", theirs);
    expect(await removeCompany(ctx, theirs, { db })).toEqual({ ok: false, error: "not_found" });
    expect(db.raw("companies", theirs)).toBeDefined();
    expect(await removeCompany(ctx, "../contacts/x", { db })).toEqual({ ok: false, error: "not_found" });
  });
});
