import { forTenant } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { Signup } from "@/lib/types/signup";
import { computeBqBreakdowns } from "./bigquery";

/**
 * Real-time campaign analytics computed from Firestore (tenant-scoped via
 * forTenant). For MVP scale this reads the campaign's signups and aggregates
 * in-app — exact and real-time. At large scale, repoint the heavier breakdowns
 * to the Firestore->BigQuery data lake (see docs/SETUP.md §11); the KPI shape
 * here is the contract either source must satisfy.
 */
export interface CountRow {
  value: string;
  count: number;
}

export interface CampaignAnalytics {
  campaignId: string;
  totalSignups: number; // verified + unverified (active list)
  verifiedSignups: number;
  unverifiedSignups: number;
  offboardedSignups: number;
  totalReferrals: number; // successful (credited) referrals
  referredSignups: number; // signups that arrived via a referral link
  organicSignups: number;
  lastSignupAt: string | null;
  lastReferralAt: string | null;
  utm: {
    source: CountRow[];
    medium: CountRow[];
    campaign: CountRow[];
    content: CountRow[];
    term: CountRow[];
  };
  referrerSources: CountRow[];
  signupsByDay: CountRow[];
  truncated: boolean;
}

const READ_CAP = 10000;
const TOP_N = 20;

export async function computeCampaignAnalytics(
  ctx: TenantContext,
  campaignId: string,
  db?: FirestoreLike,
): Promise<CampaignAnalytics> {
  // Equality-only query (tenantId + campaignId) — no composite index required.
  const rows = await forTenant(ctx, db).signups.find({
    where: [["campaignId", "==", campaignId]],
    limit: READ_CAP + 1,
  });
  const truncated = rows.length > READ_CAP;
  const signups = (truncated ? rows.slice(0, READ_CAP) : rows).filter(
    (s) => s.status !== "deleted",
  );
  return { campaignId, truncated, ...aggregateSignups(signups) };
}

/** Pure aggregation — exported for testing. */
export function aggregateSignups(
  signups: Signup[],
): Omit<CampaignAnalytics, "campaignId" | "truncated"> {
  let verifiedSignups = 0;
  let unverifiedSignups = 0;
  let offboardedSignups = 0;
  let totalReferrals = 0;
  let referredSignups = 0;
  let lastSignupAt: string | null = null;
  let lastReferralAt: string | null = null;

  const utm = {
    source: new Map<string, number>(),
    medium: new Map<string, number>(),
    campaign: new Map<string, number>(),
    content: new Map<string, number>(),
    term: new Map<string, number>(),
  };
  const referrers = new Map<string, number>();
  const byDay = new Map<string, number>();

  for (const s of signups) {
    if (s.status === "verified_active") verifiedSignups++;
    else if (s.status === "unverified") unverifiedSignups++;
    else if (s.status === "offboarded") offboardedSignups++;

    totalReferrals += s.amountReferred ?? 0;
    if (s.referredBySignupToken) {
      // Count referred over the SAME active population as totalSignups so that
      // Organic + Referred === Total always holds (offboarded members are not in
      // the active list). lastReferralAt still reflects any referral event.
      if (s.status === "verified_active" || s.status === "unverified") {
        referredSignups++;
      }
      if (!lastReferralAt || s.createdAt > lastReferralAt) lastReferralAt = s.createdAt;
    }
    if (!lastSignupAt || s.createdAt > lastSignupAt) lastSignupAt = s.createdAt;

    if (s.utm) {
      bump(utm.source, s.utm.source);
      bump(utm.medium, s.utm.medium);
      bump(utm.campaign, s.utm.campaign);
      bump(utm.content, s.utm.content);
      bump(utm.term, s.utm.term);
    }
    bump(referrers, hostOf(s.referrerUrl));
    bump(byDay, s.createdAt.slice(0, 10));
  }

  const totalSignups = verifiedSignups + unverifiedSignups;
  return {
    totalSignups,
    verifiedSignups,
    unverifiedSignups,
    offboardedSignups,
    totalReferrals,
    referredSignups,
    organicSignups: totalSignups - referredSignups, // referred ⊆ active ⇒ >= 0
    lastSignupAt,
    lastReferralAt,
    utm: {
      source: topRows(utm.source),
      medium: topRows(utm.medium),
      campaign: topRows(utm.campaign),
      content: topRows(utm.content),
      term: topRows(utm.term),
    },
    referrerSources: topRows(referrers),
    signupsByDay: [...byDay.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => (a.value < b.value ? -1 : 1)), // chronological
  };
}

function bump(map: Map<string, number>, key: string | null | undefined): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topRows(map: Map<string, number>): CountRow[] {
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_N);
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    // hostname (not host) — drops any port, matching BigQuery's NET.HOST and the
    // view-beacon referrerHost() so signup-referrer rows agree across sources.
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * The hybrid superset returned to the dashboard. Lifecycle KPIs always come from
 * Firestore (real-time, exact); the heavy breakdowns come from BigQuery when the
 * pipeline is configured, and two impression-only metrics (`viewsByDay`,
 * `viewReferrerSources`) are present only when widget view-tracking has data.
 * `source` lets the UI label provenance and show the PRD's warning tooltips.
 */
export interface HybridCampaignAnalytics extends CampaignAnalytics {
  /** Widget impressions over time — present only when view-tracking has data. */
  viewsByDay?: CountRow[];
  /** Referrer hosts of all widget VIEWS (true impressions, bot-filtered). */
  viewReferrerSources?: CountRow[];
  source: {
    /** "bigquery" only when the headline counts were taken from the uncapped BQ
     *  aggregation (i.e. the Firestore read was capped at 10k); else "firestore". */
    kpis: "firestore" | "bigquery";
    breakdowns: "firestore" | "bigquery";
    views: "bigquery" | "absent";
  };
}

/**
 * Hybrid analytics: real-time KPIs from Firestore + heavy/historical breakdowns
 * and widget-view metrics from BigQuery. Falls back to the Firestore-only
 * breakdowns when the BigQuery pipeline is off, unconfigured, or errors — so the
 * dashboard renders identically to today until the flag is flipped in a
 * configured environment. `computeCampaignAnalytics` stays the Firestore seam.
 */
export async function computeHybridAnalytics(
  ctx: TenantContext,
  campaignId: string,
  db?: FirestoreLike,
): Promise<HybridCampaignAnalytics> {
  // 1. Lifecycle KPIs always from Firestore (exact + instant) for normal sizes.
  const fs = await computeCampaignAnalytics(ctx, campaignId, db);
  // 2. Heavy breakdowns + impressions from BigQuery; null on any off-ramp.
  const bq = await computeBqBreakdowns(ctx, campaignId).catch(() => null);
  const views: "bigquery" | "absent" =
    bq && bq.hasViews && bq.viewsByDay.length > 0 ? "bigquery" : "absent";

  if (!bq) {
    return {
      ...fs,
      source: { kpis: "firestore", breakdowns: "firestore", views: "absent" },
    };
  }

  // 3. Lag guard: if BigQuery has no signup rows yet but Firestore shows signups,
  //    the mirror is still catching up (at-least-once, async). Keep the Firestore
  //    breakdowns + KPIs rather than blanking the dashboard; widget views are an
  //    independent table, so still surface them.
  const bqSignupsReady = bq.signupsByDay.length > 0 || fs.totalSignups === 0;
  if (!bqSignupsReady) {
    return {
      ...fs,
      viewsByDay: bq.viewsByDay,
      viewReferrerSources: bq.viewReferrerSources,
      source: { kpis: "firestore", breakdowns: "firestore", views },
    };
  }

  // 4. BigQuery signup data is ready → heavy breakdowns come from BigQuery. When
  //    the Firestore KPI aggregation was CAPPED at 10k, replace the headline count
  //    cards with the uncapped BigQuery counts so totals are correct at scale
  //    (last-event timestamps stay Firestore real-time). Otherwise keep the
  //    Firestore real-time KPIs. Only clear the truncation banner once the cards
  //    actually reflect uncapped data.
  const useBqKpis = fs.truncated && bq.kpis !== null;
  return {
    ...fs,
    ...(useBqKpis ? bq.kpis! : {}),
    truncated: useBqKpis ? false : fs.truncated,
    utm: bq.utm,
    referrerSources: bq.referrerSources,
    signupsByDay: bq.signupsByDay,
    viewsByDay: bq.viewsByDay,
    viewReferrerSources: bq.viewReferrerSources,
    source: {
      kpis: useBqKpis ? "bigquery" : "firestore",
      breakdowns: "bigquery",
      views,
    },
  };
}
