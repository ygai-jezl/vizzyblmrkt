import { describe, expect, it } from "vitest";
import { computeGrowth, type Growth, type GrowthSignals, type StageKey, type StageView } from "@/lib/nav/growth";
import type { ProfileAnswers } from "@/lib/types/businessProfile";
import { nextActionOrder, nextActionStage, nextActionTitle } from "./homeOrder";

const ALL: StageKey[] = ["ready", "launch", "grow", "product", "retain"];
const LABEL: Record<StageKey, string> = { ready: "Get ready", launch: "Launch", grow: "Grow audience", product: "Launch product", retain: "Onboard & retain" };

/** A growth path with the given stages done, as computeGrowth marks them. */
function growth(done: StageKey[], keys: StageKey[] = ALL): Growth {
  const current = keys.find((k) => !done.includes(k)) ?? null;
  const stages: StageView[] = keys.map((key) => ({
    key,
    label: LABEL[key],
    status: done.includes(key) ? "done" : key === current ? "current" : "next",
    summary: "",
    steps: [],
  }));
  return { stages, current, firstRun: false, allRunning: current === null };
}

const pick = (g: Growth, answers: ProfileAnswers | null | undefined) => nextActionStage(g, answers)?.key ?? null;

describe("Your next action", () => {
  it("lists the current stage with no answers, as Home did before", () => {
    for (const answers of [undefined, null, {}]) {
      expect(pick(growth([]), answers)).toBe("ready");
      expect(pick(growth(["ready"]), answers)).toBe("launch");
    }
    expect(nextActionOrder({})).toBeNull();
  });

  it("leads with the waitlist for an idea, while Get ready is still current", () => {
    const g = growth([]);
    expect(g.current).toBe("ready");
    expect(pick(g, { stage: "idea" })).toBe("launch");
    expect(pick(g, { stage: "idea", want: "audience" })).toBe("launch");
    expect(pick(g, { stage: "launched", want: "waitlist" })).toBe("launch");
  });

  it("leads with content for an audience", () => {
    expect(pick(growth([]), { run: "shop", stage: "established", want: "audience" })).toBe("grow");
  });

  it("leads with the product, then its journeys, for an app that wants customers", () => {
    const answers: ProfileAnswers = { run: "app", stage: "launched", want: "customers" };
    expect(pick(growth([]), answers)).toBe("product");
    expect(pick(growth(["product"]), answers)).toBe("retain");
    expect(pick(growth(["product", "retain"]), answers)).toBe("ready");
  });

  it("leads with sign-ups for a shop or a service that wants customers, and never with connecting an app", () => {
    for (const run of ["shop", "service"] as const) {
      const answers: ProfileAnswers = { run, stage: "established", want: "customers" };
      expect(nextActionOrder(answers)).toEqual(["launch", "ready", "grow", "product", "retain"]);
      expect(pick(growth([]), answers)).toBe("launch");
      expect(pick(growth(["launch"]), answers)).toBe("ready");
      // Nothing is hidden: once the rest is done, the product comes up.
      expect(pick(growth(["ready", "launch", "grow"]), answers)).toBe("product");
    }
  });

  it("keeps the growth path's order when the answers name no lead", () => {
    expect(pick(growth(["ready"]), { who: "solo" })).toBe("launch");
    expect(pick(growth(["ready", "launch", "grow"]), { run: "app", stage: "established" })).toBe("product");
  });

  it("skips a lead stage this copy doesn't have", () => {
    // Without lifecycle journeys there is no product stage: the next is the path's first not done.
    const g = growth([], ["ready", "launch", "grow"]);
    expect(pick(g, { run: "app", want: "customers" })).toBe("ready");
  });

  it("is null once every stage is done", () => {
    expect(pick(growth(ALL), { want: "audience" })).toBeNull();
    expect(pick(growth(ALL), undefined)).toBeNull();
  });

  it("works on the growth path itself: a new brand that wants a waitlist sees Launch's steps", () => {
    const signals: GrowthSignals = {
      activeLaunches: 0,
      firstLaunchId: null,
      welcomeEmailLive: false,
      signups: 0,
      workspaces: 0,
      firstWorkspaceId: null,
      postsScheduled: 0,
      newslettersSent: 0,
      lifecycle: true,
      products: 0,
      firstProductId: null,
      catalogReady: false,
      eventsReceived: false,
      journeys: 0,
      firstJourneyId: null,
      journeyPublished: false,
      journeyLive: false,
      setup: { domainVerified: false, senderDetails: false, logo: false, voice: false, emailStyle: false, knowledge: false, brandMapSaved: null, social: false, git: false },
    };
    const g = computeGrowth(signals, { ideas: true });
    expect(g.current).toBe("ready");
    const stage = nextActionStage(g, { who: "solo", run: "app", stage: "idea", want: "waitlist" });
    expect(stage?.key).toBe("launch");
    expect(stage?.status).toBe("next");
    expect(stage?.steps.length).toBeGreaterThan(0);
    expect(stage?.steps[0]?.label).toBe("Create an idea");
  });

  it("titles the card Your next action with the switch on, and as before with it off", () => {
    expect(nextActionTitle(true, { label: "Grow audience" })).toBe("Your next action");
    expect(nextActionTitle(false, { label: "Grow audience" })).toBe("Next for grow audience");
  });
});
