import { forTenant } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { Signup } from "@/lib/types/signup";

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
      referredSignups++;
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
    organicSignups: Math.max(0, totalSignups - referredSignups),
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
    return new URL(url).host || null;
  } catch {
    return null;
  }
}
