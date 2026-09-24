import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { inviteProgressLine, loadFunnel } from "./funnel";
import { ctx, seedSignup } from "./testing/fixtures";

describe("launch funnel", () => {
  it("counts each stage for a launch, a wave, or the whole brand", async () => {
    const db = new FakeFirestore();
    seedSignup(db, "s1");
    seedSignup(db, "s2");
    seedSignup(db, "s3", { verified: false, status: "unverified" });
    seedSignup(db, "s4", { status: "deleted" });
    seedSignup(db, "o1", { campaignId: "other" });
    const inv = (id: string, over: Record<string, unknown>) =>
      db.seed("invites", id, { tenantId: "ten_A", campaignId: "beta", waveId: "w1", invited: true, signedUp: false, activated: false, ...over });
    inv("i1", { signedUp: true, activated: true });
    inv("i2", { signedUp: true });
    inv("i3", { waveId: "w2" });
    inv("i4", { invited: false });

    expect(await loadFunnel(ctx, { campaignId: "beta" }, db)).toEqual({ waitlisted: 3, verified: 2, invited: 3, signedUp: 2, activated: 1 });
    expect(await loadFunnel(ctx, { campaignId: "beta", waveId: "w2" }, db)).toMatchObject({ invited: 1, signedUp: 0 });
    expect(await loadFunnel(ctx, {}, db)).toMatchObject({ waitlisted: 4 });
    expect(inviteProgressLine({ invited: 1300, signedUp: 212 })).toBe("1,300 invited · 212 signed up");
  });
});
