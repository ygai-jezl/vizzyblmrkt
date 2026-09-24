import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { invitedProductUsers, withInviteStages } from "./audience";
import { ctx } from "./testing/fixtures";

describe("invite stages on Audience", () => {
  it("shows each person's furthest stage across launches, and which product users were invited", async () => {
    const db = new FakeFirestore();
    const inv = (id: string, over: Record<string, unknown>) =>
      db.seed("invites", id, { tenantId: "ten_A", invited: true, signedUp: false, activated: false, ...over });
    inv("i1", { signupId: "sig_a1", productUserId: null });
    inv("i2", { signupId: "sig_a2", signedUp: true, productUserId: "pu_a" });
    inv("i3", { signupId: "sig_b1", invited: false });
    const rows = await withInviteStages(
      ctx,
      [
        { id: "a", campaigns: [{ signupId: "sig_a1" }, { signupId: "sig_a2" }] },
        { id: "b", campaigns: [{ signupId: "sig_b1" }] },
        { id: "c", campaigns: [] },
      ],
      db,
    );
    expect(rows.map((r) => r.invite)).toEqual(["signed_up", null, null]);
    expect([...(await invitedProductUsers(ctx, ["pu_a", "pu_x"], db))]).toEqual(["pu_a"]);
  });
});
