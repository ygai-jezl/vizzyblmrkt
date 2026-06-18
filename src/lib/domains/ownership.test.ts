import { describe, it, expect } from "vitest";
import {
  tryEmailFastPath,
  issueDnsTxtToken,
  dnsChallengeRecord,
  verifyDnsTxt,
  globalOriginConflict,
} from "./ownership";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

describe("tryEmailFastPath", () => {
  const verified = (email: string) => ({ email, emailVerified: true });

  it("approves a verified email matching the claimed domain (eTLD+1)", () => {
    expect(tryEmailFastPath("acme.com", verified("jez@acme.com"))).toMatchObject({
      ok: true,
      evidence: "acme.com",
    });
    // subdomain email still matches the registrable domain
    expect(tryEmailFastPath("acme.com", verified("jez@mail.acme.com")).ok).toBe(true);
  });

  it("rejects an unverified email", () => {
    expect(
      tryEmailFastPath("acme.com", { email: "jez@acme.com", emailVerified: false }),
    ).toMatchObject({ ok: false, reason: "email_unverified" });
  });

  it("rejects public email providers even on an exact match", () => {
    expect(tryEmailFastPath("gmail.com", verified("attacker@gmail.com"))).toMatchObject({
      ok: false,
      reason: "public_provider",
    });
  });

  it("rejects a domain mismatch", () => {
    expect(tryEmailFastPath("victim.com", verified("jez@acme.com"))).toMatchObject({
      ok: false,
      reason: "domain_mismatch",
    });
  });
});

describe("DNS-TXT challenge", () => {
  it("issues a unguessable token and a well-formed record", () => {
    const token = issueDnsTxtToken();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    const rec = dnsChallengeRecord("www.acme.com", token);
    expect(rec).toEqual({
      type: "TXT",
      host: "_vizzybl-challenge.acme.com",
      value: `vizzybl-site-verification=${token}`,
    });
  });

  it("verifies only when the published TXT carries the token", async () => {
    const token = "tok123";
    const value = `vizzybl-site-verification=${token}`;
    const ok = await verifyDnsTxt("acme.com", token, async () => [["other"], [value]]);
    expect(ok.ok).toBe(true);
    const miss = await verifyDnsTxt("acme.com", token, async () => [["nope"]]);
    expect(miss).toMatchObject({ ok: false, detail: "txt_not_found" });
  });

  it("treats a missing record as not-found, other DNS errors as dns_error", async () => {
    const notFound = await verifyDnsTxt("acme.com", "t", async () => {
      throw Object.assign(new Error("x"), { code: "ENOTFOUND" });
    });
    expect(notFound).toMatchObject({ ok: false, detail: "txt_not_found" });
  });
});

describe("globalOriginConflict", () => {
  function tenant(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      tenantName: "Other",
      rootDomain: "other.com",
      status: "active",
      region: "us",
      allowedOrigins: ["https://acme.com"],
      billingTier: "mvp_free",
      ownerId: "u",
      createdAt: "2026-06-15T16:00:00Z",
      updatedAt: "2026-06-15T16:00:00Z",
      ...over,
    };
  }

  it("flags an origin already owned by a DIFFERENT tenant", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_other", tenant());
    expect(await globalOriginConflict("https://acme.com", "ten_me", db)).toBe(true);
  });

  it("allows re-claiming an origin the SAME tenant already holds", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_me", tenant());
    expect(await globalOriginConflict("https://acme.com", "ten_me", db)).toBe(false);
  });

  it("allows a brand-new origin", async () => {
    const db = new FakeFirestore();
    expect(await globalOriginConflict("https://acme.com", "ten_me", db)).toBe(false);
  });
});
