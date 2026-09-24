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
 * the lifecycle engine (engine move). Addresses are example.test.
 */

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };

describe("processContactEraseJob", () => {
  it("erases the person's events, invites and waitlist journey progress, and nobody else's", async () => {
    const db = new FakeFirestore();
    db.seed("contacts", "ct_1", { tenantId: "ten_A", email: "ada@example.test", companyId: null, campaigns: [{ campaignId: "camp1", signupId: "s1" }] });
    db.seed("email_events", "ev1", { tenantId: "ten_A", signupId: "s1", journeyId: "j" });
    db.seed("invites", "inv1", { tenantId: "ten_A", signupId: "s1" });
    db.seed("waitlist_enrolments", "enr_1", { tenantId: "ten_A", signupId: "s1", campaignId: "camp1" });
    db.seed("waitlist_enrolments", "enr_2", { tenantId: "ten_A", signupId: "s2", campaignId: "camp1" });
    const job = { id: "erase_1", payload: { contactId: "ct_1" } } as unknown as EmailJob;
    expect(await processContactEraseJob(ctx, job, db)).toBe("done");
    expect(db.raw("contacts", "ct_1")).toBeUndefined();
    expect(db.raw("email_events", "ev1")).toBeUndefined();
    expect(db.raw("invites", "inv1")).toBeUndefined();
    expect(db.raw("waitlist_enrolments", "enr_1")).toBeUndefined();
    expect(db.raw("waitlist_enrolments", "enr_2")).toBeDefined();
  });
});
