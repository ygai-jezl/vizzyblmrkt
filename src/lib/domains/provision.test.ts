import { describe, it, expect } from "vitest";
import { provisionWebRouting, revokeWebRouting } from "./provision";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { DomainOwnership } from "@/lib/types/tenant";

const NOW = "2026-06-18T20:00:00.000Z";
const ownership: DomainOwnership = {
  method: "email_match",
  verifiedAt: NOW,
  verifiedBy: "uid_admin",
  evidence: "acme.com",
};

function tenant(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantName: "Acme",
    rootDomain: "acme.com",
    status: "active",
    region: "us",
    allowedOrigins: [],
    billingTier: "mvp_free",
    ownerId: "uid_admin",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const okRegistrar = async () => ({ ok: true as const });

describe("provisionWebRouting", () => {
  it("adds the origin to allowedOrigins, registers reCAPTCHA, and audits", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_me", tenant());

    const res = await provisionWebRouting({
      tenantId: "ten_me",
      host: "acme.com",
      ownership,
      now: NOW,
      db,
      registrar: okRegistrar,
    });

    expect(res).toMatchObject({ ok: true, origin: "https://acme.com", allowedOriginsAdded: true });
    expect(db.raw("tenants", "ten_me")?.allowedOrigins).toContain("https://acme.com");
    // an audit row was written
    const grants = db.dump("domain_grants");
    expect(grants.length).toBe(1);
    expect(grants[0]).toMatchObject({ tenantId: "ten_me", host: "acme.com", action: "grant", method: "email_match" });
  });

  it("is idempotent on the allowlist (second call doesn't re-add)", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_me", tenant());
    await provisionWebRouting({ tenantId: "ten_me", host: "acme.com", ownership, now: NOW, db, registrar: okRegistrar });
    const second = await provisionWebRouting({ tenantId: "ten_me", host: "acme.com", ownership, now: NOW, db, registrar: okRegistrar });
    expect(second.allowedOriginsAdded).toBe(false);
    expect(db.raw("tenants", "ten_me")?.allowedOrigins).toEqual(["https://acme.com"]);
  });

  it("refuses a reserved host without touching the allowlist", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_me", tenant());
    const res = await provisionWebRouting({ tenantId: "ten_me", host: "localhost", ownership, now: NOW, db, registrar: okRegistrar });
    expect(res).toMatchObject({ ok: false, reason: "reserved_host" });
    expect(db.raw("tenants", "ten_me")?.allowedOrigins).toEqual([]);
  });

  it("refuses an origin already owned by another tenant", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_me", tenant());
    db.seed("tenants", "ten_other", tenant({ allowedOrigins: ["https://acme.com"] }));
    const res = await provisionWebRouting({ tenantId: "ten_me", host: "acme.com", ownership, now: NOW, db, registrar: okRegistrar });
    expect(res).toMatchObject({ ok: false, reason: "origin_conflict" });
  });

  it("still routes (allowlist added) when reCAPTCHA registration fails", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_me", tenant());
    const res = await provisionWebRouting({
      tenantId: "ten_me",
      host: "acme.com",
      ownership,
      now: NOW,
      db,
      registrar: async () => ({ ok: false, reason: "cap_reached" }),
    });
    expect(res.ok).toBe(true);
    expect(res.allowedOriginsAdded).toBe(true);
    expect(res.recaptcha).toMatchObject({ ok: false, reason: "cap_reached" });
  });
});

describe("revokeWebRouting", () => {
  it("removes the origin and audits the revoke", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_me", tenant({ allowedOrigins: ["https://acme.com"] }));
    const res = await revokeWebRouting({ tenantId: "ten_me", host: "acme.com", now: NOW, actorUid: "uid_admin", db });
    expect(res.removed).toBe(true);
    expect(db.raw("tenants", "ten_me")?.allowedOrigins).toEqual([]);
    expect(db.dump("domain_grants").some((g) => g.action === "revoke")).toBe(true);
  });
});
