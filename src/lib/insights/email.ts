import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { computeBqEmailStats } from "@/lib/analytics/bigquery";
import { memo } from "./cache";
import { emailHref, emailNames } from "./names";
import { loadMovedJourneys } from "@/lib/journey/launchJourneyLoad";

/**
 * Insights › Email (nav v2 phase 4): every automated email programme (welcome
 * journeys, product invites, lifecycle journeys) with sends, unique opens and
 * unique clicks, plus recent broadcasts. BigQuery gives the last 30 days; without
 * it, each programme's all-time counts come from equality-only count() reads.
 */

export interface EmailProgrammeRow {
  id: string;
  name: string;
  href: string;
  sends: number;
  openRate: number | null;
  clickRate: number | null;
}

export interface BroadcastRow {
  id: string;
  name: string;
  campaignId: string;
  sentAt: string | null;
  sends: number;
  openRate: number | null;
  clickRate: number | null;
}

export interface EmailInsights {
  programmes: EmailProgrammeRow[];
  broadcasts: BroadcastRow[];
  basis: "last 30 days" | "all time";
}

const MAX_ROWS = 20;

async function programmeIds(ctx: TenantContext, opts: { lifecycle: boolean; invites: boolean }, db?: FirestoreLike) {
  const repos = forTenant(ctx, db);
  const [journeys, lifecycle, waves] = await Promise.all([
    repos.journeys.find({ limit: 50 }).catch(() => []),
    opts.lifecycle ? repos.lifecycleJourneys.find({ limit: 50 }).catch(() => []) : [],
    opts.invites ? repos.inviteWaves.find({ where: [["status", "==", "sent"]], limit: 50 }).catch(() => []) : [],
  ]);
  const moved = await loadMovedJourneys(ctx, db);
  return [
    ...journeys.filter((j) => j.status !== "draft").map((j) => j.id),
    ...[...new Set(waves.map((w) => `invite_${w.campaignId}`))],
    ...lifecycle.filter((j) => j.status !== "archived" && j.publishedVersion != null && j.audience?.kind !== "waitlist").map((j) => j.id),
    // Launches' welcome journeys on the lifecycle engine (engine move): folded into the launch's row below.
    ...[...moved.values()].filter((j) => j.publishedVersion != null).map((j) => j.id),
  ].slice(0, MAX_ROWS);
}

export async function loadEmailInsights(
  ctx: TenantContext,
  opts: { lifecycle: boolean; invites: boolean },
  db?: FirestoreLike,
): Promise<EmailInsights> {
  const repos = forTenant(ctx, db);
  const sentBroadcasts = repos.broadcasts.find({ where: [["status", "==", "sent"]], limit: 100 }).catch(() => []);
  const bq = db ? null : await memo(`emails:${ctx.tenantId}`, () => computeBqEmailStats(ctx, { days: 30 }));

  let totals: Map<string, { sends: number; opens: number; clicks: number }>;
  let basis: EmailInsights["basis"];
  if (bq) {
    basis = "last 30 days";
    totals = new Map();
    for (const s of bq) {
      const t = totals.get(s.journeyId) ?? { sends: 0, opens: 0, clicks: 0 };
      totals.set(s.journeyId, { sends: t.sends + s.sends, opens: t.opens + s.opens, clicks: t.clicks + s.clicks });
    }
  } else {
    basis = "all time";
    const ids = await programmeIds(ctx, opts, db);
    const counted = await Promise.all(
      ids.map(async (id) => {
        const n = (type: string) =>
          repos.emailEvents.count([["journeyId", "==", id], ["type", "==", type]]).catch(() => 0);
        const [sends, opens, clicks] = await Promise.all([n("send"), n("open"), n("click")]);
        return [id, { sends, opens, clicks }] as const;
      }),
    );
    totals = new Map(counted);
  }

  // A launch's welcome emails are one programme, whichever engine sent them (engine move).
  const moved = await loadMovedJourneys(ctx, db).catch(() => new Map());
  for (const j of moved.values()) {
    const t = totals.get(j.id);
    if (!t || j.audience?.kind !== "waitlist") continue;
    const key = `journey_${j.audience.campaignId}`;
    const into = totals.get(key) ?? { sends: 0, opens: 0, clicks: 0 };
    totals.set(key, { sends: into.sends + t.sends, opens: into.opens + t.opens, clicks: into.clicks + t.clicks });
    totals.delete(j.id);
  }

  const ids = [...totals.keys()].filter((id) => (totals.get(id)?.sends ?? 0) > 0).slice(0, MAX_ROWS);
  const names = await emailNames(ctx, ids, db).catch(() => new Map<string, string>());
  const programmes = ids
    .map((id) => {
      const t = totals.get(id)!;
      return {
        id,
        name: names.get(id) ?? id,
        href: emailHref(id),
        sends: t.sends,
        // Opens can exceed sends in all-time event counts (re-opens); cap the rate at 100%.
        openRate: t.sends ? Math.min(1, t.opens / t.sends) : null,
        clickRate: t.sends ? Math.min(1, t.clicks / t.sends) : null,
      };
    })
    .sort((a, b) => b.sends - a.sends);

  const broadcasts = (await sentBroadcasts)
    .sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""))
    .slice(0, MAX_ROWS)
    .map((b) => ({
      id: b.id,
      name: b.name,
      campaignId: b.campaignId,
      sentAt: b.sentAt ?? null,
      sends: b.stats?.emailsSent ?? 0,
      openRate: b.stats?.openRate ?? null,
      clickRate: b.stats?.clickRate ?? null,
    }));
  return { programmes, broadcasts, basis };
}
