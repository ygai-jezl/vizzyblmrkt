/**
 * The growth path (nav v2 phase 2): how far a brand has got through the four
 * stages a customer walks — launch a waitlist, grow an audience with content,
 * connect the product, then onboard and retain its users. Pure: the signals
 * come from growthSignals.ts, so this is unit-tested on its own.
 *
 * A stage is "done" when its outcome exists (not when a page was visited), so a
 * customer who connects a product before starting content sees Products done and
 * Content still current. Stages 3–4 exist only where lifecycle journeys do.
 */

import { programmeWord } from "./terms";

export type StageKey = "launch" | "grow" | "product" | "retain";
export type StageStatus = "done" | "current" | "next";

/** Facts about the brand, read by loadGrowthSignals. Counts are never negative. */
export interface GrowthSignals {
  /** Launches not archived. */
  activeLaunches: number;
  /** The newest active launch, for deep links. */
  firstLaunchId: string | null;
  /** Any launch's welcome (nurture) journey is active. */
  welcomeEmailLive: boolean;
  /** Verified + unverified signups across launches; null when unknown. */
  signups: number | null;
  /** Content workspaces not archived. */
  workspaces: number;
  firstWorkspaceId: string | null;
  /** Posts ever scheduled for publishing (any status). */
  postsScheduled: number;
  /** Weekly newsletters sent to a launch's audience. */
  newslettersSent: number;
  /** Lifecycle journeys exist in this environment (stages 3–4). */
  lifecycle: boolean;
  /** Connected products (custom, not revoked; sandboxes don't count). */
  products: number;
  firstProductId: string | null;
  /** A connected product has onboarding steps in its catalog. */
  catalogReady: boolean;
  /** A connected product has sent at least one event. */
  eventsReceived: boolean;
  /** Lifecycle journeys not archived. */
  journeys: number;
  firstJourneyId: string | null;
  /** A lifecycle journey has a published version (any delivery mode). */
  journeyPublished: boolean;
  /** A lifecycle journey is active in live mode. */
  journeyLive: boolean;
  /** Waitlist members invited into the product (nav v2 phase 4); absent while invites are off. */
  invited?: number | null;
}

export interface NextStep {
  label: string;
  /** Short progress note, e.g. "4 of 10". */
  detail?: string;
  done: boolean;
  href: string;
}

export interface StageView {
  key: StageKey;
  label: string;
  status: StageStatus;
  /** One line for the track, e.g. "412 signups" or "When your app is ready". */
  summary: string;
  steps: NextStep[];
}

export interface Growth {
  stages: StageView[];
  /** The first stage not done; null once every stage is running. */
  current: StageKey | null;
  /** Nothing set up yet: Home shows the first-run version. */
  firstRun: boolean;
  allRunning: boolean;
}

/** "Get your first N signups" — the launch stage's traction step. */
export const SIGNUP_GOAL = 10;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

function launchStage(s: GrowthSignals): Omit<StageView, "status"> {
  const launchHref = (tab: string) => (s.firstLaunchId ? `/admin/launches/${s.firstLaunchId}/${tab}` : "/admin/launches");
  const signups = s.signups ?? 0;
  return {
    key: "launch",
    label: "Launch",
    summary: s.activeLaunches === 0 ? "Start with a waitlist" : s.signups === null ? "Live" : plural(signups, "signup"),
    steps: [
      { label: "Create a launch", done: s.activeLaunches > 0, href: "/admin/launches/new" },
      { label: "Turn on the welcome email", done: s.welcomeEmailLive, href: launchHref("journey") },
      {
        label: `Get your first ${SIGNUP_GOAL} signups`,
        detail: `${Math.min(signups, SIGNUP_GOAL)} of ${SIGNUP_GOAL}`,
        done: signups >= SIGNUP_GOAL,
        href: launchHref("widget"),
      },
    ],
  };
}

function growStage(s: GrowthSignals): Omit<StageView, "status"> {
  const wsHref = (tab: string) => (s.firstWorkspaceId ? `/admin/workspace/${s.firstWorkspaceId}/${tab}` : "/admin/workspace");
  return {
    key: "grow",
    label: "Grow audience",
    summary:
      s.workspaces === 0
        ? "Grow the list with content"
        : s.postsScheduled > 0
          ? `${plural(s.postsScheduled, "post")} scheduled`
          : "No posts scheduled yet",
    steps: [
      { label: `Start a content ${programmeWord().one}`, done: s.workspaces > 0, href: "/admin/workspace" },
      { label: "Schedule your first post", done: s.postsScheduled > 0, href: wsHref("distribute") },
      { label: "Send a newsletter to your waitlist", done: s.newslettersSent > 0, href: wsHref("weekly") },
    ],
  };
}

function productStage(s: GrowthSignals): Omit<StageView, "status"> {
  const productHref = (suffix = "") => (s.firstProductId ? `/admin/products/${s.firstProductId}${suffix}` : "/admin/products");
  const setUp = [s.products > 0, s.catalogReady, s.eventsReceived].filter(Boolean).length;
  return {
    key: "product",
    label: "Launch product",
    summary: s.products === 0 ? "When your app is ready" : s.eventsReceived && s.catalogReady ? "Receiving events" : `${setUp} of 3 set up`,
    steps: [
      { label: "Connect your product", done: s.products > 0, href: "/admin/products" },
      { label: "Learn it from your repo", done: s.catalogReady, href: productHref("?tab=learn") },
      { label: "Receive your first event", done: s.eventsReceived, href: productHref() },
      // Nav v2 phase 4: bring the waitlist in. A step only — the stage's done rule is unchanged.
      ...(s.invited != null
        ? [
            {
              label: "Invite your waitlist",
              done: s.invited > 0,
              href: s.firstLaunchId ? `/admin/launches/${s.firstLaunchId}/invites` : "/admin/launches",
            },
          ]
        : []),
    ],
  };
}

function retainStage(s: GrowthSignals): Omit<StageView, "status"> {
  const journeyHref = s.firstJourneyId ? `/admin/lifecycle/${s.firstJourneyId}` : "/admin/lifecycle";
  return {
    key: "retain",
    label: "Onboard & retain",
    summary:
      s.journeyLive
        ? "Live"
        : s.journeyPublished
          ? "In test mode"
          : s.journeys > 0
            ? "Draft journey"
            : s.products === 0
              ? "After your product is connected"
              : "Build an onboarding journey",
    steps: [
      { label: "Build an onboarding journey", done: s.journeys > 0, href: "/admin/lifecycle" },
      { label: "Publish it in test mode", done: s.journeyPublished, href: journeyHref },
      { label: "Switch it to live", done: s.journeyLive, href: journeyHref },
    ],
  };
}

const DONE: Record<StageKey, (s: GrowthSignals) => boolean> = {
  launch: (s) => s.activeLaunches > 0 && s.welcomeEmailLive,
  grow: (s) => s.workspaces > 0 && (s.postsScheduled > 0 || s.newslettersSent > 0),
  product: (s) => s.products > 0 && s.catalogReady && s.eventsReceived,
  retain: (s) => s.journeyLive,
};

export function computeGrowth(s: GrowthSignals): Growth {
  const views = [launchStage(s), growStage(s), ...(s.lifecycle ? [productStage(s), retainStage(s)] : [])];
  const current = views.find((v) => !DONE[v.key](s))?.key ?? null;
  const stages: StageView[] = views.map((v) => ({
    ...v,
    status: DONE[v.key](s) ? "done" : v.key === current ? "current" : "next",
  }));
  const firstRun = s.activeLaunches === 0 && s.workspaces === 0 && s.products === 0 && s.journeys === 0;
  return { stages, current, firstRun, allRunning: current === null };
}

/** The first step still to do in a stage (the Home call to action). */
export function nextStepOf(stage: StageView): NextStep | null {
  return stage.steps.find((step) => !step.done) ?? null;
}

/** Sidebar Grow items by stage, for the progress dots. */
export const STAGE_NAV_KEY: Record<StageKey, "launches" | "content" | "products" | "journeys"> = {
  launch: "launches",
  grow: "content",
  product: "products",
  retain: "journeys",
};
