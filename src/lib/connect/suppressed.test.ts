import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { CONNECTION_ID, seedUser, seedWorld, system } from "@/lib/lifecycle/testing/fixtures";
import { notifyProductOfSuppression } from "./suppressed";

function world() {
  const db = new FakeFirestore();
  seedWorld(db);
  const user = seedUser(db, "alex");
  const queued = () => forTenant(system, db).lifecycleWebhooks.find({ limit: 10 });
  return { db, user, queued };
}

describe("the email.suppressed webhook", () => {
  it("queues one webhook to the user's own connection, with the product's user id", async () => {
    const w = world();
    const spam = { connectionId: CONNECTION_ID, productUserId: w.user.id, reason: "spam" as const };
    expect(await notifyProductOfSuppression(system, spam, w.db)).toBe("queued");
    expect(await w.queued()).toMatchObject([
      { connectionId: CONNECTION_ID, type: "email.suppressed", data: { userId: "alex", reason: "complaint" }, status: "pending" },
    ]);
    expect(await notifyProductOfSuppression(system, spam, w.db)).toBe("duplicate"); // the same cause is one webhook
    expect(await notifyProductOfSuppression(system, { ...spam, reason: "hard_bounce" }, w.db)).toBe("queued");
    expect((await w.queued()).map((q) => q.data.reason).sort()).toEqual(["complaint", "hard_bounce"]);
  });

  it("sends nothing for a user YouGrow doesn't hold on that connection", async () => {
    const w = world();
    expect(await notifyProductOfSuppression(system, { connectionId: "pcn_other", productUserId: w.user.id, reason: "spam" }, w.db)).toBe("skipped");
    expect(await notifyProductOfSuppression(system, { connectionId: CONNECTION_ID, productUserId: "pu_nobody", reason: "spam" }, w.db)).toBe("skipped");
    expect(await w.queued()).toEqual([]);
  });
});
