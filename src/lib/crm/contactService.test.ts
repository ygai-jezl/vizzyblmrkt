import { describe, it, expect } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import type { Signup } from "@/lib/types/signup";
import {
  upsertContactFromSignup,
  recordSignupContactStatus,
  recomputeContactStatus,
} from "./contactService";

const ctx: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };
const campaign = {} as Campaign; // contactService ignores the campaign body

let seq = 0;
function makeSignup(over: Partial<Signup> = {}): Signup {
  seq += 1;
  return {
    id: over.id ?? `sig_${seq}`,
    tenantId: "ten_a",
    campaignId: over.campaignId ?? "camp1",
    firstName: "Jo",
    lastName: "Bloggs",
    email: "jo@acme.com",
    phone: null,
    verified: true,
    captchaValid: true,
    isSpam: false,
    status: "verified_active",
    amountReferred: 0,
    referralToken: `ref_${seq}`,
    referralLink: "https://x/ref",
    score: 0,
    createdAt: `2026-03-0${seq}`,
    ...over,
  } as Signup;
}

describe("upsertContactFromSignup", () => {
  it("creates a corporate contact and asks to enrich", async () => {
    const db = new FakeFirestore();
    const r = await upsertContactFromSignup(ctx, campaign, makeSignup(), { db, now: "t0" });
    expect(r).not.toBeNull();
    expect(r!.created).toBe(true);
    expect(r!.shouldEnrich).toBe(true);
    expect(r!.contact.isCorporateDomain).toBe(true);
    expect(r!.contact.emailDomain).toBe("acme.com");
    expect(r!.contact.enrichment.status).toBe("pending");
    expect(r!.contact.consentStatus).toBe("verified_active");
    expect(r!.contact.companyId).toBeTruthy();
  });

  it("is idempotent for the same campaign (re-submit merges, one link)", async () => {
    const db = new FakeFirestore();
    const s = makeSignup({ id: "sig_x" });
    await upsertContactFromSignup(ctx, campaign, s, { db, now: "t0" });
    const r2 = await upsertContactFromSignup(ctx, campaign, s, { db, now: "t1" });
    expect(r2!.created).toBe(false);
    expect(r2!.contact.campaigns).toHaveLength(1);
    expect(r2!.contact.campaignIds).toEqual(["camp1"]);
  });

  it("dedupes the same person across campaigns into ONE contact with two links", async () => {
    const db = new FakeFirestore();
    await upsertContactFromSignup(ctx, campaign, makeSignup({ campaignId: "camp1" }), { db });
    const r = await upsertContactFromSignup(
      ctx,
      campaign,
      makeSignup({ campaignId: "camp2", amountReferred: 3 }),
      { db },
    );
    expect(r!.contact.campaigns).toHaveLength(2);
    expect(new Set(r!.contact.campaignIds)).toEqual(new Set(["camp1", "camp2"]));
    expect(r!.contact.totalReferred).toBe(3);
  });

  it("skips enrichment for free email providers", async () => {
    const db = new FakeFirestore();
    const r = await upsertContactFromSignup(
      ctx,
      campaign,
      makeSignup({ email: "jo@gmail.com" }),
      { db },
    );
    expect(r!.contact.isCorporateDomain).toBe(false);
    expect(r!.shouldEnrich).toBe(false);
    expect(r!.contact.enrichment.status).toBe("skipped");
  });

  it("holds unverified signups without enriching, then promotes on verify", async () => {
    const db = new FakeFirestore();
    const r1 = await upsertContactFromSignup(
      ctx,
      campaign,
      makeSignup({ id: "sig_u", status: "unverified", verified: false }),
      { db, now: "t0" },
    );
    expect(r1!.shouldEnrich).toBe(false);
    expect(r1!.contact.consentStatus).toBe("unverified_signup");
    expect(r1!.contact.enrichment.status).toBe("none"); // corporate but not yet verified

    // Same person verifies → re-upsert promotes to pending + asks to enrich.
    const r2 = await upsertContactFromSignup(
      ctx,
      campaign,
      makeSignup({ id: "sig_u", status: "verified_active", verified: true }),
      { db, now: "t1" },
    );
    expect(r2!.created).toBe(false);
    expect(r2!.shouldEnrich).toBe(true);
    expect(r2!.contact.verified).toBe(true);
    expect(r2!.contact.consentStatus).toBe("verified_active");
    expect(r2!.contact.enrichment.status).toBe("pending");
  });

  it("keeps phone-only contacts (no enrichment) and returns null with no key", async () => {
    const db = new FakeFirestore();
    const phoneOnly = await upsertContactFromSignup(
      ctx,
      campaign,
      makeSignup({ email: null, phone: "+15551234" }),
      { db },
    );
    expect(phoneOnly!.contact.contactKey).toBe("+15551234");
    expect(phoneOnly!.shouldEnrich).toBe(false);

    const nothing = await upsertContactFromSignup(
      ctx,
      campaign,
      makeSignup({ email: null, phone: null }),
      { db },
    );
    expect(nothing).toBeNull();
  });
});

describe("recomputeContactStatus", () => {
  it("is active while any link is live, else offboarded, else deleted", () => {
    expect(recomputeContactStatus([{ status: "verified_active" }])).toBe("active");
    expect(recomputeContactStatus([{ status: "unverified" }])).toBe("active");
    expect(
      recomputeContactStatus([{ status: "offboarded" }, { status: "verified_active" }]),
    ).toBe("active");
    expect(
      recomputeContactStatus([{ status: "offboarded" }, { status: "offboarded" }]),
    ).toBe("offboarded");
    expect(recomputeContactStatus([])).toBe("deleted");
  });
});

describe("recordSignupContactStatus", () => {
  it("flags the contact offboarded but RETAINS it (record + email kept)", async () => {
    const db = new FakeFirestore();
    const s = makeSignup({ id: "sig_off", campaignId: "camp1" });
    await upsertContactFromSignup(ctx, campaign, s, { db, now: "t0" });

    const updated = await recordSignupContactStatus(
      ctx,
      { ...s, status: "offboarded" },
      { db, now: "t1" },
    );
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("offboarded");
    expect(updated!.campaigns[0]!.status).toBe("offboarded");
    expect(updated!.email).toBe("jo@acme.com"); // still reachable in the CRM

    // Persisted (not just the returned copy).
    const fetched = await upsertContactFromSignup(
      ctx,
      campaign,
      { ...s, status: "offboarded" },
      { db, now: "t2" },
    );
    expect(fetched!.contact.status).toBe("offboarded");
  });

  it("stays active when another campaign link is still live (multi-campaign)", async () => {
    const db = new FakeFirestore();
    const c1 = makeSignup({ id: "s_c1", campaignId: "camp1" });
    const c2 = makeSignup({ id: "s_c2", campaignId: "camp2" });
    await upsertContactFromSignup(ctx, campaign, c1, { db, now: "t0" });
    await upsertContactFromSignup(ctx, campaign, c2, { db, now: "t0" });

    const updated = await recordSignupContactStatus(
      ctx,
      { ...c1, status: "offboarded" },
      { db, now: "t1" },
    );
    expect(updated!.status).toBe("active"); // camp2 link still verified_active
    expect(updated!.campaigns).toHaveLength(2);
  });

  it("removes the link on delete and recomputes status, keeping the doc", async () => {
    const db = new FakeFirestore();
    const s = makeSignup({ id: "sig_del", campaignId: "camp1" });
    await upsertContactFromSignup(ctx, campaign, s, { db, now: "t0" });

    const updated = await recordSignupContactStatus(ctx, s, {
      remove: true,
      db,
      now: "t1",
    });
    expect(updated!.campaigns).toHaveLength(0);
    expect(updated!.status).toBe("deleted");
  });

  it("no-ops (returns null) when the person has no contact", async () => {
    const db = new FakeFirestore();
    const r = await recordSignupContactStatus(
      ctx,
      makeSignup({ email: "ghost@acme.com", status: "offboarded" }),
      { db },
    );
    expect(r).toBeNull();
  });
});
