import { describe, expect, it } from "vitest";
import type { ContactCampaignLink, PersonProductLink } from "@/lib/types/contact";
import { MAX_GROUP_TAGS, optOutsOf, sameProductLink, signupReach, summarize, tagChanges } from "./personLinks";

const signup = (over: Partial<ContactCampaignLink> = {}): ContactCampaignLink => ({
  campaignId: "camp1",
  signupId: "sig_1",
  status: "verified_active",
  amountReferred: 0,
  joinedAt: "2026-09-01T10:00:00.000Z",
  joinedVia: "form",
  ...over,
});

const product = (over: Partial<PersonProductLink> = {}): PersonProductLink => ({
  connectionId: "pcn_a",
  productUserId: "pu_1",
  stage: "onboarding",
  quiet: false,
  activated: false,
  signedUpAt: "2026-09-05T10:00:00.000Z",
  lastActiveAt: null,
  reach: "limited",
  groups: [],
  ...over,
});

describe("optOutsOf", () => {
  it("keeps the strongest brand-wide block and every category", () => {
    expect(
      optOutsOf([
        { scope: "all", reason: "unsubscribe" },
        { scope: "all", reason: "hard_bounce" },
        { scope: "category", reason: "unsubscribe", category: "tips" },
        { scope: "category", reason: "unsubscribe", category: "digest" },
      ]),
    ).toEqual({ blocked: "hard_bounce", categories: ["digest", "tips"] });
    expect(optOutsOf([])).toEqual({ blocked: null, categories: [] });
  });
});

describe("signupReach", () => {
  it("reads confirmed as yes, unconfirmed as the confirmation only, and the rest as no", () => {
    expect(signupReach({ status: "verified_active" })).toBe("yes");
    expect(signupReach({ status: "unverified" })).toBe("limited");
    expect(signupReach({ status: "offboarded" })).toBe("no");
  });
});

describe("summarize", () => {
  it("tags every launch, how they joined, every product, its stage, quiet and groups", () => {
    const s = summarize(
      [signup(), signup({ campaignId: "camp2", signupId: "sig_2", joinedVia: "site", joinedAt: "2026-09-03T10:00:00.000Z" })],
      [product({ stage: "stuck", quiet: true, groups: ["ws_1"] }), product({ connectionId: "pcn_b", productUserId: "pu_2", stage: "activated" })],
      { blocked: null, categories: [] },
    );
    expect(s.memberOf).toEqual([
      "all",
      "group:pcn_a:ws_1",
      "launch:any",
      "launch:camp1",
      "launch:camp2",
      "product:any",
      "product:pcn_a",
      "product:pcn_b",
      "quiet:pcn_a",
      "stage:pcn_a:stuck",
      "stage:pcn_b:activated",
      "via:form",
      "via:site",
    ]);
    expect(s.live).toBe(true);
    expect(s.reach).toBe("yes");
  });

  it("takes the best reach across sources, and none at all past a brand-wide block", () => {
    expect(summarize([signup({ status: "unverified" })], [product({ reach: "no" })], undefined).reach).toBe("limited");
    expect(summarize([signup()], [product({ reach: "yes" })], { blocked: "unsubscribe", categories: [] }).reach).toBe("no");
  });

  it("counts a deleted sign-up as no source", () => {
    const s = summarize([signup({ status: "deleted" })], [], undefined);
    expect(s).toMatchObject({ live: false, memberOf: [], reach: "no" });
  });

  it("orders by the latest activity it can see", () => {
    const s = summarize([signup()], [product({ lastActiveAt: "2026-09-20T08:00:00.000Z" })], undefined);
    expect(s.activeAt).toBe("2026-09-20T08:00:00.000Z");
    expect(summarize([signup()], [product()], undefined).activeAt).toBe("2026-09-05T10:00:00.000Z");
  });

  it("caps group tags so a person in hundreds of workspaces stays one record", () => {
    const groups = Array.from({ length: MAX_GROUP_TAGS + 20 }, (_, i) => `ws_${String(i).padStart(3, "0")}`);
    const s = summarize([], [product({ groups })], undefined);
    expect(s.memberOf.filter((t) => t.startsWith("group:"))).toHaveLength(MAX_GROUP_TAGS);
  });
});

describe("sameProductLink and tagChanges", () => {
  it("ignores activity within the same day", () => {
    const a = product({ lastActiveAt: "2026-09-20T08:00:00.000Z" });
    expect(sameProductLink(a, { ...a, lastActiveAt: "2026-09-20T21:00:00.000Z" })).toBe(true);
    expect(sameProductLink(a, { ...a, lastActiveAt: "2026-09-21T01:00:00.000Z" })).toBe(false);
    expect(sameProductLink(a, { ...a, stage: "stuck" })).toBe(false);
  });

  it("says what was added and removed", () => {
    expect(tagChanges(["all", "stage:p:new"], ["all", "stage:p:onboarding"])).toEqual({ added: ["stage:p:onboarding"], removed: ["stage:p:new"] });
  });
});
