import type { Journey } from "@/lib/types/journey";
import type { LifecycleJourney } from "@/lib/types/lifecycle";
import type { WaitlistJourneyStatus } from "./waitlistJourneyRows";

/**
 * ONE launch ↔ welcome-journey mapping (engine move D4). A launch's welcome
 * journey runs on the original waitlist engine (`journey_{campaignId}`) until
 * the launch moves to the lifecycle engine (its `lcjw_…` journey). Every screen
 * that shows or links to "the welcome journey" asks here, so none of them has
 * to know which engine a launch is on. Pure — safe for client components.
 */

export type LaunchEngine = "legacy" | "rehearsal" | "lifecycle";

/** Which engine emails the launch's new signups ("rehearsal" still sends from the original). */
export function launchEngine(c: { waitlistEngine?: LaunchEngine | null }): LaunchEngine {
  return c.waitlistEngine ?? "legacy";
}

export interface WelcomeJourney {
  engine: "legacy" | "lifecycle";
  /** Its id on its engine, when it exists. */
  journeyId: string | null;
  status: WaitlistJourneyStatus;
  emails: number;
  updatedAt: string | null;
  /** Where it's edited. */
  href: string;
  authoredBy: "human" | "agent" | null;
}

type LegacyLike = Pick<Journey, "id" | "status" | "graph" | "updatedAt">;
type LifecycleLike = Pick<LifecycleJourney, "id" | "status" | "draft" | "updatedAt" | "authoredBy">;

/** The launch's welcome journey on whichever engine it's on. */
export function welcomeJourney(
  campaign: { id: string; waitlistEngine?: LaunchEngine | null },
  legacy: LegacyLike | null,
  lifecycle: LifecycleLike | null,
): WelcomeJourney {
  if (launchEngine(campaign) === "lifecycle" && lifecycle) {
    return {
      engine: "lifecycle",
      journeyId: lifecycle.id,
      status: lifecycle.status === "archived" ? "not_started" : lifecycle.status,
      emails: lifecycle.draft.graph.nodes.filter((n) => n.type === "email").length,
      updatedAt: lifecycle.updatedAt,
      href: `/admin/lifecycle/${lifecycle.id}`,
      authoredBy: lifecycle.authoredBy ?? null,
    };
  }
  return {
    engine: "legacy",
    journeyId: legacy?.id ?? null,
    status: legacy?.status ?? "not_started",
    emails: legacy?.graph?.nodes?.filter((n) => n.type === "email").length ?? 0,
    updatedAt: legacy?.updatedAt || null,
    href: `/admin/launches/${campaign.id}/journey`,
    authoredBy: null,
  };
}
