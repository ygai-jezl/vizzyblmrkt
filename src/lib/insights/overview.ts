import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { CountRow } from "@/lib/analytics/analytics";
import { computeBqEmailStats, computeBqSignupSources } from "@/lib/analytics/bigquery";
import { environmentOf } from "@/lib/connect/environments";
import { loadWeekCounts } from "@/lib/nav/growthSignals";
import type { Tile } from "@/lib/nav/homeTiles";
import { loadFunnel, type Funnel } from "@/lib/invites/funnel";
import { memo } from "./cache";
import { bqSourceCaseSql, classifySignupSource, CONTENT_SOURCES, SOURCE_LABEL, type SourceClass } from "./sources";
import { insightsTiles } from "./tiles";
import { emailNames } from "./names";

/**
 * Insights › Overview (nav v2 phase 4): four tiles, twelve weeks of signups, where
 * signups come from, the best email, and the funnel. Every read fails soft to "—".
 * No new indexes: ranges reuse signups(tenantId, createdAt) and
 * email_events(tenantId, type, createdAt); everything else is equality-only.
 */

const DAY = 86_400_000;

async function soft<T>(label: string, p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (err) {
    console.warn(`[insights] ${label} unavailable:`, err instanceof Error ? err.message : err);
    return fallback;
  }
}

export interface WeekPoint {
  /** ISO date the 7-day window starts. */
  start: string;
  signups: number | null;
}

export interface SourceRow {
  key: SourceClass;
  label: string;
  count: number;
  content: boolean;
}

export interface SignupSources {
  rows: SourceRow[];
  total: number;
  contentCampaigns: CountRow[];
  /** Where the numbers come from; "recent_signups" = the newest 5,000 in the window. */
  basis: "bigquery" | "recent_signups" | "none";
  sampled: boolean;
}

export interface InsightsOverview {
  tiles: Tile[];
  weeks: WeekPoint[];
  sources: SignupSources;
  bestEmail: { name: string; clickRate: number; sends: number } | null;
  funnel: Funnel | null;
}

/** Twelve rolling 7-day windows of signups, oldest first (12 count() reads). */
export async function loadWeeklySignups(ctx: TenantContext, now: Date, db?: FirestoreLike): Promise<WeekPoint[]> {
  const repo = forTenant(ctx, db).signups;
  const windows = Array.from({ length: 12 }, (_, i) => {
    const end = new Date(now.getTime() - i * 7 * DAY);
    const start = new Date(end.getTime() - 7 * DAY);
    return { start, end };
  }).reverse();
  return Promise.all(
    windows.map(async ({ start, end }) => ({
      start: start.toISOString().slice(0, 10),
      signups: await soft(
        "weekly signups",
        repo.count([
          ["createdAt", ">=", start.toISOString()],
          ["createdAt", "<", end.toISOString()],
        ]),
        null as number | null,
      ),
    })),
  );
}

const ORDER = Object.keys(SOURCE_LABEL) as SourceClass[];

function sourceRows(counts: Map<string, number>): SourceRow[] {
  return [...counts.entries()]
    .filter(([key]) => key in SOURCE_LABEL)
    .map(([key, count]) => ({
      key: key as SourceClass,
      label: SOURCE_LABEL[key as SourceClass],
      count,
      content: CONTENT_SOURCES.has(key as SourceClass),
    }))
    // Ties keep the rule table's order, so the list reads the same every time.
    .sort((a, b) => b.count - a.count || ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
}

/** Signups in the last 30 days by estimated source: BigQuery when on, else the newest 5,000 signups. */
export async function loadSignupSources(ctx: TenantContext, now: Date, db?: FirestoreLike): Promise<SignupSources> {
  const bq = db
    ? null
    : await memo(`sources:${ctx.tenantId}`, () =>
        computeBqSignupSources(ctx, { days: 30, caseSql: bqSourceCaseSql(), contentKeys: [...CONTENT_SOURCES] }),
      );
  if (bq) {
    const counts = new Map(bq.classes.map((c) => [c.value, c.count]));
    const rows = sourceRows(counts);
    return { rows, total: rows.reduce((n, r) => n + r.count, 0), contentCampaigns: bq.contentCampaigns, basis: "bigquery", sampled: false };
  }
  const since = new Date(now.getTime() - 30 * DAY).toISOString();
  // Newest first, so a busy month is sampled from its latest signups (index:
  // signups tenantId ASC, createdAt DESC).
  const recent = await soft(
    "recent signups",
    forTenant(ctx, db).signups.find({ where: [["createdAt", ">=", since]], orderBy: [["createdAt", "desc"]], limit: 5000 }),
    null,
  );
  if (!recent) return { rows: [], total: 0, contentCampaigns: [], basis: "none", sampled: false };
  const counts = new Map<string, number>();
  const campaigns = new Map<string, number>();
  for (const s of recent) {
    if (s.status === "deleted") continue;
    const key = classifySignupSource(s);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const utmCampaign = s.utm?.campaign?.trim();
    if (CONTENT_SOURCES.has(key) && utmCampaign) campaigns.set(utmCampaign, (campaigns.get(utmCampaign) ?? 0) + 1);
  }
  const rows = sourceRows(counts);
  return {
    rows,
    total: rows.reduce((n, r) => n + r.count, 0),
    contentCampaigns: [...campaigns.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    basis: "recent_signups",
    sampled: recent.length >= 5000,
  };
}

/** Email opens over the last 7 days: journey + lifecycle events, plus broadcasts sent in the window. */
async function loadEmailWeek(ctx: TenantContext, now: Date, lifecycle: boolean, db?: FirestoreLike) {
  const [week, broadcasts] = await Promise.all([
    loadWeekCounts(ctx, { lifecycle, now }, db),
    soft("broadcasts", forTenant(ctx, db).broadcasts.find({ where: [["status", "==", "sent"]], limit: 200 }), []),
  ]);
  const since = new Date(now.getTime() - 7 * DAY).toISOString();
  let bSends = 0;
  let bOpens = 0;
  for (const b of broadcasts) {
    if (!b.sentAt || b.sentAt < since) continue;
    const sent = b.stats?.emailsSent ?? 0;
    bSends += sent;
    bOpens += Math.round((b.stats?.openRate ?? 0) * sent);
  }
  return {
    sends: week.emailsSent == null ? null : week.emailsSent + bSends,
    opens: week.emailsOpened == null ? null : week.emailsOpened + bOpens,
    signupsThisWeek: week.signups,
  };
}

/** Activated share of users on live production products, or null when there's no product yet. */
async function loadActivation(ctx: TenantContext, db?: FirestoreLike) {
  const repos = forTenant(ctx, db);
  const connections = await soft("connections", repos.productConnections.find({ limit: 100 }), []);
  const live = connections.filter((c) => c.kind === "custom" && c.status !== "revoked" && environmentOf(c) !== "staging");
  if (live.length === 0) return null;
  const counts = await Promise.all(
    live.map(async (c) => ({
      users: await soft("product users", repos.productUsers.count([["connectionId", "==", c.id], ["status", "==", "active"]]), 0),
      activated: await soft(
        "activated users",
        repos.productUsers.count([["connectionId", "==", c.id], ["status", "==", "active"], ["activated", "==", true]]),
        0,
      ),
    })),
  );
  return counts.reduce((a, b) => ({ users: a.users + b.users, activated: a.activated + b.activated }), { users: 0, activated: 0 });
}

export async function loadInsightsOverview(
  ctx: TenantContext,
  opts: { lifecycle: boolean; invites: boolean; now?: Date },
  db?: FirestoreLike,
): Promise<InsightsOverview> {
  const now = opts.now ?? new Date();
  const repos = forTenant(ctx, db);
  const [weeks, sources, email, activation, verified, total, funnel, stats] = await Promise.all([
    loadWeeklySignups(ctx, now, db),
    loadSignupSources(ctx, now, db),
    loadEmailWeek(ctx, now, opts.lifecycle, db),
    opts.lifecycle ? loadActivation(ctx, db) : Promise.resolve(null),
    soft("verified", repos.signups.count([["status", "==", "verified_active"]]), null as number | null),
    soft("unverified", repos.signups.count([["status", "==", "unverified"]]), null as number | null),
    opts.invites ? soft("funnel", loadFunnel(ctx, {}, db), null) : Promise.resolve(null),
    db ? Promise.resolve(null) : memo(`emails:${ctx.tenantId}`, () => computeBqEmailStats(ctx, { days: 30 })),
  ]);

  const lastWeek = weeks.at(-2)?.signups ?? null;
  const count = (key: SourceClass) => sources.rows.find((r) => r.key === key)?.count ?? 0;
  const content = sources.rows.filter((r) => r.content).reduce((n, r) => n + r.count, 0);
  const tiles = insightsTiles({
    signupsThisWeek: email.signupsThisWeek,
    signupsLastWeek: lastWeek,
    emails: { sends: email.sends, opens: email.opens },
    sources: { content, referral: count("referral"), total: sources.total, basis: sources.basis },
    activation,
    verified: verified != null && total != null ? { verified, total: verified + total } : null,
  });

  // The best email by click rate (at least 50 sends), named for a person.
  let bestEmail: InsightsOverview["bestEmail"] = null;
  if (stats?.length) {
    const best = stats
      .filter((s) => s.sends >= 50)
      .sort((a, b) => b.clicks / b.sends - a.clicks / a.sends)[0];
    if (best) {
      const names = await soft("email names", emailNames(ctx, [best.journeyId], db), new Map<string, string>());
      bestEmail = { name: names.get(best.journeyId) ?? "An email", clickRate: best.clicks / best.sends, sends: best.sends };
    }
  }
  return { tiles, weeks, sources, bestEmail, funnel };
}
