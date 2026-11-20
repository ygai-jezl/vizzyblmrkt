import { describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { CollectionLike } from "@/lib/tenant/types";
import type { TenantContext } from "@/lib/tenant/types";
import { backfillPersonIds, backfillStoreOf, BACKFILL_STORES } from "./backfillPersonIds";
import { personIdForAddress } from "./personRef";

const ctx: TenantContext = { tenantId: "ten_demo", region: "us", source: "system" };
const ADA = personIdForAddress("ten_demo", "ada@example.com")!;
const BEA = personIdForAddress("ten_demo", "bea@example.com")!;
const STALE = personIdForAddress("ten_demo", "old@example.com")!;

/** One brand with a product (and a sandbox), a product user, a sign-up and rows in every store. */
function world() {
  const db = new FakeFirestore();
  const T = { tenantId: "ten_demo" };
  db.seed("product_connections", "pcn_1", { ...T, kind: "custom", status: "active" });
  db.seed("product_connections", "pcn_box", { ...T, kind: "sandbox", status: "active" });
  db.seed("product_users", "pu_ada", { ...T, connectionId: "pcn_1", status: "active", emailNormalized: "ada@example.com" });
  db.seed("product_users", "pu_box", { ...T, connectionId: "pcn_box", status: "active", emailNormalized: "box@example.com" });
  db.seed("product_users", "pu_gone", { ...T, connectionId: "pcn_1", status: "deleted" });
  db.seed("signups", "sig_bea", { ...T, campaignId: "camp1", email: "Bea@Example.com" });

  db.seed("product_events", "pe_1", { ...T, productUserId: "pu_ada" });
  db.seed("product_events", "pe_2", { ...T, productUserId: "pu_ada", personId: STALE });
  db.seed("product_events", "pe_3", { ...T, productUserId: "pu_ada", personId: ADA });
  db.seed("product_events", "pe_erase", { ...T, productUserId: "" });
  db.seed("product_events", "pe_box", { ...T, productUserId: "pu_box" });
  db.seed("product_events", "pe_gone", { ...T, productUserId: "pu_gone", personId: STALE });
  db.seed("lifecycle_enrolments", "enr_1", { ...T, productUserId: "pu_ada" });
  db.seed("person_plans", "pp_1", { ...T, productUserId: "pu_ada" });
  db.seed("waitlist_enrolments", "wen_1", { ...T, signupId: "sig_bea" });
  db.seed("waitlist_enrolments", "wen_rehearsal", { ...T, signupId: "sig_bea", rehearsal: true });
  db.seed("waitlist_enrolments", "wen_nobody", { ...T, signupId: "sig_missing" });
  db.seed("email_sends", "es_1", { ...T, signupId: "sig_bea", recipientKind: "signup" });
  db.seed("email_sends", "es_2", { ...T, signupId: "pu_ada", recipientKind: "product_user" });
  db.seed("email_events", "evt_1", { ...T, signupId: "sig_bea" });
  db.seed("email_events", "evt_2", { ...T, signupId: "pu_ada" });

  // Another brand's rows, which name the same ids.
  db.seed("product_events", "pe_theirs", { tenantId: "ten_other", productUserId: "pu_ada" });
  db.seed("email_events", "evt_theirs", { tenantId: "ten_other", signupId: "sig_bea" });
  return db;
}

const person = (db: FakeFirestore, col: string, id: string) => db.raw(col, id)?.personId;

describe("backfillPersonIds", () => {
  it("in a dry run writes nothing, and counts what it would do", async () => {
    const db = world();
    const r = await backfillPersonIds(ctx, { apply: false }, { db });
    expect(r.productEvents).toEqual({ scanned: 6, stamped: 1, corrected: 1, already: 1, unresolved: 1, skipped: 2, gone: 0, failed: 0 });
    expect(r.waitlistEnrolments).toMatchObject({ scanned: 3, stamped: 1, skipped: 1, unresolved: 1 });
    expect(r.emailSends).toMatchObject({ scanned: 2, stamped: 2 });
    expect(r.emailEvents).toMatchObject({ scanned: 2, stamped: 2 });
    expect(r.lifecycleEnrolments).toMatchObject({ stamped: 1 });
    expect(r.personPlans).toMatchObject({ stamped: 1 });
    for (const col of Object.values(BACKFILL_STORES)) {
      for (const id of db.cols.get(col)?.keys() ?? []) expect(db.writeCountFor(col, id), `${col}/${id}`).toBe(0);
    }
  });

  it("with apply, stamps missing people, corrects stale ones and leaves right rows untouched", async () => {
    const db = world();
    await backfillPersonIds(ctx, { apply: true }, { db });
    expect(person(db, "product_events", "pe_1")).toBe(ADA);
    expect(person(db, "product_events", "pe_2")).toBe(ADA);
    expect(person(db, "product_events", "pe_3")).toBe(ADA);
    expect(db.writeCountFor("product_events", "pe_3")).toBe(0);
    expect(person(db, "lifecycle_enrolments", "enr_1")).toBe(ADA);
    expect(person(db, "person_plans", "pp_1")).toBe(ADA);
    expect(person(db, "waitlist_enrolments", "wen_1")).toBe(BEA);
    expect(person(db, "email_sends", "es_1")).toBe(BEA);
    expect(person(db, "email_sends", "es_2")).toBe(ADA);
    expect(person(db, "email_events", "evt_1")).toBe(BEA);
    expect(person(db, "email_events", "evt_2")).toBe(ADA);

    // A dry run afterwards finds nothing left to do.
    const again = await backfillPersonIds(ctx, { apply: false }, { db });
    for (const store of Object.keys(BACKFILL_STORES) as Array<keyof typeof BACKFILL_STORES>) {
      expect(again[store].stamped, store).toBe(0);
      expect(again[store].corrected, store).toBe(0);
    }
  });

  it("leaves a row whose person now resolves to nobody as it is, and counts it unresolved", async () => {
    const db = world();
    const r = await backfillPersonIds(ctx, { apply: true }, { db });
    expect(person(db, "product_events", "pe_gone")).toBe(STALE);
    expect(db.writeCountFor("product_events", "pe_gone")).toBe(0);
    expect(person(db, "waitlist_enrolments", "wen_nobody")).toBeUndefined();
    expect(r.productEvents.unresolved).toBe(1);
  });

  it("skips erase rows, rehearsals and a sandbox's rows", async () => {
    const db = world();
    await backfillPersonIds(ctx, { apply: true }, { db });
    expect(db.raw("product_events", "pe_erase")).not.toHaveProperty("personId");
    expect(db.raw("product_events", "pe_box")).not.toHaveProperty("personId");
    expect(db.raw("waitlist_enrolments", "wen_rehearsal")).not.toHaveProperty("personId");
  });

  it("never touches another brand's rows", async () => {
    const db = world();
    await backfillPersonIds(ctx, { apply: true }, { db });
    expect(db.raw("product_events", "pe_theirs")).not.toHaveProperty("personId");
    expect(db.raw("email_events", "evt_theirs")).not.toHaveProperty("personId");
    expect(db.writeCountFor("product_events", "pe_theirs")).toBe(0);
  });

  it("pages across a boundary, each row once", async () => {
    const db = world();
    for (let i = 0; i < 7; i += 1) db.seed("product_events", `pe_more_${i}`, { tenantId: "ten_demo", productUserId: "pu_ada" });
    const r = await backfillPersonIds(ctx, { apply: true, stores: ["productEvents"], pageSize: 2 }, { db });
    expect(r.productEvents).toMatchObject({ scanned: 13, stamped: 8, corrected: 1, already: 1 });
    for (let i = 0; i < 7; i += 1) expect(person(db, "product_events", `pe_more_${i}`)).toBe(ADA);
    // Only the store asked for.
    expect(r.emailEvents.scanned).toBe(0);
    expect(db.raw("email_events", "evt_1")).not.toHaveProperty("personId");
  });

  it("counts a row deleted between the read and the write as gone, and never creates it again", async () => {
    const db = world();
    // A time to live takes pe_1 while the page is being worked out (when the user is first read).
    const real = db.collection.bind(db);
    let fired = false;
    vi.spyOn(db, "collection").mockImplementation((name: string): CollectionLike => {
      if (name === "product_users" && !fired) {
        fired = true;
        db.cols.get("product_events")!.delete("pe_1");
      }
      return real(name);
    });
    const r = await backfillPersonIds(ctx, { apply: true, stores: ["productEvents"] }, { db });
    expect(r.productEvents.gone).toBe(1);
    expect(db.raw("product_events", "pe_1")).toBeUndefined();
  });

  it("knows each store by its forTenant name or its collection name", () => {
    expect(backfillStoreOf("product_events")).toBe("productEvents");
    expect(backfillStoreOf("emailSends")).toBe("emailSends");
    expect(backfillStoreOf("signups")).toBeNull();
  });
});
