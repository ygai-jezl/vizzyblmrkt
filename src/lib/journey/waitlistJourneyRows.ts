import type { Journey } from "@/lib/types/journey";

/**
 * Waitlist journeys for the one Journeys list (nav v2 phase 3) — the pure half,
 * safe for client components. Every launch has exactly one welcome & nurture
 * journey (`journey_{campaignId}`), created on first save — so a launch without a
 * journey doc is listed as "Not started". The loader is in waitlistJourneys.ts.
 */

export type WaitlistJourneyStatus = "active" | "paused" | "draft" | "not_started";

export interface WaitlistJourneyRow {
  campaignId: string;
  launchName: string;
  archived: boolean;
  status: WaitlistJourneyStatus;
  emails: number;
  updatedAt: string | null;
  href: string;
}

const ORDER: Record<WaitlistJourneyStatus, number> = { active: 0, paused: 1, draft: 2, not_started: 3 };

export function waitlistJourneyRows(
  campaigns: Array<{ id: string; waitlistName: string; archivedAt?: string | null }>,
  journeys: Array<Pick<Journey, "campaignId" | "status" | "graph" | "updatedAt">>,
): WaitlistJourneyRow[] {
  const byCampaign = new Map(journeys.map((j) => [j.campaignId, j]));
  return campaigns
    .map((c) => {
      const j = byCampaign.get(c.id);
      return {
        campaignId: c.id,
        launchName: c.waitlistName || c.id,
        archived: !!c.archivedAt,
        status: (j?.status ?? "not_started") as WaitlistJourneyStatus,
        emails: j?.graph?.nodes?.filter((n) => n.type === "email").length ?? 0,
        updatedAt: j?.updatedAt ?? null,
        href: `/admin/launches/${c.id}/journey`,
      };
    })
    .sort(
      (a, b) =>
        Number(a.archived) - Number(b.archived) ||
        ORDER[a.status] - ORDER[b.status] ||
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
}

/** The words for a waitlist journey's status, shared by Journeys and a launch's Emails tab. */
export const WAITLIST_STATUS_LABEL: Record<WaitlistJourneyStatus, string> = {
  active: "Live",
  paused: "Paused",
  draft: "Draft",
  not_started: "Not started",
};
