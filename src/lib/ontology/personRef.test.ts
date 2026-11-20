import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertContactFromSignup } from "@/lib/crm/contactService";
import { productUserDocId } from "@/lib/connect/profile";
import { personIdOf } from "@/lib/audience/personSync";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import type { Signup } from "@/lib/types/signup";
import { isContactPersonId } from "./person";
import { personIdForAddress, personIdForProductUser, personIdForSignup, personStamp } from "./personRef";

const ctx: TenantContext = { tenantId: "ten_demo", region: "us", source: "system" };
const custom = { kind: "custom", status: "active" } as const;

function signup(over: Partial<Signup> = {}): Signup {
  return {
    id: "sig_1",
    tenantId: "ten_demo",
    campaignId: "camp1",
    firstName: "Ada",
    lastName: "Example",
    email: "ada@example.com",
    phone: null,
    verified: true,
    captchaValid: true,
    isSpam: false,
    status: "verified_active",
    amountReferred: 0,
    referralToken: "ref_1",
    referralLink: "https://example.com/ref",
    score: 0,
    createdAt: "2026-11-01T10:00:00.000Z",
    ...over,
  } as Signup;
}

describe("personIdForSignup, personIdForProductUser and personIdForAddress", () => {
  it("give one person for a sign-up and a product user with the same address, whatever its case and spaces", () => {
    const fromSignup = personIdForSignup("ten_demo", { email: "  Ada@Example.com ", phone: null });
    const fromUser = personIdForProductUser("ten_demo", { id: "pu_1", emailNormalized: "ada@example.com" }, custom);
    const fromAddress = personIdForAddress("ten_demo", "ADA@example.COM");
    expect(fromSignup).not.toBeNull();
    expect(isContactPersonId(fromSignup)).toBe(true);
    expect(fromUser).toBe(fromSignup);
    expect(fromAddress).toBe(fromSignup);
  });

  it("is the id of the person record a sign-up writes", async () => {
    const db = new FakeFirestore();
    const s = signup({ email: "Ada@Example.com" });
    const res = await upsertContactFromSignup(ctx, {} as Campaign, s, { db });
    expect(res?.contact.id).toBe(personIdForSignup("ten_demo", s));
  });

  it("finds a person for a sign-up that only gave a phone", async () => {
    const db = new FakeFirestore();
    const s = signup({ email: null as unknown as string, phone: " +15550100 " });
    const id = personIdForSignup("ten_demo", s);
    expect(isContactPersonId(id)).toBe(true);
    const res = await upsertContactFromSignup(ctx, {} as Campaign, s, { db });
    expect(res?.contact.id).toBe(id);
  });

  it("gives none for a sign-up with no address and no phone", () => {
    expect(personIdForSignup("ten_demo", { email: null as unknown as string, phone: null })).toBeNull();
    expect(personIdForAddress("ten_demo", "  ")).toBeNull();
    expect(personIdForAddress("ten_demo", null)).toBeNull();
  });

  it("gives a product user with no address their own pu: person", () => {
    const id = productUserDocId("conn_1", "user_1");
    const person = personIdForProductUser("ten_demo", { id, emailNormalized: null }, custom);
    expect(person).toBe(personIdOf("ten_demo", `pu:${id}`));
    expect(isContactPersonId(person)).toBe(true);
  });

  it("gives none for a sandbox, a revoked or missing product, or an erased user", () => {
    const user = { id: "pu_1", emailNormalized: "ada@example.com" };
    expect(personIdForProductUser("ten_demo", user, { kind: "sandbox", status: "active" })).toBeNull();
    expect(personIdForProductUser("ten_demo", user, { kind: "custom", status: "revoked" })).toBeNull();
    expect(personIdForProductUser("ten_demo", user, null)).toBeNull();
    expect(personIdForProductUser("ten_demo", { ...user, status: "deleted" }, custom)).toBeNull();
  });

  it("keeps brands apart: the same address is a different person in another brand", () => {
    expect(personIdForAddress("ten_demo", "ada@example.com")).not.toBe(personIdForAddress("ten_other", "ada@example.com"));
  });
});

describe("personStamp", () => {
  const id = personIdForAddress("ten_demo", "ada@example.com");

  afterEach(() => vi.unstubAllEnvs());

  it("stamps nothing while either switch is off", () => {
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "false");
    expect(personStamp(id)).toEqual({});
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "false");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
    expect(personStamp(id)).toEqual({});
  });

  describe("with both switches on", () => {
    beforeEach(() => {
      vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
      vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
    });

    it("stamps the person", () => {
      expect(personStamp(id)).toEqual({ personId: id });
    });

    it("stamps nothing when there is no person", () => {
      expect(personStamp(null)).toEqual({});
      expect(personStamp(undefined)).toEqual({});
    });
  });
});
