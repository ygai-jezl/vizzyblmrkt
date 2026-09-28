import { afterEach, describe, it, expect, vi } from "vitest";
import { launchInView, vizzyPageLabel, vizzySuggestions, programmeInView, homePrompts, journeyInView, shellChatContext } from "./vizzy";

describe("vizzyPageLabel", () => {
  it("joins the breadcrumb", () => {
    expect(vizzyPageLabel([{ label: "Launches" }, { label: "Fernlight Beta" }, { label: "Signups" }])).toBe(
      "Launches › Fernlight Beta › Signups",
    );
  });

  it("drops characters the context envelope can't carry, and caps the length", () => {
    expect(vizzyPageLabel([{ label: 'Launch {x}] "quoted" \\ok' }])).toBe("Launch x quoted ok");
    expect(vizzyPageLabel([{ label: "a".repeat(300) }])).toHaveLength(160);
  });
});

describe("launchInView", () => {
  it("reads the launch id from launch pages only", () => {
    expect(launchInView("/admin/launches/beta-launch/signups")).toBe("beta-launch");
    expect(launchInView("/admin/launches/new")).toBeNull();
    expect(launchInView("/admin/launches")).toBeNull();
    expect(launchInView("/admin/crm")).toBeNull();
  });
});

describe("vizzySuggestions", () => {
  it("has starters for every area, defaulting to Home's", () => {
    expect(vizzySuggestions("launches")[0]).toBe("Draft a broadcast for this launch");
    expect(vizzySuggestions(null)).toEqual(vizzySuggestions("home"));
  });
});

describe("programmeInView (nav v2 phase 4)", () => {
  it("reads the programme, and the plan on a plan's page", () => {
    expect(programmeInView("/admin/workspace/weekly-plate-a1b2c3/curate/idea-board")).toEqual({ workspaceId: "weekly-plate-a1b2c3", planId: null });
    expect(programmeInView("/admin/workspace/ws1/create/8e1ad6e8-afb0-4f3b-bb62-5102b5bcd7b2")).toEqual({
      workspaceId: "ws1",
      planId: "8e1ad6e8-afb0-4f3b-bb62-5102b5bcd7b2",
    });
    expect(programmeInView("/admin/workspace")).toEqual({ workspaceId: null, planId: null });
    expect(programmeInView("/admin/launches/beta")).toEqual({ workspaceId: null, planId: null });
  });
});

describe("invite starters (nav v2 phase 4)", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("appear only while invites are on", () => {
    expect(vizzySuggestions("launches")).not.toContain("Draft an invite wave for my top 100");
    for (const [k, v] of Object.entries({
      NEXT_PUBLIC_NAV_V2_ENABLED: "true",
      NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED: "true",
      NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED: "true",
      NEXT_PUBLIC_NAV_V2_PHASE4_ENABLED: "true",
      NEXT_PUBLIC_INVITES_ENABLED: "true",
    })) vi.stubEnv(k, v);
    expect(vizzySuggestions("launches")).toContain("Draft an invite wave for my top 100");
    expect(homePrompts("product")).toContain("Invite my waitlist to the product");
  });
});


describe("Insights starter (phase 4 follow-up)", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("appears only while the Insights hub (and so Vizzy's Insights tool) is on", () => {
    expect(vizzySuggestions("insights")).not.toContain("Which content brings signups?");
    for (const [k, v] of Object.entries({
      NEXT_PUBLIC_NAV_V2_ENABLED: "true",
      NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED: "true",
      NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED: "true",
      NEXT_PUBLIC_NAV_V2_PHASE4_ENABLED: "true",
      NEXT_PUBLIC_INSIGHTS_HUB_ENABLED: "true",
    })) vi.stubEnv(k, v);
    expect(vizzySuggestions("insights")).toEqual([
      "What drove signups this week?",
      "Which email has the best click rate?",
      "Which content brings signups?",
    ]);
    expect(vizzySuggestions("launches")).not.toContain("Which content brings signups?");
  });
});

describe("journeyInView (journey styles)", () => {
  it("reads the lifecycle journey id, a product journey's or a launch's welcome journey's", () => {
    expect(journeyInView("/admin/lifecycle/lcj_abcdefghijklmnopqrstuvwxyz234567")).toBe("lcj_abcdefghijklmnopqrstuvwxyz234567");
    expect(journeyInView(`/admin/lifecycle/lcjw_${"a".repeat(40)}/`)).toBe(`lcjw_${"a".repeat(40)}`);
    expect(journeyInView("/admin/lifecycle")).toBeNull();
    expect(journeyInView("/admin/launches/beta")).toBeNull();
  });

  it("gives none for an id the chat's envelope can't carry", () => {
    expect(journeyInView("/admin/lifecycle/lcj%7Bx%7D")).toBeNull();
    expect(journeyInView(`/admin/lifecycle/${"a".repeat(65)}`)).toBeNull();
    expect(journeyInView("/admin/lifecycle/a.b")).toBeNull();
  });
});

describe("shellChatContext", () => {
  const JOURNEY = "/admin/lifecycle/lcj_abc";
  it("without journeyInContext, is exactly what the panel sent before", () => {
    for (const path of [JOURNEY, "/admin/launches/beta/signups", "/admin/workspace/ws1/create/plan1", "/admin"]) {
      expect(shellChatContext(path, "Page", { phase4: false })).toEqual({ page: "Page", campaignId: launchInView(path) });
      expect(shellChatContext(path, "Page", { phase4: true, journeyInContext: false })).toEqual({
        page: "Page",
        campaignId: launchInView(path),
        ...programmeInView(path),
      });
    }
    expect(shellChatContext(JOURNEY, "Page", { phase4: true })).not.toHaveProperty("journeyId");
  });

  it("with it, names the journey in view, and an empty id elsewhere (never left out)", () => {
    expect(shellChatContext(JOURNEY, "Journeys › Onboarding", { phase4: false, journeyInContext: true })).toEqual({
      page: "Journeys › Onboarding",
      campaignId: "",
      journeyId: "lcj_abc",
    });
    // The panel's one conversation moves on from a journey page: Vizzy is told there's none now.
    expect(shellChatContext("/admin/launches/beta", "Page", { phase4: false, journeyInContext: true })).toEqual({
      page: "Page",
      campaignId: "beta",
      journeyId: "",
    });
    // And off a launch page, that there's no launch either (its welcome journey isn't "this journey").
    for (const path of ["/admin/lifecycle", "/admin", "/admin/launches/new"]) {
      expect(shellChatContext(path, "Page", { phase4: false, journeyInContext: true })).toEqual({
        page: "Page",
        campaignId: "",
        journeyId: "",
      });
    }
  });
});
