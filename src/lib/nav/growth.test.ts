import { describe, it, expect } from "vitest";
import { computeGrowth, nextStepOf, SIGNUP_GOAL, type GrowthSignals } from "./growth";

const NOTHING: GrowthSignals = {
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
};

const LAUNCHED: GrowthSignals = { ...NOTHING, activeLaunches: 1, firstLaunchId: "c1", welcomeEmailLive: true, signups: 412 };
const statuses = (s: GrowthSignals) => computeGrowth(s).stages.map((st) => `${st.key}:${st.status}`);

describe("computeGrowth", () => {
  it("a brand-new brand is on first run, at Launch", () => {
    const g = computeGrowth(NOTHING);
    expect(g.firstRun).toBe(true);
    expect(g.current).toBe("launch");
    expect(statuses(NOTHING)).toEqual(["launch:current", "grow:next", "product:next", "retain:next"]);
  });

  it("Launch is done only once the welcome email is live", () => {
    expect(computeGrowth({ ...LAUNCHED, welcomeEmailLive: false }).current).toBe("launch");
    expect(computeGrowth(LAUNCHED).current).toBe("grow");
    expect(computeGrowth(LAUNCHED).firstRun).toBe(false);
  });

  it("Grow is done by a scheduled post or a sent newsletter", () => {
    const ws = { ...LAUNCHED, workspaces: 1, firstWorkspaceId: "w1" };
    expect(computeGrowth(ws).current).toBe("grow");
    expect(computeGrowth({ ...ws, postsScheduled: 2 }).current).toBe("product");
    expect(computeGrowth({ ...ws, newslettersSent: 1 }).current).toBe("product");
  });

  it("stages can finish out of order; the current one is the first not done", () => {
    const productFirst = { ...LAUNCHED, products: 1, firstProductId: "p1", catalogReady: true, eventsReceived: true };
    expect(statuses(productFirst)).toEqual(["launch:done", "grow:current", "product:done", "retain:next"]);
  });

  it("everything running hides the path", () => {
    const all: GrowthSignals = {
      ...LAUNCHED,
      workspaces: 1,
      postsScheduled: 3,
      products: 1,
      catalogReady: true,
      eventsReceived: true,
      journeys: 1,
      journeyPublished: true,
      journeyLive: true,
    };
    const g = computeGrowth(all);
    expect(g.current).toBeNull();
    expect(g.allRunning).toBe(true);
  });

  it("drops the product stages where lifecycle journeys don't exist", () => {
    expect(computeGrowth({ ...NOTHING, lifecycle: false }).stages.map((s) => s.key)).toEqual(["launch", "grow"]);
  });
});

describe("steps", () => {
  it("counts signups toward the goal and links to the newest launch", () => {
    const launch = computeGrowth({ ...LAUNCHED, signups: 4 }).stages[0]!;
    const traction = launch.steps[2]!;
    expect(traction.detail).toBe(`4 of ${SIGNUP_GOAL}`);
    expect(traction.done).toBe(false);
    expect(traction.href).toBe("/admin/launches/c1/widget");
    expect(nextStepOf(launch)?.label).toBe(`Get your first ${SIGNUP_GOAL} signups`);
  });

  it("falls back to list pages when nothing exists yet", () => {
    const [launch, grow, product, retain] = computeGrowth(NOTHING).stages;
    expect(launch!.steps[1]!.href).toBe("/admin/launches");
    expect(grow!.steps[1]!.href).toBe("/admin/workspace");
    expect(product!.steps[1]!.href).toBe("/admin/products");
    expect(retain!.steps[2]!.href).toBe("/admin/lifecycle");
  });

  it("summarises each stage in one line", () => {
    const g = computeGrowth({ ...LAUNCHED, workspaces: 1, postsScheduled: 1, products: 1, catalogReady: true });
    expect(g.stages.map((s) => s.summary)).toEqual([
      "412 signups",
      "1 post scheduled",
      "2 of 3 set up",
      "Build an onboarding journey",
    ]);
    expect(computeGrowth({ ...LAUNCHED, signups: null }).stages[0]!.summary).toBe("Live");
  });
});

describe("the invite step (nav v2 phase 4)", () => {
  const product = (s: GrowthSignals) => computeGrowth(s).stages.find((st) => st.key === "product")!;
  const withLifecycle = { ...LAUNCHED, lifecycle: true, products: 1, firstProductId: "pcn_1" };

  it("appears in Launch product only while invites are on, and ticks off after the first invite", () => {
    expect(product(withLifecycle).steps.map((st) => st.label)).not.toContain("Invite your waitlist");
    const off = product({ ...withLifecycle, invited: 0 }).steps.at(-1);
    expect(off).toMatchObject({ label: "Invite your waitlist", done: false, href: "/admin/launches/c1/invites" });
    expect(product({ ...withLifecycle, invited: 12 }).steps.at(-1)).toMatchObject({ done: true });
  });
});

