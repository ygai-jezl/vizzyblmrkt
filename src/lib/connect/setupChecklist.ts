import type { ProductEnvironment } from "./environments";

/**
 * A product's setup, in the order the work happens (nav v2 phase 3): the Setup
 * tab shows it until everything is done. Each step says where to do it — a tab
 * on this product, or a page elsewhere. Pure; the tab gathers the inputs from the
 * integration guide and the journeys list.
 */

type GuideStatus = "done" | "todo" | "info";

export interface SetupInput {
  kind: "custom" | "sandbox";
  environment: ProductEnvironment | null;
  guide: { catalog: GuideStatus; eventsReceived: GuideStatus; contextEndpoint: GuideStatus };
  /** Lifecycle journeys on this connection (not archived). */
  journeys: Array<{ status: string; deliveryMode: string; publishedVersion: number | null }>;
  /** For staging: the production connection of the same product, and whether it has a journey. */
  production: { id: string; hasJourney: boolean } | null;
  /** Nav v2 phase 4, when invites are on: this product's sign-up link and invite numbers. */
  invites?: { hasSignupUrl: boolean; invited: number; signedUp: number } | null;
}

export interface SetupStep {
  id: string;
  label: string;
  detail: string;
  done: boolean;
  /** Shown, but not needed for "Setup complete" (the context endpoint, with API v2). */
  optional?: boolean;
  /** A tab on this product's page… */
  tab?: "learn" | "catalog" | "guide" | "events" | "test" | "settings";
  /** …or a page elsewhere. */
  href?: string;
}

export function setupSteps(input: SetupInput): SetupStep[] {
  const custom = input.kind === "custom";
  const hasJourney = input.journeys.length > 0;
  const live = input.journeys.some((j) => j.status === "active" && j.deliveryMode === "live" && j.publishedVersion != null);
  const steps: SetupStep[] = [
    { id: "connect", label: "Create the connection", detail: "Keys issued.", done: true },
    {
      id: "catalog",
      label: custom ? "Learn your product from its repo" : "Check the catalog",
      detail: "Onboarding steps, events and facts your journeys can use.",
      done: input.guide.catalog === "done",
      tab: custom ? "learn" : "catalog",
    },
    {
      id: "events",
      label: "Receive your users' sign-ups and steps",
      detail: custom
        ? "Your developers send each user's state to the API. The Integration guide has a prompt for their coding agent."
        : "Send a sign-up from the Sandbox tab.",
      done: input.guide.eventsReceived === "done",
      tab: custom ? "guide" : "events",
    },
    {
      id: "context",
      label: "Answer the context request (optional)",
      detail: "Only for values that change too fast to send: before each email we ask your product for that person's latest facts.",
      done: input.guide.contextEndpoint === "done",
      optional: true,
      tab: "test",
    },
    {
      id: "journey",
      label: "Build an onboarding journey",
      detail: "Start from the 7-day onboarding template.",
      done: hasJourney,
      href: "/admin/lifecycle",
    },
  ];
  if (input.environment === "staging") {
    steps.push({
      id: "promote",
      label: "Promote it to Production",
      detail: input.production
        ? "When it works here, use “Promote to Production” on the journey."
        : "Connect your production app first, then promote the journey from here.",
      done: !!input.production?.hasJourney,
      href: input.production ? "/admin/lifecycle" : "/admin/products",
    });
  } else {
    steps.push({
      id: "live",
      label: "Switch a journey to live",
      detail: "Test mode sends only to your test users; live sends to everyone.",
      done: live,
      href: "/admin/lifecycle",
    });
    // Invite the waitlist in (production only; staging promotes instead).
    if (custom && input.invites) {
      const { hasSignupUrl, invited, signedUp } = input.invites;
      steps.push({
        id: "invite",
        label: "Invite your waitlist",
        detail:
          invited > 0
            ? `${invited.toLocaleString("en-GB")} invited · ${signedUp.toLocaleString("en-GB")} signed up.`
            : hasSignupUrl
              ? "Invite people from a launch's waitlist into your product."
              : "Add your app's sign-up link in Settings, then invite from a launch.",
        done: invited > 0,
        ...(hasSignupUrl ? { href: "/admin/launches" } : { tab: "settings" as const }),
      });
    }
  }
  return steps;
}
