import { describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { EmailJob } from "@/lib/types/emailJob";
import { processContactEraseJob } from "./eraseWorker";

// The external audience is out of scope here (and reads the tenant registry directly).
vi.mock("@/lib/mailchimp", () => ({ removeSignupFromAudience: vi.fn(async () => ({ ok: true })) }));

/**
 * The GDPR erase cascade reaches everything keyed by the person's signups:
 * engagement events, invites, and their progress through waitlist journeys on
 * the lifecycle engine (engine move), then the signups themselves, on every
 * launch. Addresses are example.test; phone numbers are from Ofcom's drama range.
 */

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const job = { id: "erase_1", payload: { contactId: "ct_1" } } as unknown as EmailJob;

describe("processContactEraseJob", () => {
  it("erases the person's events, invites and waitlist journey progress, and nobody else's", async () => {
    const db = new FakeFirestore();
    db.seed("contacts", "ct_1", { tenantId: "ten_A", email: "ada@example.test", companyId: null, campaigns: [{ campaignId: "camp1", signupId: "s1" }] });
    db.seed("signups", "s1", { tenantId: "ten_A", campaignId: "camp1", email: "ada@example.test", firstName: "Ada" });
    db.seed("signups", "s2", { tenantId: "ten_A", campaignId: "camp1", email: "bob@example.test", firstName: "Bob" });
    db.seed("email_events", "ev1", { tenantId: "ten_A", signupId: "s1", journeyId: "j" });
    db.seed("invites", "inv1", { tenantId: "ten_A", signupId: "s1" });
    db.seed("waitlist_enrolments", "enr_1", { tenantId: "ten_A", signupId: "s1", campaignId: "camp1" });
    db.seed("waitlist_enrolments", "enr_2", { tenantId: "ten_A", signupId: "s2", campaignId: "camp1" });
    expect(await processContactEraseJob(ctx, job, db)).toBe("done");
    expect(db.raw("contacts", "ct_1")).toBeUndefined();
    expect(db.raw("email_events", "ev1")).toBeUndefined();
    expect(db.raw("invites", "inv1")).toBeUndefined();
    expect(db.raw("waitlist_enrolments", "enr_1")).toBeUndefined();
    expect(db.raw("waitlist_enrolments", "enr_2")).toBeDefined();
    expect(db.raw("signups", "s1")).toBeUndefined();
    expect(db.raw("signups", "s2")).toBeDefined();
  });

  it("erases their sign-ups on every launch, including ones the contact doesn't link yet", async () => {
    const db = new FakeFirestore();
    db.seed("contacts", "ct_1", { tenantId: "ten_A", email: "Ada@Example.test", companyId: null, campaigns: [{ campaignId: "camp1", signupId: "s1" }] });
    db.seed("signups", "s1", { tenantId: "ten_A", campaignId: "camp1", email: "ada@example.test" });
    // An unconfirmed sign-up from the brand's own site: it joins the contact only on confirm.
    db.seed("signups", "s3", { tenantId: "ten_A", campaignId: "camp2", email: "ada@example.test", status: "unverified", joinedVia: "site" });
    db.seed("email_events", "ev3", { tenantId: "ten_A", signupId: "s3", type: "send" });
    // The same address on another brand belongs to that brand.
    db.seed("signups", "other", { tenantId: "ten_B", campaignId: "campB", email: "ada@example.test" });
    expect(await processContactEraseJob(ctx, job, db)).toBe("done");
    expect(db.raw("signups", "s1")).toBeUndefined();
    expect(db.raw("signups", "s3")).toBeUndefined();
    expect(db.raw("email_events", "ev3")).toBeUndefined();
    expect(db.raw("signups", "other")).toBeDefined();
  });

  it("keeps their opt-outs holding, with the address blanked", async () => {
    const db = new FakeFirestore();
    db.seed("contacts", "ct_1", { tenantId: "ten_A", email: "ada@example.test", companyId: null, campaigns: [] });
    db.seed("email_suppressions", "sup_ada", { tenantId: "ten_A", email: "ada@example.test", normalizedEmail: "ada@example.test", reason: "unsubscribe", scope: "all" });
    db.seed("email_suppressions", "sup_bob", { tenantId: "ten_A", email: "bob@example.test", normalizedEmail: "bob@example.test", reason: "unsubscribe", scope: "all" });
    expect(await processContactEraseJob(ctx, job, db)).toBe("done");
    expect(db.raw("email_suppressions", "sup_ada")).toMatchObject({ email: "", normalizedEmail: "", reason: "unsubscribe" });
    expect(db.raw("email_suppressions", "sup_bob")).toMatchObject({ normalizedEmail: "bob@example.test" });
  });

  it("finds a phone-only person's sign-ups by their phone", async () => {
    const db = new FakeFirestore();
    db.seed("contacts", "ct_1", { tenantId: "ten_A", email: null, phone: "+447700900123", companyId: null, campaigns: [] });
    db.seed("signups", "p1", { tenantId: "ten_A", campaignId: "camp1", email: null, phone: "+447700900123" });
    db.seed("signups", "p2", { tenantId: "ten_A", campaignId: "camp1", email: null, phone: "+447700900456" });
    expect(await processContactEraseJob(ctx, job, db)).toBe("done");
    expect(db.raw("signups", "p1")).toBeUndefined();
    expect(db.raw("signups", "p2")).toBeDefined();
  });

  it("finishes a retry after a partial run, when some sign-ups are already gone", async () => {
    const db = new FakeFirestore();
    db.seed("contacts", "ct_1", {
      tenantId: "ten_A",
      email: "ada@example.test",
      companyId: null,
      campaigns: [{ campaignId: "camp1", signupId: "gone" }, { campaignId: "camp2", signupId: "s2" }],
    });
    db.seed("signups", "s2", { tenantId: "ten_A", campaignId: "camp2", email: "ada@example.test" });
    expect(await processContactEraseJob(ctx, job, db)).toBe("done");
    expect(db.raw("signups", "s2")).toBeUndefined();
    expect(db.raw("contacts", "ct_1")).toBeUndefined();
    expect(await processContactEraseJob(ctx, job, db)).toBe("done");
  });
});
