import { describe, it, expect } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { suppressEmail, suppressEmailCategory } from "@/lib/email/suppression";
import { ctx, seedUser, seedWorld, system } from "@/lib/lifecycle/testing/fixtures";
import { loadAudiencePeople } from "./people";

describe("loadAudiencePeople", () => {
  it("knows who can't be emailed for everyone in the list, opt-outs made in our emails included", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const fine = seedUser(db, "alex");
    const bounced = seedUser(db, "bea");
    const complained = seedUser(db, "cal");
    const oneCategory = seedUser(db, "dee");
    const optedOutInProduct = seedUser(db, "eli", { subscribed: false });
    await suppressEmail(system, { email: bounced.email!, reason: "hard_bounce", source: "mandrill-hard_bounce" }, db);
    await suppressEmail(system, { email: complained.email!, reason: "spam", source: "mandrill-spam" }, db);
    await suppressEmailCategory(system, { email: oneCategory.email!, category: "onboarding", source: "list-unsubscribe" }, db);

    const { people, truncated } = await loadAudiencePeople(ctx, { db });
    expect(truncated).toBe(false);
    const reach = Object.fromEntries(people.map((p) => [p.id, p.reach]));
    expect(reach[fine.id]).toMatchObject({ can: "yes", blocked: null });
    expect(reach[bounced.id]).toMatchObject({ can: "no", blocked: "bounced" });
    expect(reach[complained.id]).toMatchObject({ can: "no", blocked: "complained" });
    expect(reach[oneCategory.id]).toMatchObject({ can: "limited", optedOutOf: ["onboarding"] });
    expect(reach[optedOutInProduct.id]).toMatchObject({ can: "no", blocked: "opted_out_in_product" });
    // Nobody from another brand.
    expect((await loadAudiencePeople({ ...ctx, tenantId: "ten_other" }, { db })).people).toEqual([]);
  });
});
