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


describe("the setup guide", () => {
  const SETUP_NONE = {
    domainVerified: false,
    senderDetails: false,
    logo: false,
    voice: false,
    emailStyle: false,
    knowledge: false,
    brandMapSaved: false,
    social: false,
    git: false,
  };
  const SETUP_READY = { ...SETUP_NONE, domainVerified: true, senderDetails: true, logo: true, voice: true, emailStyle: true };
  const stage = (s: GrowthSignals, key: string) => computeGrowth(s).stages.find((st) => st.key === key)!;
  const step = (s: GrowthSignals, key: string, label: string) => stage(s, key).steps.find((st) => st.label === label)!;

  it("adds Get ready first, and a brand-new brand starts there", () => {
    const g = computeGrowth({ ...NOTHING, setup: SETUP_NONE });
    expect(g.stages.map((s) => s.key)).toEqual(["ready", "launch", "grow", "product", "retain"]);
    expect(g.current).toBe("ready");
    expect(nextStepOf(g.stages[0]!)?.label).toBe("Verify your sending domain");
  });

  it("leaves the path exactly as before without it", () => {
    expect(computeGrowth(NOTHING).stages.every((s) => s.steps.every((st) => !st.howTo && !st.needs))).toBe(true);
  });

  it("sender details wait for a verified domain, and Get ready is done with everything in it", () => {
    const none = { ...NOTHING, setup: SETUP_NONE };
    expect(step(none, "ready", "Add your sender details").needs).toEqual([{ label: "Verify your sending domain", href: "/admin/account" }]);
    expect(step({ ...NOTHING, setup: { ...SETUP_NONE, domainVerified: true } }, "ready", "Add your sender details").needs).toBeUndefined();
    expect(computeGrowth({ ...NOTHING, setup: SETUP_READY }).current).toBe("launch");
    expect(computeGrowth({ ...NOTHING, setup: { ...SETUP_READY, voice: false } }).current).toBe("ready");
  });

  it("drops Email style and the brand map where they're off", () => {
    const off = { ...NOTHING, setup: { ...SETUP_READY, emailStyle: null, brandMapSaved: null } };
    expect(stage(off, "ready").steps.map((s) => s.label)).not.toContain("Style your emails");
    expect(stage(off, "grow").steps.map((s) => s.label)).not.toContain("Save your brand map");
    expect(computeGrowth(off).current).toBe("launch");
  });

  it("warns before the welcome email and before scheduling without an account", () => {
    const s = { ...LAUNCHED, welcomeEmailLive: false, setup: SETUP_READY };
    expect(step(s, "launch", "Turn on the welcome email").warning).toMatch(/before you share your page/);
    const post = step({ ...s, workspaces: 1, firstWorkspaceId: "w1" }, "grow", "Schedule your first post");
    expect(post.needs).toEqual([{ label: "Connect LinkedIn or X", href: "/admin/account/connections" }]);
  });

  it("Grow also needs knowledge, and suggests required steps before optional ones", () => {
    const ws = { ...LAUNCHED, workspaces: 1, firstWorkspaceId: "w1", postsScheduled: 1, setup: SETUP_READY };
    expect(computeGrowth(ws).current).toBe("grow");
    expect(nextStepOf(stage(ws, "grow"))?.label).toBe("Add your website to its knowledge");
    expect(step(ws, "grow", "Add your website to its knowledge").href).toBe("/admin/workspace/w1/curate/grounding");
    expect(computeGrowth({ ...ws, setup: { ...SETUP_READY, knowledge: true } }).current).toBe("product");
  });

  it("going live needs a published journey and the sender set up", () => {
    const s = { ...LAUNCHED, products: 1, firstProductId: "p1", catalogReady: true, eventsReceived: true, journeys: 1, journeyPublished: true, setup: SETUP_NONE };
    expect(step(s, "retain", "Switch it to live").needs?.map((n) => n.label)).toEqual(["Verify your sending domain", "Add your sender details"]);
    expect(step({ ...s, setup: SETUP_READY }, "retain", "Switch it to live").needs).toBeUndefined();
    expect(step({ ...s, catalogReady: false }, "retain", "Publish it in test mode").needs?.map((n) => n.label)).toEqual(["Learn it from your repo"]);
  });

  it("every step links to a help page", () => {
    const g = computeGrowth({ ...LAUNCHED, invited: 0, setup: SETUP_NONE });
    for (const st of g.stages.flatMap((s) => s.steps)) expect(st.howTo, st.label).toMatch(/^\/help(\/[a-z-]+)?(#[a-z-]+)?$/);
  });
});
