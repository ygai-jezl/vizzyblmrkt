import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { T0, TENANT_ID, ctx, seedUser, seedWorld } from "@/lib/lifecycle/testing/fixtures";
import { exportPerson, exportWholePerson, PERSON_EXPORT_FORMAT, WHOLE_PERSON_EXPORT_FORMAT } from "./personExport";
import { personIdOf, syncPerson } from "./personSync";

/** A whole person's export, from made-up people at .test. */

describe("exportWholePerson", () => {
  it("holds their record, every sign-up (without its confirmation token), their launch emails and each product's export", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    db.seed("signups", "s_ada", {
      tenantId: TENANT_ID,
      campaignId: "camp1",
      email: "ada@customer.test",
      status: "unverified",
      verificationToken: "secret-token",
      amountReferred: 0,
      referralToken: "r",
      referralLink: "https://example.test/r",
      score: 0,
      createdAt: new Date(T0).toISOString(),
    });
    db.seed("email_events", "ev1", { tenantId: TENANT_ID, signupId: "s_ada", type: "open" });
    db.seed("invites", "inv_1", { tenantId: TENANT_ID, signupId: "s_ada", campaignId: "camp1" });
    db.seed("waitlist_enrolments", "enr_1", { tenantId: TENANT_ID, signupId: "s_ada", status: "active" });
    const ada = seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: T0 });

    const r = await exportWholePerson(ctx, personIdOf(TENANT_ID, "ada@customer.test"), { db, nowMs: T0 });
    expect(r.found).toBe(true);
    const doc = (r as { document: Record<string, unknown> }).document;
    expect(doc).toMatchObject({ format: WHOLE_PERSON_EXPORT_FORMAT, complete: true, person: { email: "ada@customer.test" } });
    expect((doc.person as Record<string, unknown>).searchTokens).toBeUndefined();
    expect((doc.person as Record<string, unknown>).tenantId).toBeUndefined();
    const signups = doc.signups as Array<Record<string, unknown>>;
    expect(signups).toHaveLength(1);
    expect(signups[0]!.verificationToken).toBeUndefined();
    expect(doc.launchEmails).toHaveLength(1);
    expect(doc.invites).toHaveLength(1);
    expect(doc.waitlistJourneys).toHaveLength(1);
    expect(doc.products).toEqual([expect.objectContaining({ format: PERSON_EXPORT_FORMAT })]);
    expect(JSON.stringify(doc.products)).toContain(ada.id);
    // A product user with their address that the record doesn't link yet is theirs too.
    const other = seedUser(db, "ada-2", { connectionId: "pcn_other", email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    const again = await exportWholePerson(ctx, personIdOf(TENANT_ID, "ada@customer.test"), { db, nowMs: T0 });
    expect(JSON.stringify((again as { document: Record<string, unknown> }).document.products)).toContain(other.id);
    expect((await exportWholePerson({ ...ctx, tenantId: "ten_other" }, personIdOf(TENANT_ID, "ada@customer.test"), { db })).found).toBe(false);
  });
});

describe("person moves in an export", () => {
  function moves(db: FakeFirestore, productUserId: string, to: string, from: string) {
    const row = (over: Record<string, unknown>) => ({
      tenantId: TENANT_ID,
      kind: "record.repointed",
      productUserId,
      connectionId: "pcn_life",
      repoint: "done",
      at: new Date(T0).toISOString(),
      createdAt: new Date(T0).toISOString(),
      ...over,
    });
    db.seed("person_moves", "mv_to", row({ personId: to, fromPersonId: from }));
    db.seed("person_moves", "mv_from", row({ personId: from, fromPersonId: to }));
    db.seed("person_moves", "mv_other", row({ productUserId: "pu_someone_else", personId: "ct_x", fromPersonId: "ct_y" }));
    db.seed("person_moves", "mv_theirs", row({ tenantId: "ten_other", personId: to, fromPersonId: from }));
  }

  it("a product user's export has their moves", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const ada = seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    const person = personIdOf(TENANT_ID, "ada@customer.test");
    moves(db, ada.id, person, personIdOf(TENANT_ID, "old@customer.test"));
    const r = await exportPerson(ctx, ada.id, { db, nowMs: T0 });
    const doc = (r as { document: Record<string, unknown> }).document;
    expect((doc.moves as Array<Record<string, unknown>>).map((m) => m.id).sort()).toEqual(["mv_from", "mv_to"]);
    expect(doc.complete).toBe(true);
    // A section that comes back full says so.
    const capped = await exportPerson(ctx, ada.id, { db, nowMs: T0, limits: { moves: 1 } });
    expect((capped as { document: Record<string, unknown> }).document).toMatchObject({ complete: false, truncated: { moves: expect.any(String) } });
  });

  it("a whole person's export has the moves to and from them", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: T0 });
    const person = personIdOf(TENANT_ID, "ada@customer.test");
    moves(db, "pu_gone", person, personIdOf(TENANT_ID, "old@customer.test"));
    const r = await exportWholePerson(ctx, person, { db, nowMs: T0 });
    const doc = (r as { document: Record<string, unknown> }).document;
    expect((doc.moves as Array<Record<string, unknown>>).map((m) => m.id).sort()).toEqual(["mv_from", "mv_to"]);
    expect(JSON.stringify(doc.moves)).not.toContain("ten_other");
  });
});
