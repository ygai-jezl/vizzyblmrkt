import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { CONNECTION_ID, T0, TENANT_ID, ctx, seedUser, seedWorld } from "@/lib/lifecycle/testing/fixtures";
import { inviteDocId } from "@/lib/invites/ids";
import { waitlistEnrolmentId, waitlistJourneyId } from "@/lib/lifecycle/waitlist/ids";
import { personIdOf, syncPerson } from "./personSync";
import { loadWholePerson } from "./wholePerson";

/** One whole person, from made-up people at .test. */

describe("loadWholePerson", () => {
  it("brings their launches (with invite and waitlist journey) and their products together", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    db.seed("campaigns", "camp1", { tenantId: TENANT_ID, waitlistName: "Beta waitlist" });
    db.seed("signups", "s_ada", {
      tenantId: TENANT_ID,
      campaignId: "camp1",
      email: "ada@customer.test",
      firstName: "Ada",
      status: "verified_active",
      amountReferred: 3,
      referralToken: "r",
      referralLink: "https://example.test/r",
      score: 0,
      joinedVia: "site",
      createdAt: new Date(T0).toISOString(),
    });
    db.seed("invites", inviteDocId("camp1", "s_ada"), { tenantId: TENANT_ID, campaignId: "camp1", signupId: "s_ada", invited: true, signedUp: true, activated: false });
    db.seed("waitlist_enrolments", waitlistEnrolmentId(waitlistJourneyId("camp1"), "s_ada"), {
      tenantId: TENANT_ID,
      signupId: "s_ada",
      status: "active",
      sentItems: [{ nodeId: "n1" }, { nodeId: "n2" }],
    });
    seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: T0 });

    const id = personIdOf(TENANT_ID, "ada@customer.test");
    const p = (await loadWholePerson(ctx, id, db))!;
    expect(p).toMatchObject({ id, name: "Ada", email: "ada@customer.test", reach: "yes" });
    expect(p.launches).toEqual([
      expect.objectContaining({ campaignId: "camp1", name: "Beta waitlist", status: "verified_active", via: "site", referrals: 3, invite: "signed_up", journey: { status: "active", sent: 2 } }),
    ]);
    expect(p.products).toEqual([expect.objectContaining({ connectionId: CONNECTION_ID, name: "Sandbox", stage: "new" })]);
    expect(await loadWholePerson({ ...ctx, tenantId: "ten_other" }, id, db)).toBeNull();
  });
});
