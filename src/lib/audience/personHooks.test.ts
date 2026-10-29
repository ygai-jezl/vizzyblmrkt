import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { liftUnsubscribe, suppressEmail } from "@/lib/email/suppression";
import { recordSignupContact, recordSignupContactStatus } from "@/lib/crm/contactService";
import { deleteUser, patchBatch, patchUser, recordUserEvent } from "@/lib/connect/v2/users";
import { eraseProductUser } from "@/lib/connect/erase";
import { productUserDocId } from "@/lib/connect/profile";
import { deleteLaunch } from "@/lib/tenant/launchDeletion";
import { CONNECTION_ID, T0, TENANT_ID, ctx, seedWorld, system } from "@/lib/lifecycle/testing/fixtures";
import type { Campaign } from "@/lib/types/campaign";
import type { Contact } from "@/lib/types/contact";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { Signup } from "@/lib/types/signup";
import { personIdOf } from "./personSync";

/**
 * Every write path keeps the person record up to date while AUDIENCE_PERSON_LINKS_ENABLED
 * is on, and touches nothing new while it's off. Addresses are .test.
 */

const ISO0 = new Date(T0).toISOString();

function signupDoc(db: FakeFirestore, id: string, over: Partial<Signup> = {}): Signup {
  const doc = {
    tenantId: TENANT_ID,
    campaignId: "camp1",
    email: "ada@customer.test",
    firstName: "Ada",
    verified: false,
    captchaValid: true,
    isSpam: false,
    status: "unverified" as const,
    amountReferred: 0,
    referralToken: `ref_${id}`,
    referralLink: `https://example.test/r/${id}`,
    score: 0,
    createdAt: ISO0,
    ...over,
  };
  db.seed("signups", id, doc);
  return { id, ...doc } as Signup;
}

const person = (db: FakeFirestore, key: string) => db.raw("contacts", personIdOf(TENANT_ID, key)) as Contact | undefined;
const connectionOf = (db: FakeFirestore) => ({ id: CONNECTION_ID, ...(db.raw("product_connections", CONNECTION_ID) as object) }) as ProductConnection;

describe("with the person links off", () => {
  beforeEach(() => vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "false"));
  afterEach(() => vi.unstubAllEnvs());

  it("records sign-ups as before and makes no person from a product user", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const s = signupDoc(db, "sig_1");
    await recordSignupContact(ctx, {} as Campaign, s, db);
    const contact = person(db, "ada@customer.test")!;
    expect(contact.memberOf).toBeUndefined();
    expect(contact.needsSync).toBeUndefined();
    await patchUser(ctx, connectionOf(db), "bea", { email: "bea@customer.test" }, { db, nowMs: T0 });
    expect(person(db, "bea@customer.test")).toBeUndefined();
  });
});

describe("with the person links on", () => {
  beforeEach(() => vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());

  it("follows a sign-up from joining through confirming to being removed", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const s = signupDoc(db, "sig_1");
    await recordSignupContact(ctx, {} as Campaign, s, db);
    expect(person(db, "ada@customer.test")).toMatchObject({ reach: "limited", needsSync: false, memberOf: expect.arrayContaining(["all", "launch:camp1"]) });

    const confirmed = { ...s, status: "verified_active" as const, verified: true };
    db.seed("signups", "sig_1", { ...db.raw("signups", "sig_1"), status: "verified_active", verified: true });
    await recordSignupContact(ctx, {} as Campaign, confirmed, db);
    expect(person(db, "ada@customer.test")!.reach).toBe("yes");

    db.seed("signups", "sig_1", { ...db.raw("signups", "sig_1"), status: "deleted" });
    await recordSignupContactStatus(ctx, { ...confirmed, status: "deleted" }, { remove: true, db });
    expect(person(db, "ada@customer.test")).toMatchObject({ status: "deleted", memberOf: [] });
  });

  it("follows an unsubscribe and its lifting", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    await recordSignupContact(ctx, {} as Campaign, signupDoc(db, "sig_1", { status: "verified_active", verified: true }), db);
    await suppressEmail(system, { email: "Ada@customer.test", reason: "unsubscribe", source: "footer" }, db);
    expect(person(db, "ada@customer.test")).toMatchObject({ reach: "no", optOuts: { blocked: "unsubscribe" } });
    await liftUnsubscribe(system, "ada@customer.test", db);
    expect(person(db, "ada@customer.test")).toMatchObject({ reach: "yes", optOuts: { blocked: null } });
  });

  it("follows API v2: a write, a batch, an address change, an event and a delete", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const c = connectionOf(db);
    await patchUser(ctx, c, "bea", { email: "bea@customer.test", firstName: "Bea" }, { db, nowMs: T0 });
    expect(person(db, "bea@customer.test")).toMatchObject({ firstName: "Bea", consentStatus: "none", memberOf: expect.arrayContaining(["product:any", `product:${CONNECTION_ID}`]) });

    await patchBatch(ctx, c, [{ userId: "cal", email: "cal@customer.test" }, { userId: "dee", email: "dee@customer.test" }], { db, nowMs: T0 });
    expect(person(db, "cal@customer.test")).toBeDefined();
    expect(person(db, "dee@customer.test")).toBeDefined();

    await patchUser(ctx, c, "bea", { email: "bea.new@customer.test" }, { db, nowMs: T0 + 1000 });
    expect(person(db, "bea@customer.test")).toBeUndefined();
    expect(person(db, "bea.new@customer.test")!.products?.[0]?.productUserId).toBe(productUserDocId(CONNECTION_ID, "bea"));

    const before = person(db, "bea.new@customer.test")!.updatedAt;
    await recordUserEvent(ctx, c, "bea", { event: "report.viewed" }, { db, nowMs: T0 + 2000 });
    expect(person(db, "bea.new@customer.test")!.updatedAt).toBe(before);

    await deleteUser(ctx, c, "bea", { db, nowMs: T0 + 3000 });
    expect(person(db, "bea.new@customer.test")).toBeUndefined();
  });

  it("drops the product from a person erased in it, and keeps their launches", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    await recordSignupContact(ctx, {} as Campaign, signupDoc(db, "sig_1", { status: "verified_active", verified: true }), db);
    await patchUser(ctx, connectionOf(db), "ada", { email: "ada@customer.test" }, { db, nowMs: T0 });
    expect(person(db, "ada@customer.test")!.products).toHaveLength(1);
    await eraseProductUser(ctx, CONNECTION_ID, productUserDocId(CONNECTION_ID, "ada"), db, T0 + 1000);
    expect(person(db, "ada@customer.test")).toMatchObject({ products: [], memberOf: expect.arrayContaining(["launch:camp1"]) });
  });

  it("flags the people on a deleted launch for a re-sync", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    db.seed("campaigns", "camp1", { tenantId: TENANT_ID, waitlistName: "Camp One" });
    await recordSignupContact(ctx, {} as Campaign, signupDoc(db, "sig_1"), db);
    const sink = { put: async () => {} };
    await deleteLaunch({ ...ctx, role: "admin" }, "camp1", {}, db, sink);
    expect(person(db, "ada@customer.test")!.needsSync).toBe(true);
  });
});
