import { describe, expect, it } from "vitest";
import type { ContactCampaignLink, PersonProductLink } from "@/lib/types/contact";
import {
  handAddedOf,
  isCarriedTag,
  MAX_GROUP_TAGS,
  optOutsOf,
  sameProductLink,
  signupReach,
  summarize,
  tagChanges,
  withCarriedTags,
} from "./personLinks";

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

describe("in more than one launch (LAUNCH_IDEAS_ENABLED)", () => {
  const two = [signup(), signup({ campaignId: "camp2", signupId: "sig_2" })];
  const tags = (campaigns: ContactCampaignLink[], many: Parameters<typeof summarize>[4]) => summarize(campaigns, [], undefined, null, many).memberOf;

  it("tags someone in two or more live launches, only while asked to", () => {
    expect(tags(two, { manyLaunches: { leaveOut: new Set() } })).toContain("launches:many");
    expect(tags(two, {})).not.toContain("launches:many");
    expect(tags(two, { manyLaunches: null })).not.toContain("launches:many");
  });

  it("counts each launch once, and no deleted sign-up", () => {
    const many = { manyLaunches: { leaveOut: new Set<string>() } };
    expect(tags([signup(), signup({ signupId: "sig_2" })], many)).not.toContain("launches:many");
    expect(tags([signup(), signup({ campaignId: "camp2", status: "deleted" })], many)).not.toContain("launches:many");
  });

  it("leaves out the brand's Just a list launches", () => {
    expect(tags(two, { manyLaunches: { leaveOut: new Set(["camp2"]) } })).not.toContain("launches:many");
    const three = [...two, signup({ campaignId: "camp3", signupId: "sig_3" })];
    expect(tags(three, { manyLaunches: { leaveOut: new Set(["camp2"]) } })).toContain("launches:many");
  });

  it("keeps what the last full sync worked out, on the fast path", () => {
    expect(tags(two, { manyLaunches: { keep: true } })).toContain("launches:many");
    expect(tags(two, { manyLaunches: { keep: false } })).not.toContain("launches:many");
    expect(tags([signup()], { manyLaunches: { keep: true } })).not.toContain("launches:many");
  });
});

describe("someone added by hand", () => {
  const ADDED = "2026-09-10T09:00:00.000Z";
  const hand = (marketingConsent = false, hasAddress = true) => ({ at: ADDED, marketingConsent, hasAddress });

  it("is live with only that source, tagged all and added:hand, active from when they were added", () => {
    expect(summarize([], [], undefined, hand())).toEqual({ live: true, memberOf: ["added:hand", "all"], reach: "no", activeAt: ADDED });
  });

  it("can be emailed only with recorded consent and no brand-wide opt-out", () => {
    expect(summarize([], [], undefined, hand(true)).reach).toBe("yes");
    expect(summarize([], [], undefined, hand(false)).reach).toBe("no");
    expect(summarize([], [], { blocked: "unsubscribe", categories: [] }, hand(true)).reach).toBe("no");
    // Without consent their other sources decide, as for anyone.
    expect(summarize([signup({ status: "unverified" })], [], undefined, hand(false)).reach).toBe("limited");
  });

  it("can't be emailed with only a phone, whatever they agreed", () => {
    expect(summarize([], [], undefined, hand(true, false)).reach).toBe("no");
    const addedBy = { kind: "member" as const, id: "usr_1", at: ADDED, via: "form" as const };
    const granted = { state: "granted" as const, how: "in_person", note: null, recordedBy: "usr_1", at: ADDED, agreedAt: null };
    expect(summarize([], [], undefined, handAddedOf({ addedBy, consent: { marketing_email: granted }, email: null })).reach).toBe("no");
    expect(summarize([], [], undefined, handAddedOf({ addedBy, consent: { marketing_email: granted }, email: "sam@customer.test" })).reach).toBe("yes");
  });

  it("keeps their other sources' tags and the latest activity", () => {
    const s = summarize([signup({ joinedAt: "2026-09-20T10:00:00.000Z" })], [], undefined, hand());
    expect(s.memberOf).toEqual(["added:hand", "all", "launch:any", "launch:camp1", "via:form"]);
    expect(s.activeAt).toBe("2026-09-20T10:00:00.000Z");
    // A deleted sign-up leaves them live, by hand.
    expect(summarize([signup({ status: "deleted" })], [], undefined, hand()).live).toBe(true);
  });

  it("comes from the contact's addedBy and its recorded marketing consent", () => {
    expect(handAddedOf(null)).toBeNull();
    expect(handAddedOf({})).toBeNull();
    const addedBy = { kind: "member" as const, id: "usr_1", at: ADDED, via: "form" as const };
    expect(handAddedOf({ addedBy })).toEqual({ at: ADDED, marketingConsent: false, hasAddress: false });
    const granted = { state: "granted" as const, how: "verbal", note: null, recordedBy: "usr_1", at: ADDED, agreedAt: null };
    expect(handAddedOf({ addedBy, consent: { marketing_email: granted }, email: "sam@customer.test" })).toEqual({ at: ADDED, marketingConsent: true, hasAddress: true });
    expect(handAddedOf({ addedBy, consent: { marketing_email: { ...granted, state: "withdrawn" } } })?.marketingConsent).toBe(false);
    // Consent without addedBy is not a hand-added source.
    expect(handAddedOf({ consent: { marketing_email: granted } })).toBeNull();
  });
});

describe("carried tags", () => {
  it("are the field writer's field: tags and the hand-added mark", () => {
    expect(isCarriedTag("field:fld_plan:opt_pro")).toBe(true);
    expect(isCarriedTag("added:hand")).toBe(true);
    expect(isCarriedTag("launch:camp1")).toBe(false);
    expect(isCarriedTag("all")).toBe(false);
  });

  it("join a sync's tags, sorted and each once", () => {
    expect(withCarriedTags(["all", "launch:camp1"], ["launch:old", "field:fld_plan:opt_pro", "added:hand", "all"])).toEqual([
      "added:hand",
      "all",
      "field:fld_plan:opt_pro",
      "launch:camp1",
    ]);
    expect(withCarriedTags(["all"], undefined)).toEqual(["all"]);
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
