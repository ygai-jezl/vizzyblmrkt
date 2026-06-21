import { describe, it, expect } from "vitest";
import { recordEmailEvent, emailEventId } from "./events";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";

const ctx: TenantContext = { tenantId: "t1", region: "us", source: "system" };

const base = {
  campaignId: "c1",
  journeyId: "journey_c1",
  nodeId: "email1",
  signupId: "s1",
  variantId: "control",
  type: "open" as const,
  ts: "2026-06-20T00:00:00.000Z",
};

describe("recordEmailEvent", () => {
  it("records once and dedupes repeats (unique-per-recipient)", async () => {
    const db = new FakeFirestore();
    expect(await recordEmailEvent(ctx, base, db)).toBe("recorded");
    expect(await recordEmailEvent(ctx, base, db)).toBe("duplicate");
    expect(await recordEmailEvent(ctx, { ...base, ts: "later" }, db)).toBe("duplicate");
    expect(db.dump("email_events")).toHaveLength(1);
  });

  it("keys distinctly by type and variant", async () => {
    const db = new FakeFirestore();
    await recordEmailEvent(ctx, base, db);
    await recordEmailEvent(ctx, { ...base, type: "click" }, db);
    await recordEmailEvent(ctx, { ...base, variantId: "var_a" }, db);
    expect(db.dump("email_events")).toHaveLength(3);
  });

  it("emailEventId encodes journey/node/signup/variant/type", () => {
    expect(emailEventId(base)).toBe("evt:journey_c1:email1:s1:control:open");
  });
});
