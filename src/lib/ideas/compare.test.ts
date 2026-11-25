import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { loadComparison, parseCompareIds } from "./compare";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };

describe("parseCompareIds", () => {
  it("takes 2 to 4 ids, as a,b or a repeated parameter, each once", () => {
    expect(parseCompareIds("team-spaces,offline-mode")).toEqual(["team-spaces", "offline-mode"]);
    expect(parseCompareIds(["team-spaces", "offline-mode", "weekly-digest"])).toEqual(["team-spaces", "offline-mode", "weekly-digest"]);
    expect(parseCompareIds(["a,b", "c"])).toEqual(["a", "b", "c"]);
    expect(parseCompareIds(" a , b ,")).toEqual(["a", "b"]);
    expect(parseCompareIds("a,b,c,d")).toHaveLength(4);
  });

  it("ignores anything else", () => {
    for (const raw of [undefined, "", "a", "a,a", "a,b,c,d,e", "a,b/c", ["a"], "a,../b"]) expect(parseCompareIds(raw), String(raw)).toBeNull();
  });
});

describe("loadComparison", () => {
  function world(): FakeFirestore {
    const db = new FakeFirestore();
    const launch = (id: string, tenantId: string, extra: Record<string, unknown> = {}) =>
      db.seed("campaigns", id, { tenantId, waitlistName: id.replace(/-/g, " "), createdAt: "2026-10-01T00:00:00.000Z", ...extra });
    launch("team-spaces", "ten_A", { idea: { status: "testing", hypothesis: "Teams pay." } });
    launch("weekly-digest", "ten_A", { idea: { status: "launched", productConnectionId: "pcn_app" }, archivedAt: "2026-11-20T00:00:00.000Z" });
    launch("product-updates", "ten_A", { idea: { justAList: true } });
    launch("their-idea", "ten_B", { idea: { status: "testing" } });
    db.seed("product_connections", "pcn_app", { tenantId: "ten_A", kind: "custom", status: "active", name: "Lumen app (Production)" });
    for (const [i, s] of [
      ["s1", { campaignId: "team-spaces", verified: true, status: "verified_active" }],
      ["s2", { campaignId: "team-spaces", verified: false, status: "unverified" }],
      ["s3", { campaignId: "team-spaces", verified: true, status: "deleted" }],
      ["s4", { campaignId: "weekly-digest", verified: true, status: "verified_active" }],
      ["s5", { campaignId: "their-idea", verified: true, status: "verified_active" }],
    ] as const) {
      db.seed("signups", i, { tenantId: s.campaignId === "their-idea" ? "ten_B" : "ten_A", ...s });
    }
    db.seed("invites", "i1", { tenantId: "ten_A", campaignId: "weekly-digest", invited: true, signedUp: true, activated: false });
    return db;
  }

  it("gives each launch's idea and funnel, in the order asked for, naming the product it was handed off to", async () => {
    const r = await loadComparison(ctx, ["weekly-digest", "team-spaces"], world());
    expect(r.map((c) => c.id)).toEqual(["weekly-digest", "team-spaces"]);
    expect(r[0]).toMatchObject({ archived: true, handedOffTo: "Lumen app", idea: { status: "launched" } });
    expect(r[0]!.funnel).toEqual({ waitlisted: 1, verified: 1, invited: 1, signedUp: 1, activated: 0 });
    expect(r[1]).toMatchObject({ name: "team spaces", archived: false, handedOffTo: null, idea: { hypothesis: "Teams pay." } });
    expect(r[1]!.funnel).toEqual({ waitlisted: 2, verified: 1, invited: 0, signedUp: 0, activated: 0 });
  });

  it("leaves out another brand's launch, one that doesn't exist, and Just a list", async () => {
    const r = await loadComparison(ctx, ["team-spaces", "their-idea", "no-such-launch", "product-updates"], world());
    expect(r.map((c) => c.id)).toEqual(["team-spaces"]);
  });
});
