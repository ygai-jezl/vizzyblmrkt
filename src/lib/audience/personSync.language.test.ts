import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { CONNECTION_ID, T0, TENANT_ID, ctx, seedUser, seedWorld } from "@/lib/lifecycle/testing/fixtures";
import type { Contact, ContactCampaignLink, PersonProductLink } from "@/lib/types/contact";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { Signup } from "@/lib/types/signup";
import { personIdOf, syncPerson, syncProductLink } from "./personSync";
import { languageOf, summarize } from "./personLinks";

/** A person's language (LANGUAGE_READERS_ENABLED). Addresses are .test. */

const NOW = T0 + 3_600_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();

function on() {
  vi.stubEnv("LANGUAGE_READERS_ENABLED", "true");
  vi.stubEnv("CONTENT_LANGUAGE_ENABLED", "true");
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
}

function seedSignup(db: FakeFirestore, id: string, over: Partial<Signup> = {}) {
  db.seed("signups", id, {
    tenantId: TENANT_ID,
    campaignId: "camp1",
    email: "ada@customer.test",
    phone: null,
    firstName: "Ada",
    lastName: "Lovelace",
    verified: true,
    captchaValid: true,
    isSpam: false,
    status: "verified_active",
    amountReferred: 0,
    referralToken: `ref_${id}`,
    referralLink: `https://example.test/r/${id}`,
    score: 0,
    createdAt: at(0),
    ...over,
  });
}

function person(db: FakeFirestore, key = "ada@customer.test"): Contact | undefined {
  const raw = db.raw("contacts", personIdOf(TENANT_ID, key));
  return raw ? ({ id: personIdOf(TENANT_ID, key), ...raw } as Contact) : undefined;
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe("languageOf", () => {
  const launch = (joinedAt: string, locale?: string) => ({ joinedAt, locale }) as ContactCampaignLink;
  const product = (signedUpAt: string, locale?: string, lastActiveAt: string | null = null) =>
    ({ signedUpAt, lastActiveAt, locale }) as PersonProductLink;

  it("takes the newest source that has a language", () => {
    expect(languageOf([launch(at(0), "fr"), launch(at(10), "de")], [])).toBe("de");
    expect(languageOf([launch(at(10), "fr")], [product(at(0), "es")])).toBe("fr");
    expect(languageOf([launch(at(0), "fr")], [product(at(10), "es")])).toBe("es");
  });

  it("times a product by its last activity, then its sign up", () => {
    expect(languageOf([launch(at(10), "fr")], [product(at(0), "es", at(20))])).toBe("es");
  });

  it("skips sources with no language and gives the product a tie", () => {
    expect(languageOf([launch(at(10))], [product(at(0), "es")])).toBe("es");
    expect(languageOf([launch(at(5), "fr")], [product(at(5), "es")])).toBe("es");
    expect(languageOf([launch(at(0))], [])).toBeNull();
  });
});

describe("summarize", () => {
  const live = { campaignId: "camp1", signupId: "sig_1", status: "verified_active", joinedAt: at(0), locale: "fr" } as ContactCampaignLink;

  it("has no language key while the switch is off", () => {
    expect("language" in summarize([live], [], undefined)).toBe(false);
  });

  it("gives the language while live, and null once they leave Everyone", () => {
    on();
    expect(summarize([live], [], undefined).language).toBe("fr");
    expect(summarize([{ ...live, status: "deleted" }], [], undefined).language).toBeNull();
  });
});

describe("syncPerson and a person's language", () => {
  it("writes nothing new while the switch is off", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedSignup(db, "sig_1", { locale: "fr" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW });
    const p = person(db)!;
    expect("language" in p).toBe(false);
    expect("locale" in p.campaigns[0]!).toBe(false);
  });

  it("keeps the sign up's language on its link and the person", async () => {
    on();
    const db = new FakeFirestore();
    seedWorld(db);
    seedSignup(db, "sig_1", { locale: "fr-FR" });
    expect((await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW })).outcome).toBe("created");
    const p = person(db)!;
    expect(p.campaigns[0]!.locale).toBe("fr");
    expect(p.language).toBe("fr");
    // Nothing changed: nothing is written.
    expect((await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW })).outcome).toBe("unchanged");
  });

  it("takes a newer product's language over an older sign up's", async () => {
    on();
    const db = new FakeFirestore();
    seedWorld(db);
    seedSignup(db, "sig_1", { locale: "fr", createdAt: at(-1000) });
    seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test", locale: "de", firstSeenAt: at(0) });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW });
    expect(person(db)!.language).toBe("de");
  });

  it("fills in the language of someone synced before the switch was on", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedSignup(db, "sig_1", { locale: "es" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW });
    on();
    expect((await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW })).outcome).toBe("updated");
    expect(person(db)!.language).toBe("es");
  });

  it("follows a product user who changes language, on the fast path", async () => {
    on();
    const db = new FakeFirestore();
    seedWorld(db);
    const user = seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test", locale: "fr" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW });
    expect(person(db)!.language).toBe("fr");
    const connection = { id: CONNECTION_ID, ...(db.raw("product_connections", CONNECTION_ID) as object) } as ProductConnection;
    const res = await syncProductLink(ctx, connection, { ...user, locale: "ja" }, { db, nowMs: NOW });
    expect(res?.outcome).toBe("updated");
    expect(person(db)!.language).toBe("ja");
    expect(person(db)!.products?.[0]?.locale).toBe("ja");
  });

  it("clears the language when their last sign up goes", async () => {
    on();
    const db = new FakeFirestore();
    seedWorld(db);
    seedSignup(db, "sig_1", { locale: "fr" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW });
    db.seed("signups", "sig_1", { ...(db.raw("signups", "sig_1") as object), status: "deleted" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: NOW });
    expect(person(db)?.language ?? null).toBeNull();
  });
});
