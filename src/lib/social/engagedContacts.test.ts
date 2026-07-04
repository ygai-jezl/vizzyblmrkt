import { describe, it, expect } from "vitest";
import { upsertEngagedContact } from "./engagedContacts";
import { deterministicContactId } from "@/lib/crm/identifiers";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";

const ctx: TenantContext = { tenantId: "ten_1", region: "us", source: "system" };
const COLLECTION = "social_engaged";
const idFor = (userId: string) => deterministicContactId("ten_1", `engaged:x:${userId}`);

describe("upsertEngagedContact", () => {
  it("creates an engaged record in social_engaged (never in contacts)", async () => {
    const db = new FakeFirestore();
    const r = await upsertEngagedContact(
      ctx,
      { platform: "x", userId: "99", handle: "someone", name: "Some One", engagedAt: "2026-07-01T00:00:00Z" },
      db,
    );
    expect(r).toBe("created");
    expect(db.dump("contacts")).toHaveLength(0); // MUST NOT pollute the email CRM
    const raw = db.raw(COLLECTION, idFor("99"))!;
    expect(raw).toMatchObject({
      tenantId: "ten_1",
      platform: "x",
      userId: "99",
      handle: "someone",
      engagementCount: 1,
      firstEngagedAt: "2026-07-01T00:00:00Z",
      lastEngagedAt: "2026-07-01T00:00:00Z",
    });
    expect(raw.searchTokens).toEqual(expect.arrayContaining(["someone"]));
    // The platform literal must NOT leak into search tokens.
    expect(raw.searchTokens).not.toContain("x");
  });

  it("merges a repeat engagement: bumps lastEngagedAt, +1 count, fills fields, no null clobber", async () => {
    const db = new FakeFirestore();
    await upsertEngagedContact(
      ctx,
      { platform: "x", userId: "99", handle: "someone", name: "Some One", followers: 1200, engagedAt: "2026-07-01T00:00:00Z" },
      db,
    );
    const r = await upsertEngagedContact(
      ctx,
      // second event knows the bio but not the follower count → must not null followers
      { platform: "x", userId: "99", handle: "someone", bio: "builder", engagedAt: "2026-07-02T00:00:00Z" },
      db,
    );
    expect(r).toBe("updated");
    const raw = db.raw(COLLECTION, idFor("99"))!;
    expect(raw.lastEngagedAt).toBe("2026-07-02T00:00:00Z");
    expect(raw.firstEngagedAt).toBe("2026-07-01T00:00:00Z"); // preserved
    expect(raw.engagementCount).toBe(2);
    expect(raw.bio).toBe("builder"); // newly known
    expect(raw.followers).toBe(1200); // preserved
    expect(raw.name).toBe("Some One"); // preserved
    expect(db.dump(COLLECTION)).toHaveLength(1);
  });

  it("keeps two distinct engagers as separate records", async () => {
    const db = new FakeFirestore();
    await upsertEngagedContact(ctx, { platform: "x", userId: "1", engagedAt: "t" }, db);
    await upsertEngagedContact(ctx, { platform: "x", userId: "2", engagedAt: "t" }, db);
    expect(db.dump(COLLECTION)).toHaveLength(2);
  });
});
