import type { Broadcast } from "@/lib/types/broadcast";
import type { Journey } from "@/lib/types/journey";
import type { WaitlistJourneyStatus } from "./waitlistJourneyRows";

/**
 * Everything a launch sends, for its Emails tab (nav v2 phase 3): the welcome &
 * nurture journey, one-off broadcasts, and weekly newsletters sent from Content.
 * A window only — each is still edited in its own place. Pure.
 */

export interface SentSummary {
  sent: number;
  scheduled: number;
  drafts: number;
  latest: { name: string; sentAt: string; openRate: number | null } | null;
}

export interface LaunchEmails {
  journey: { status: WaitlistJourneyStatus; emails: number; updatedAt: string | null };
  broadcasts: SentSummary;
  newsletters: SentSummary & { workspaceIds: string[] };
}

type BroadcastLike = Pick<Broadcast, "name" | "status" | "sentAt" | "stats" | "audienceMode" | "sourceWorkspaceId">;

function summarise(list: BroadcastLike[]): SentSummary {
  const sent = list.filter((b) => b.status === "sent" && b.sentAt);
  const latest = [...sent].sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""))[0];
  return {
    sent: sent.length,
    scheduled: list.filter((b) => b.status === "scheduled" || b.status === "queued" || b.status === "sending").length,
    drafts: list.filter((b) => b.status === "draft").length,
    latest: latest ? { name: latest.name, sentAt: latest.sentAt!, openRate: latest.stats?.openRate ?? null } : null,
  };
}

export function launchEmails(
  journey: Pick<Journey, "status" | "graph" | "updatedAt"> | null,
  broadcasts: BroadcastLike[],
): LaunchEmails {
  const weekly = broadcasts.filter((b) => b.audienceMode === "weekly");
  return {
    journey: {
      status: journey?.status ?? "not_started",
      emails: journey?.graph?.nodes?.filter((n) => n.type === "email").length ?? 0,
      updatedAt: journey?.updatedAt || null,
    },
    broadcasts: summarise(broadcasts.filter((b) => b.audienceMode !== "weekly")),
    newsletters: {
      ...summarise(weekly),
      workspaceIds: [...new Set(weekly.map((b) => b.sourceWorkspaceId).filter((id): id is string => !!id))],
    },
  };
}

/** "61%" from a 0–1 rate. */
export function percent(rate: number | null): string | null {
  return rate == null ? null : `${Math.round(rate * 100)}%`;
}
