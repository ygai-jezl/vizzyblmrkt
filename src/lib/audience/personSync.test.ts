import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { suppressEmail } from "@/lib/email/suppression";
import { upsertContactFromSignup } from "@/lib/crm/contactService";
import { CONNECTION_ID, T0, TENANT_ID, ctx, seedUser, seedWorld, system } from "@/lib/lifecycle/testing/fixtures";
import type { Campaign } from "@/lib/types/campaign";
import type { Contact } from "@/lib/types/contact";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { Signup } from "@/lib/types/signup";
import { markNeedsSync, personIdOf, syncPerson, syncProductLink } from "./personSync";

/**
 * The person record across launches and products. Addresses are .test; phone numbers
 * are from Ofcom's drama range.
 */

const DAY = 86_400_000;
const NOW = T0 + 3_600_000;
const ISO0 = new Date(T0).toISOString();

function seedConnection(db: FakeFirestore, id: string, over: Record<string, unknown> = {}) {
  const base = db.raw("product_connections", CONNECTION_ID) as Record<string, unknown>;
  db.seed("product_connections", id, { ...base, name: id, ...over });
}

function seedSignup(db: FakeFirestore, id: string, over: Partial<Signup> = {}): Signup {
  const doc = {
    tenantId: TENANT_ID,
    campaignId: "camp1",
    email: "ada@customer.test",
    phone: null,
    firstName: "Ada",
    lastName: "Lovelace",
    verified: true,
    captchaValid: true,
    isSpam: false,
    status: "verified_active" as const,
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

function person(db: FakeFirestore, key: string): Contact | undefined {
  const raw = db.raw("contacts", personIdOf(TENANT_ID, key));
  return raw ? ({ id: personIdOf(TENANT_ID, key), ...raw } as Contact) : undefined;
}

async function connection(db: FakeFirestore, id = CONNECTION_ID): Promise<ProductConnection> {
  return { id, ...(db.raw("product_connections", id) as object) } as ProductConnection;
}

describe("syncPerson", () => {
  it("makes one person of one address across two launches and two products", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedConnection(db, "pcn_two");
    seedSignup(db, "sig_1");
    seedSignup(db, "sig_2", { campaignId: "camp2", status: "unverified", createdAt: new Date(T0 + 1000).toISOString() });
    const a = seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    db.seed("product_users", "pu_two", { ...db.raw("product_users", a.id), connectionId: "pcn_two", externalUserId: "ada-2" });

    const res = await syncPerson(ctx, "Ada@Customer.test", { db, nowMs: NOW });
    expect(res.outcome).toBe("created");
    const p = person(db, "ada@customer.test")!;
    expect(p.campaignIds.sort()).toEqual(["camp1", "camp2"]);
    expect(p.products?.map((l) => l.connectionId)).toEqual([CONNECTION_ID, "pcn_two"]);
    expect(p.memberOf).toEqual(
      expect.arrayContaining(["all", "launch:camp1", "launch:camp2", "via:form", `product:${CONNECTION_ID}`, "product:pcn_two", `stage:${CONNECTION_ID}:new`]),
    );
    expect(p).toMatchObject({ reach: "yes", consentStatus: "verified_active", status: "active", needsSync: false, firstName: "Ada" });
    expect(res.added).toEqual(p.memberOf);
  });

  it("keeps the contact the sign-up made and adds the product to it", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const s = seedSignup(db, "sig_1");
    await upsertContactFromSignup(ctx, {} as Campaign, s, { db, now: ISO0 });
    seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    expect((await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW })).outcome).toBe("updated");
    const p = person(db, "ada@customer.test")!;
    expect(p.createdAt).toBe(ISO0);
    expect(p.products).toHaveLength(1);
    expect(p.campaigns[0]).toMatchObject({ campaignId: "camp1", signupId: "sig_1", joinedVia: "form" });
  });

  it("writes nothing when nothing changed", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedSignup(db, "sig_1");
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW });
    const before = person(db, "ada@customer.test")!.updatedAt;
    const res = await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW + 60_000 });
    expect(res).toMatchObject({ outcome: "unchanged", added: [], removed: [] });
    expect(person(db, "ada@customer.test")!.updatedAt).toBe(before);
  });

  it("keeps a phone-only sign-up its own person, and a sign-up with an address on the address", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedSignup(db, "sig_p", { email: null, phone: "+447700900123" });
    seedSignup(db, "sig_e", { campaignId: "camp2", email: "ada@customer.test", phone: "+447700900123" });
    await syncPerson(ctx, "+447700900123", { db, nowMs: NOW });
    expect(person(db, "+447700900123")!.campaigns.map((c) => c.signupId)).toEqual(["sig_p"]);
  });

  it("leaves an unconfirmed sign-up from the brand's own site out until it's confirmed", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedSignup(db, "sig_site", { joinedVia: "site", status: "unverified" });
    expect((await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW })).outcome).toBe("none");
    db.seed("signups", "sig_site", { ...db.raw("signups", "sig_site"), status: "verified_active" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW });
    expect(person(db, "ada@customer.test")!.memberOf).toEqual(expect.arrayContaining(["via:site", "launch:camp1"]));
  });

  it("leaves sandbox test users out", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedConnection(db, CONNECTION_ID, { kind: "sandbox" });
    seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    expect((await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW })).outcome).toBe("none");
  });

  it("can't email anyone after a brand-wide unsubscribe, whatever their sources say", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedSignup(db, "sig_1");
    await suppressEmail(system, { email: "ada@customer.test", reason: "unsubscribe", source: "footer" }, db);
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW });
    expect(person(db, "ada@customer.test")).toMatchObject({ reach: "no", optOuts: { blocked: "unsubscribe", categories: [] } });
  });

  it("removes a person who only used a product once their last product user goes, and keeps one with sign-ups", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const bea = seedUser(db, "bea");
    await syncPerson(ctx, "bea@customer.test", { db, nowMs: NOW });
    expect(person(db, "bea@customer.test")).toMatchObject({ consentStatus: "none", memberOf: expect.arrayContaining(["all", "product:any"]) });
    db.seed("product_users", bea.id, { ...db.raw("product_users", bea.id), status: "deleted" });
    const res = await syncPerson(ctx, "bea@customer.test", { db, nowMs: NOW });
    expect(res.outcome).toBe("deleted");
    expect(person(db, "bea@customer.test")).toBeUndefined();

    seedSignup(db, "sig_1");
    const ada = seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW });
    db.seed("product_users", ada.id, { ...db.raw("product_users", ada.id), status: "deleted" });
    db.seed("signups", "sig_1", { ...db.raw("signups", "sig_1"), status: "deleted" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW });
    expect(person(db, "ada@customer.test")).toMatchObject({ status: "deleted", memberOf: [], products: [] });
  });

  it("leaves another brand's records alone", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedSignup(db, "sig_other", { tenantId: "ten_other" } as Partial<Signup>);
    expect((await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW })).outcome).toBe("none");
    expect((await syncPerson({ ...ctx, tenantId: "ten_other" }, "ada@customer.test", { db, nowMs: NOW })).outcome).toBe("created");
    expect(person(db, "ada@customer.test")).toBeUndefined();
  });

  it("never copies a product's name onto a contact from a sign-up, and keeps a product-only person's name in step", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedSignup(db, "sig_1", { firstName: null, lastName: null });
    seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test", firstName: "Ada", lastName: "Product" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW });
    expect(person(db, "ada@customer.test")).toMatchObject({ firstName: null, lastName: null });

    const bea = seedUser(db, "bea", { firstName: "Bea" });
    await syncPerson(ctx, "bea@customer.test", { db, nowMs: NOW });
    expect(person(db, "bea@customer.test")!.firstName).toBe("Bea");
    db.seed("product_users", bea.id, { ...db.raw("product_users", bea.id), firstName: "Beatrice" });
    expect((await syncPerson(ctx, "bea@customer.test", { db, nowMs: NOW })).outcome).toBe("updated");
    expect(person(db, "bea@customer.test")!.firstName).toBe("Beatrice");
  });

  it("clears a sync someone owed", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedSignup(db, "sig_1");
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW });
    await markNeedsSync(ctx, "ada@customer.test", db);
    expect(person(db, "ada@customer.test")!.needsSync).toBe(true);
    expect((await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW })).outcome).toBe("updated");
    expect(person(db, "ada@customer.test")!.needsSync).toBe(false);
  });
});

describe("syncProductLink", () => {
  it("gives a product user with no address their own person, then moves them when an address arrives", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedSignup(db, "sig_1");
    const anon = seedUser(db, "anon", { email: null, emailNormalized: null });
    await syncProductLink(ctx, await connection(db), anon, { db, nowMs: NOW });
    expect(person(db, `pu:${anon.id}`)?.products?.[0]?.productUserId).toBe(anon.id);

    const named = { ...anon, email: "ada@customer.test", emailNormalized: "ada@customer.test" };
    db.seed("product_users", anon.id, { ...db.raw("product_users", anon.id), email: named.email, emailNormalized: named.emailNormalized });
    await syncProductLink(ctx, await connection(db), named, { db, nowMs: NOW, previousKey: `pu:${anon.id}` });
    expect(person(db, `pu:${anon.id}`)).toBeUndefined();
    const ada = person(db, "ada@customer.test")!;
    expect(ada.products?.map((p) => p.productUserId)).toEqual([anon.id]);
    expect(ada.campaignIds).toEqual(["camp1"]);
  });

  it("moves the link when their address changes", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const user = seedUser(db, "cal");
    await syncProductLink(ctx, await connection(db), user, { db, nowMs: NOW });
    const moved = { ...user, email: "cal.new@customer.test", emailNormalized: "cal.new@customer.test" };
    db.seed("product_users", user.id, { ...db.raw("product_users", user.id), email: moved.email, emailNormalized: moved.emailNormalized });
    await syncProductLink(ctx, await connection(db), moved, { db, nowMs: NOW, previousKey: "cal@customer.test" });
    expect(person(db, "cal@customer.test")).toBeUndefined();
    expect(person(db, "cal.new@customer.test")!.products).toHaveLength(1);
  });

  it("writes only when the stage moves, as the clocks pass", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const user = seedUser(db, "dee");
    const c = await connection(db);
    await syncProductLink(ctx, c, user, { db, nowMs: NOW });
    expect(person(db, "dee@customer.test")!.memberOf).toContain(`stage:${CONNECTION_ID}:new`);
    expect((await syncProductLink(ctx, c, user, { db, nowMs: NOW + 60_000 }))?.outcome).toBe("unchanged");
    const later = await syncProductLink(ctx, c, user, { db, nowMs: T0 + 3 * DAY });
    expect(later).toMatchObject({ outcome: "updated", added: [`stage:${CONNECTION_ID}:onboarding`], removed: [`stage:${CONNECTION_ID}:new`] });
    expect((await syncProductLink(ctx, c, user, { db, nowMs: T0 + 8 * DAY }))?.added).toEqual([`stage:${CONNECTION_ID}:stuck`]);
  });

  it("rebuilds in full when a full rebuild is owed, rather than only swapping the product", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const user = seedUser(db, "fay");
    await syncProductLink(ctx, await connection(db), user, { db, nowMs: NOW });
    // A launch sign-up arrived and its sync failed: the record owes a rebuild.
    seedSignup(db, "sig_fay", { email: "fay@customer.test" });
    await markNeedsSync(ctx, "fay@customer.test", db);
    await syncProductLink(ctx, await connection(db), user, { db, nowMs: NOW });
    expect(person(db, "fay@customer.test")).toMatchObject({ needsSync: false, campaignIds: ["camp1"] });
  });

  it("does nothing for a sandbox", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const user = seedUser(db, "eli");
    expect(await syncProductLink(ctx, { ...(await connection(db)), kind: "sandbox" }, user, { db, nowMs: NOW })).toBeNull();
    expect(person(db, "eli@customer.test")).toBeUndefined();
  });
});
