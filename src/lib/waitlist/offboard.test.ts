import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import type { Signup } from "@/lib/types/signup";
import { upsertContactFromSignup } from "@/lib/crm/contactService";
import { offboardSignup } from "./offboard";

const ctx: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };

function signup(over: Partial<Signup> = {}): Signup {
  return {
    id: "sig_1",
    tenantId: "ten_a",
    campaignId: "camp1",
    firstName: "Jo",
    lastName: "Bloggs",
    email: "jo@acme.test",
    phone: null,
    verified: true,
    captchaValid: true,
    isSpam: false,
    status: "verified_active",
    amountReferred: 0,
    referralToken: "ref_1",
    referralLink: "https://x/ref",
    score: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...over,
  } as Signup;
}

async function seeded() {
  const db = new FakeFirestore();
  const s = signup();
  const { id: _i, tenantId: _t, ...rest } = s;
  db.seed("signups", s.id, { ...rest, tenantId: "ten_a" });
  await upsertContactFromSignup(ctx, {} as Campaign, s, { db, now: "t0" });
  return { db, s };
}

describe("offboardSignup", () => {
  it("an admin offboard: status, reason, contact flag and the offboarding email", async () => {
    const { db, s } = await seeded();
    await offboardSignup(ctx, s, { reason: "manual", notify: true, now: "2026-09-24T10:00:00.000Z", db });
    expect(db.raw("signups", s.id)).toMatchObject({
      status: "offboarded",
      removedDate: "2026-09-24T10:00:00.000Z",
      offboardReason: "manual",
    });
    expect(db.dump("contacts")[0]).toMatchObject({ status: "offboarded" });
    expect(db.raw("email_jobs", `offboard:${s.id}`)).toMatchObject({ type: "lifecycle", payload: { signupId: s.id } });
  });

  it("an invite: records the invite and sends no offboarding email", async () => {
    const { db, s } = await seeded();
    await offboardSignup(ctx, s, { reason: "invited", inviteId: "inv_1", notify: false, db });
    expect(db.raw("signups", s.id)).toMatchObject({ status: "offboarded", offboardReason: "invited", inviteId: "inv_1" });
    expect(db.dump("email_jobs")).toHaveLength(0);
  });
});
