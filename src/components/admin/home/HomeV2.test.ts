import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GrowthSignals } from "@/lib/nav/growth";

const { requireAdminContext, getTenantById, startBusinessProfile, loadGrowthSignals, loadWeekCounts, loadReview, redirect, homeNextAction } = vi.hoisted(() => ({
  requireAdminContext: vi.fn(),
  getTenantById: vi.fn(),
  startBusinessProfile: vi.fn(),
  loadGrowthSignals: vi.fn(),
  loadWeekCounts: vi.fn(),
  loadReview: vi.fn(),
  redirect: vi.fn(),
  homeNextAction: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ requireAdminContext }));
vi.mock("@/lib/tenant", () => ({ getTenantById }));
vi.mock("@/lib/tenant/control", () => ({ startBusinessProfile }));
vi.mock("@/lib/nav/growthSignals", () => ({ loadGrowthSignals, loadWeekCounts }));
vi.mock("@/lib/review/summary", () => ({ loadReview }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
vi.mock("../chat/DashboardChat", () => ({ DashboardChat: () => null }));
vi.mock("./AskChips", () => ({ AskChips: () => null }));
vi.mock("@/lib/nextAction/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/nextAction/service")>()),
  homeNextAction,
}));
vi.mock("./NextActionCard", () => ({
  NextActionCard: ({ initial, stale, children }: { initial: { cardId: string } | null; stale: boolean; children: ReactNode }) =>
    createElement("div", { "data-next-action": initial?.cardId ?? "none", "data-stale": String(stale) }, children),
}));

const { HomeV2 } = await import("./HomeV2");

const CTX = { tenantId: "ten_demo", region: "us" as const, userId: "uid_owner", role: "admin" as const, source: "idtoken" as const };

/** A brand with a launch and a welcome email live, nothing else: Get ready is current. */
const SIGNALS: GrowthSignals & { lastEventAt: null; catalogSteps: number; recordsEver: number } = {
  activeLaunches: 1,
  firstLaunchId: "c1",
  welcomeEmailLive: true,
  signups: 4,
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
  lastEventAt: null,
  catalogSteps: 0,
  recordsEver: 1,
};

const SWITCHES = ["ONBOARDING_ENABLED", "NEXT_ACTION_CARD_ENABLED", "NEXT_PUBLIC_HELP_PAGES_ENABLED", "NEXT_PUBLIC_SETUP_GUIDE_ENABLED", "NEXT_PUBLIC_LIFECYCLE_ENABLED", "LIFECYCLE_ENABLED"];

const profile = (answers: Record<string, string>) => ({ status: "done", via: "questions", answers, rev: 1, startedAt: "2026-11-25T09:00:00.000Z" });

async function renderHome(): Promise<string> {
  return renderToStaticMarkup((await HomeV2()) as ReactElement).replace(/&#x27;/g, "'");
}

/** The card's title and the first step it lists. */
function card(html: string): { title: string; firstStep: string } {
  const m = html.match(/<h2 class="text-sm font-semibold">([^<]*)<\/h2>[\s\S]*?<li[^>]*>[\s\S]*?<(?:a|span)[^>]*>([^<]+)</);
  return { title: m?.[1] ?? "", firstStep: m?.[2] ?? "" };
}

describe("Home's card of steps", () => {
  beforeEach(() => {
    for (const name of SWITCHES) delete process.env[name];
    process.env.NEXT_PUBLIC_HELP_PAGES_ENABLED = "true";
    process.env.NEXT_PUBLIC_SETUP_GUIDE_ENABLED = "true";
    requireAdminContext.mockResolvedValue(CTX);
    getTenantById.mockResolvedValue({ tenantName: "Fernhill Plants", businessProfile: profile({ run: "shop", stage: "established", want: "audience" }) });
    loadGrowthSignals.mockResolvedValue(SIGNALS);
    loadWeekCounts.mockResolvedValue({ signups: 1, emailsSent: null, emailsOpened: null, peopleInJourneys: null, liveJourneys: null });
    loadReview.mockResolvedValue({ aiLines: 0, items: [] });
    startBusinessProfile.mockResolvedValue(false);
  });
  afterEach(() => {
    for (const name of SWITCHES) delete process.env[name];
    vi.clearAllMocks();
  });

  it("is Next for the current stage with the switch off, whatever the brand answered", async () => {
    const html = await renderHome();
    expect(card(html)).toEqual({ title: "Next for get ready", firstStep: "Verify your sending domain" });
  });

  it("is Your next action with the switch on, listing the stage that fits the answers; the track stays on the current stage", async () => {
    process.env.ONBOARDING_ENABLED = "true";
    const html = await renderHome();
    expect(card(html).title).toBe("Your next action");
    // Wants an audience: content first, while Get ready is still where the brand is.
    expect(card(html).firstStep).toMatch(/^Start a content /);
    expect(html).toContain("0 of ");
    expect(html).toContain("Stage 1 of 5: Get ready.");
    expect(html).toMatch(/aria-current="step"[^>]*>(?:(?!<\/a>)[\s\S])*Get ready/);
    expect(redirect).not.toHaveBeenCalled();
    // No extra read: the answers come from the brand record Home already reads.
    expect(getTenantById).toHaveBeenCalledTimes(1);
  });

  it("sends a new brand's admin to the welcome without marking it shown (the welcome does that)", async () => {
    process.env.ONBOARDING_ENABLED = "true";
    getTenantById.mockResolvedValue({ tenantName: "Fernhill Plants" });
    loadGrowthSignals.mockResolvedValue({ ...SIGNALS, activeLaunches: 0, firstLaunchId: null, welcomeEmailLive: false, signups: 0, recordsEver: 0 });
    await renderHome();
    expect(redirect).toHaveBeenCalledWith("/admin/welcome");
    // A redirect can be lost to a racing refresh: Home writes nothing, so the next visit sends them again.
    expect(startBusinessProfile).not.toHaveBeenCalled();
  });

  it("is Your next action on the current stage after a skip", async () => {
    process.env.ONBOARDING_ENABLED = "true";
    getTenantById.mockResolvedValue({ tenantName: "Fernhill Plants", businessProfile: { ...profile({}), status: "skipped" } });
    expect(card(await renderHome())).toEqual({ title: "Your next action", firstStep: "Verify your sending domain" });
  });
  describe("with Vizzy's card (NEXT_ACTION_CARD_ENABLED)", () => {
    beforeEach(() => {
      process.env.ONBOARDING_ENABLED = "true";
      process.env.NEXT_ACTION_CARD_ENABLED = "true";
      homeNextAction.mockResolvedValue({ view: { cardId: "nc_0000000000000001", steps: [], note: null, done: 0, total: 0 }, stale: true });
    });

    it("draws the kept card for an admin of a brand that told Vizzy about itself, the steps list inside it as the fallback", async () => {
      const html = await renderHome();
      expect(html).toContain('data-next-action="nc_0000000000000001" data-stale="true"');
      // The fallback is the steps list PR A shows, and Needs you sits beside the card.
      expect(card(html).title).toBe("Your next action");
      expect(html).toContain("Needs you");
      expect(homeNextAction).toHaveBeenCalledWith(CTX, expect.objectContaining({ signals: SIGNALS }));
    });

    it("is exactly PR A's Home with the switch off", async () => {
      process.env.NEXT_ACTION_CARD_ENABLED = "false";
      const html = await renderHome();
      expect(html).not.toContain("data-next-action");
      expect(homeNextAction).not.toHaveBeenCalled();
      expect(card(html).title).toBe("Your next action");
    });

    it("keeps the steps list for a member, a skipped welcome, and a brand that never answered", async () => {
      requireAdminContext.mockResolvedValue({ ...CTX, role: "member" });
      expect(await renderHome()).not.toContain("data-next-action");
      requireAdminContext.mockResolvedValue(CTX);
      getTenantById.mockResolvedValue({ tenantName: "Fernhill Plants", businessProfile: { ...profile({}), status: "skipped" } });
      expect(await renderHome()).not.toContain("data-next-action");
      getTenantById.mockResolvedValue({ tenantName: "Fernhill Plants", businessProfile: { ...profile({}), status: "started" } });
      expect(await renderHome()).not.toContain("data-next-action");
      expect(homeNextAction).not.toHaveBeenCalled();
    });

    it("keeps the steps list when the card can't be read, and never breaks Home", async () => {
      homeNextAction.mockRejectedValue(new Error("regional database down"));
      const html = await renderHome();
      expect(html).not.toContain("data-next-action");
      expect(card(html).title).toBe("Your next action");
    });
  });
});
