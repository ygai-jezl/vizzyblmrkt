import { describe, it, expect } from "vitest";
import { ago, homeTiles, openRate } from "./homeTiles";
import type { GrowthSignals } from "./growth";
import type { WeekCounts } from "./growthSignals";

const now = new Date("2026-09-23T12:00:00Z");
const signals = {
  activeLaunches: 2,
  firstLaunchId: "c1",
  welcomeEmailLive: true,
  signups: 1204,
  workspaces: 1,
  firstWorkspaceId: "w1",
  postsScheduled: 9,
  newslettersSent: 3,
  lifecycle: true,
  products: 1,
  firstProductId: "p1",
  catalogReady: true,
  eventsReceived: true,
  journeys: 1,
  firstJourneyId: "j1",
  journeyPublished: true,
  journeyLive: false,
  lastEventAt: "2026-09-23T11:56:00Z",
  catalogSteps: 6,
} satisfies GrowthSignals & { lastEventAt: string | null; catalogSteps: number };
const week: WeekCounts = { signups: 38, emailsSent: 200, emailsOpened: 117, peopleInJourneys: 12, liveJourneys: 0 };
const labels = (stage: Parameters<typeof homeTiles>[0]) => homeTiles(stage, signals, week, now).map((t) => `${t.label}=${t.value}`);

describe("homeTiles", () => {
  it("fits the stage the brand is in", () => {
    expect(labels("launch")).toEqual(["Signups=1,204", "New this week=38", "Launches=2", "Emails sent=200"]);
    expect(labels("grow")).toEqual(["Signups=1,204", "New this week=38", "Posts scheduled=9", "Newsletters sent=3"]);
    expect(labels("product")).toEqual(["Signups=1,204", "Products connected=1", "Onboarding steps=6", "Last event=4 min ago"]);
    expect(labels("retain")).toEqual(["Live journeys=0", "People in journeys=12", "Emails sent=200", "Open rate=59%"]);
    expect(labels(null)).toEqual(labels("retain"));
  });

  it("shows — for anything unknown", () => {
    const tiles = homeTiles("launch", { ...signals, signups: null }, { ...week, signups: null, emailsSent: null }, now);
    expect(tiles.map((t) => t.value)).toEqual(["—", "—", "2", "—"]);
  });
});

describe("helpers", () => {
  it("ago", () => {
    expect(ago(null, now)).toBe("Never");
    expect(ago("2026-09-23T11:59:50Z", now)).toBe("Just now");
    expect(ago("2026-09-23T09:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-09-20T12:00:00Z", now)).toBe("3 days ago");
  });

  it("openRate needs sends", () => {
    expect(openRate({ ...week, emailsSent: 0 })).toBe("—");
    expect(openRate({ ...week, emailsOpened: null })).toBe("—");
  });
});
