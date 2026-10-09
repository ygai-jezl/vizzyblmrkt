import { describe, expect, it } from "vitest";
import { ConnectionCatalogSchema } from "@/lib/types/productConnection";
import { lastActiveAt, personReach, personStage, reachText, stageChips, stageText } from "./personStage";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-09T09:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const catalog = ConnectionCatalogSchema.parse({
  onboardingSteps: [
    { id: "create_brand", label: "Add your brand", order: 0 },
    { id: "connect_site", label: "Connect your site", order: 1 },
    { id: "run_report", label: "Run your first report", order: 2 },
  ],
  facts: [{ id: "last_active_at", label: "Last active", type: "date" }],
});
const noSteps = ConnectionCatalogSchema.parse({});

const user = (over: Record<string, unknown> = {}) => ({
  steps: {},
  entities: undefined,
  activated: false,
  facts: undefined,
  signedUpAt: ago(1),
  firstSeenAt: ago(1),
  ...over,
});

describe("personStage", () => {
  it("is new for two days with nothing done, then onboarding", () => {
    expect(personStage(user(), catalog, NOW)).toMatchObject({ kind: "new", done: 0, total: 3, nextStep: "Add your brand" });
    expect(personStage(user({ signedUpAt: ago(3), firstSeenAt: ago(3) }), catalog, NOW).kind).toBe("onboarding");
    // One step done is onboarding, however recently they signed up.
    expect(personStage(user({ steps: { create_brand: { doneAt: ago(0.5) } } }), catalog, NOW)).toMatchObject({ kind: "onboarding", done: 1 });
  });

  it("is stuck a week after the last step, counted from that step", () => {
    const u = user({ signedUpAt: ago(20), firstSeenAt: ago(20), steps: { create_brand: { doneAt: ago(8) } } });
    const stage = personStage(u, catalog, NOW);
    expect(stage).toMatchObject({ kind: "stuck", done: 1, total: 3, nextStep: "Connect your site", daysOnStep: 8 });
    expect(stageChips(stage).map((c) => c.text)).toEqual(["Onboarding 1 of 3", "Stuck 8 days"]);
    expect(stageText(stage)).toBe('Onboarding, 1 of 3 steps done; stuck on "Connect your site" for 8 days');
    // Six days is still just onboarding.
    expect(personStage(user({ signedUpAt: ago(20), firstSeenAt: ago(20), steps: { create_brand: { doneAt: ago(6) } } }), catalog, NOW).kind).toBe("onboarding");
  });

  it("counts a step done on one of their brands as progress", () => {
    const perBrand = ConnectionCatalogSchema.parse({
      entityKinds: [{ kind: "brand", label: "brand", plural: "brands" }],
      onboardingSteps: [
        { id: "create_brand", label: "Add your brand", order: 0, kind: "brand" },
        { id: "connect_site", label: "Connect your site", order: 1, kind: "brand" },
      ],
    });
    const brand = { kind: "brand", name: "Harbour Bakery", parentId: null, role: "owner" as const, steps: { create_brand: { doneAt: ago(2) } }, facts: {}, activeAt: null, firstSeenAt: ago(9), updatedAt: ago(2) };
    const stage = personStage(user({ signedUpAt: ago(9), firstSeenAt: ago(9), entities: { b_1: brand } }), perBrand, NOW);
    expect(stage).toMatchObject({ kind: "onboarding", done: 1, total: 2, daysOnStep: 2 });
  });

  it("is activated once marked, or once every step is done", () => {
    expect(personStage(user({ activated: true }), catalog, NOW)).toMatchObject({ kind: "activated", nextStep: null, daysOnStep: null });
    const all = { create_brand: { doneAt: ago(5) }, connect_site: { doneAt: ago(4) }, run_report: { doneAt: ago(3) } };
    expect(stageChips(personStage(user({ steps: all }), catalog, NOW))).toEqual([{ tone: "green", text: "Activated" }]);
  });

  it("names no progress for a product with no onboarding steps", () => {
    const stage = personStage(user(), noSteps, NOW);
    expect(stage).toMatchObject({ kind: "member", done: 0, total: 0 });
    expect(stageChips(stage)).toEqual([]);
  });

  it("is quiet from the activity date, not from the last sync", () => {
    const quiet = user({ activated: true, facts: { last_active_at: { value: ago(16), at: ago(0) } } });
    expect(lastActiveAt(quiet, catalog)).toBe(ago(16));
    const stage = personStage(quiet, catalog, NOW);
    expect(stage.quietDays).toBe(16);
    expect(stageChips(stage).map((c) => c.text)).toEqual(["Activated", "Quiet 16 days"]);
    // Thirteen days isn't quiet yet; a value that isn't a date, or a catalog without the fact, says nothing.
    expect(personStage(user({ facts: { last_active_at: { value: ago(13), at: ago(0) } } }), catalog, NOW).quietDays).toBeNull();
    expect(personStage(user({ facts: { last_active_at: { value: "yesterday", at: ago(0) } } }), catalog, NOW).quietDays).toBeNull();
    expect(lastActiveAt(quiet, noSteps)).toBeNull();
  });
});

describe("personReach", () => {
  const policy = { marketingBases: ["consent", "soft_opt_in"] as Array<"consent" | "soft_opt_in"> };
  const reachable = { email: "priya@customer.test", excluded: null, subscribed: undefined, consent: { basis: "consent" as const, at: ago(1) }, emailPreferences: {} };

  it("can email someone with an address and consent", () => {
    const reach = personReach(reachable, policy, []);
    expect(reach).toMatchObject({ can: "yes", blocked: null, marketing: true, optedOutOf: [] });
    expect(reachText(reach)).toEqual({ tone: "green", chip: "Can email", why: null });
  });

  it("says why nothing can be sent, the product's own stop first", () => {
    expect(personReach({ ...reachable, email: null }, policy, []).blocked).toBe("no_address");
    const excluded = personReach({ ...reachable, excluded: { reason: "staff account", at: ago(1) } }, policy, []);
    expect(reachText(excluded)).toEqual({ tone: "red", chip: "Can't email", why: "Excluded by your product: staff account" });
    expect(personReach({ ...reachable, subscribed: false }, policy, []).blocked).toBe("opted_out_in_product");
    expect(personReach(reachable, policy, [{ scope: "all", reason: "unsubscribe" }]).blocked).toBe("unsubscribed");
    // A bounce beside an unsubscribe reads as the bounce.
    expect(personReach(reachable, policy, [{ scope: "all", reason: "unsubscribe" }, { scope: "all", reason: "hard_bounce" }]).blocked).toBe("bounced");
    expect(personReach(reachable, policy, [{ scope: "all", reason: "spam" }]).blocked).toBe("complained");
  });

  it("is limited by a category opt-out, in our emails or in the product", () => {
    const reach = personReach({ ...reachable, emailPreferences: { digest: { subscribed: false, at: ago(1) }, onboarding: { subscribed: true, at: ago(1) } } }, policy, [
      { scope: "category", reason: "unsubscribe", category: "tips" },
    ]);
    expect(reach).toMatchObject({ can: "limited", optedOutOf: ["digest", "tips"] });
    expect(reachText(reach, { tips: "Product tips" })).toEqual({ tone: "amber", chip: "Opted out of some emails", why: "Opted out of digest, Product tips" });
  });

  it("is service emails only without a basis the product accepts", () => {
    const reach = personReach({ ...reachable, consent: { basis: "none", at: ago(1) } }, policy, []);
    expect(reach).toMatchObject({ can: "limited", marketing: false });
    expect(reachText(reach).chip).toBe("Service emails only");
    expect(personReach({ ...reachable, consent: null }, policy, []).marketing).toBe(false);
  });
});
