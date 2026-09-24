import type { BigQuery } from "@google-cloud/bigquery";
import type { Region } from "@/lib/types/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { CountRow } from "./analytics";

/**
 * BigQuery-backed analytics breakdowns (Phase 2 "hybrid" path, docs/SETUP.md §11).
 *
 * The dashboard keeps its real-time lifecycle KPIs on Firestore (exact + instant);
 * THIS module serves the heavy/historical breakdowns and the widget-impression
 * metrics from the Firestore→BigQuery data lake, which Firestore can't produce at
 * scale (10k/50k in-app caps) or at all (impressions never touch Firestore).
 *
 * GRACEFUL DEGRADATION is the contract: every public function returns `null` (or
 * empty sub-results) when the pipeline is off, unconfigured, or errors — the
 * callers then fall back to the Firestore path. So local/dev with no GCP creds
 * and the flag unset behaves EXACTLY as before. Mirrors the agent-runtime
 * "not configured" pattern (src/app/api/admin/agent/chat).
 *
 * TENANT ISOLATION: BigQuery RLS is not parameter-driven (it binds to IAM
 * principals), so isolation is enforced HERE in app code — every query is
 * parameterized with @tenant_id bound from the SERVER-derived TenantContext, and
 * the dataset/project identifiers (which can't be query params) come only from a
 * fixed server-side env allowlist, never from user input. See
 * docs/VALIDATION-FINDINGS.md and docs/ARCHITECTURE-AND-DELIVERY.md §4.
 */

const TOP_N = 20;

/** Master switch — off by default; flipped per environment after backfill. */
export function analyticsBqEnabled(): boolean {
  return process.env.ANALYTICS_BQ_ENABLED === "true";
}

/** BigQuery job location per residency region (must match the dataset's region). */
const BQ_LOCATION: Record<Region, string> = {
  us: "US",
  eu: "EU",
  asia: "asia-southeast1",
};

/** Identifiers (dataset/project) can't be bound as params → strict allowlists
 *  before they're interpolated into SQL (defense in depth; both are env-only). */
const DATASET_ID_RE = /^[A-Za-z0-9_]+$/;
const PROJECT_ID_RE = /^[A-Za-z0-9:_.-]+$/;

function datasetForRegion(region: Region): string | null {
  const raw = {
    us: process.env.BQ_DATASET_US,
    eu: process.env.BQ_DATASET_EU,
    asia: process.env.BQ_DATASET_ASIA,
  }[region];
  const id = raw?.trim();
  if (!id || !DATASET_ID_RE.test(id)) return null;
  return id;
}

function projectId(): string | null {
  const id = process.env.GOOGLE_CLOUD_PROJECT?.trim();
  if (!id || !PROJECT_ID_RE.test(id)) return null;
  return id;
}

/** Fully-qualified, safely-quoted table reference. Inputs are env-only (above). */
function fqtn(project: string, dataset: string, table: string): string {
  return `\`${project}.${dataset}.${table}\``;
}

// --- lazy client (server-only; only loaded when the flag is on) -------------

let clientPromise: Promise<BigQuery | null> | null = null;

async function getClient(project: string): Promise<BigQuery | null> {
  clientPromise ??= (async () => {
    try {
      const mod = await import("@google-cloud/bigquery");
      // ADC on the App Hosting compute SA — no key files (like firestore.ts).
      return new mod.BigQuery({ projectId: project });
    } catch (err) {
      console.warn("[analytics-bq] client init failed:", err);
      return null;
    }
  })();
  return clientPromise;
}

interface QueryTarget {
  region: Region;
  project: string;
  dataset: string;
}

/** Resolve the per-region target, or null when the pipeline is unavailable. */
function resolveTarget(region: Region): QueryTarget | null {
  if (!analyticsBqEnabled()) return null;
  const project = projectId();
  const dataset = datasetForRegion(region);
  if (!project || !dataset) return null;
  return { region, project, dataset };
}

/**
 * Run a parameterized query against a region's dataset. Returns the rows, or
 * `null` on any failure (missing table, auth, quota) — callers treat null as
 * "BigQuery unavailable for this slice" and fall back / show absent.
 */
async function runQuery<T = Record<string, unknown>>(
  target: QueryTarget,
  sql: string,
  params: Record<string, string | string[]>,
): Promise<T[] | null> {
  const client = await getClient(target.project);
  if (!client) return null;
  try {
    const [rows] = await client.query({
      query: sql,
      params,
      location: BQ_LOCATION[target.region],
    });
    return rows as T[];
  } catch (err) {
    console.warn("[analytics-bq] query failed:", err);
    return null;
  }
}

// --- signup + widget-view breakdowns ---------------------------------------

interface DimRow {
  dim: string;
  value: string | null;
  count: number | string; // BQ returns INT64 counts as string in some clients
}

/** Uncapped lifecycle KPI counts (BigQuery analogue of aggregateSignups totals).
 *  Used to correct the headline cards when the Firestore 10k aggregation is capped. */
export interface BqKpis {
  totalSignups: number;
  verifiedSignups: number;
  unverifiedSignups: number;
  offboardedSignups: number;
  totalReferrals: number;
  referredSignups: number;
  organicSignups: number;
}

export interface BqBreakdowns {
  utm: {
    source: CountRow[];
    medium: CountRow[];
    campaign: CountRow[];
    content: CountRow[];
    term: CountRow[];
  };
  /** Referrer hosts of people who SIGNED UP (signup-derived; parallels Firestore). */
  referrerSources: CountRow[];
  /** Full signup history (no 10k cap). */
  signupsByDay: CountRow[];
  /** Widget impressions over time (from widget_views; empty if no view tracking). */
  viewsByDay: CountRow[];
  /** Referrer hosts of all widget VIEWS (true impressions, bot-filtered). */
  viewReferrerSources: CountRow[];
  /** Whether the widget_views slice returned data (drives the UI "absent" state). */
  hasViews: boolean;
  /** Uncapped KPI counts; null if the KPI query failed (caller keeps Firestore). */
  kpis: BqKpis | null;
}

/**
 * Compute the BigQuery-backed signup breakdowns + widget-view metrics for one
 * campaign. Returns null only when the pipeline is off/unconfigured or the
 * signup query itself fails (→ full Firestore fallback). A missing/empty
 * widget_views table is NOT fatal — it just yields empty view metrics.
 */
export async function computeBqBreakdowns(
  ctx: TenantContext,
  campaignId: string,
): Promise<BqBreakdowns | null> {
  const target = resolveTarget(ctx.region);
  if (!target) return null;

  const params = { tenant_id: ctx.tenantId, campaign_id: campaignId };
  const signupsLatest = fqtn(target.project, target.dataset, "signups_latest");
  const widgetViews = fqtn(target.project, target.dataset, "widget_views");

  // SINGLE scan of signups_latest: each row is cross-joined with a small inline
  // array of (dim, value) structs and grouped — so all 7 dimensions come from one
  // pass (a CTE referenced once per UNION branch would re-scan the table). tenant_id
  // is ALWAYS bound as a param — never interpolated.
  const signupSql = `
    SELECT d.dim AS dim, d.value AS value, COUNT(*) AS count
    FROM ${signupsLatest},
    UNNEST([
      STRUCT('source' AS dim, utm_source AS value),
      STRUCT('medium' AS dim, utm_medium AS value),
      STRUCT('campaign' AS dim, utm_campaign AS value),
      STRUCT('content' AS dim, utm_content AS value),
      STRUCT('term' AS dim, utm_term AS value),
      STRUCT('referrer' AS dim, NET.HOST(referrer_url) AS value),
      STRUCT('day' AS dim, FORMAT_DATE('%Y-%m-%d', DATE(created_at)) AS value)
    ]) AS d
    WHERE tenant_id = @tenant_id AND campaign_id = @campaign_id AND d.value IS NOT NULL
    GROUP BY d.dim, d.value
  `;

  // Uncapped lifecycle KPI counts (mirrors aggregateSignups): used to correct the
  // headline cards when the Firestore 10k aggregation was capped. Single scan.
  const kpiSql = `
    SELECT
      COUNTIF(status IN ('verified_active','unverified')) AS total,
      COUNTIF(status = 'verified_active') AS verified,
      COUNTIF(status = 'unverified') AS unverified,
      COUNTIF(status = 'offboarded') AS offboarded,
      IFNULL(SUM(amount_referred), 0) AS total_referrals,
      COUNTIF(referred_by_token IS NOT NULL AND status IN ('verified_active','unverified')) AS referred
    FROM ${signupsLatest}
    WHERE tenant_id = @tenant_id AND campaign_id = @campaign_id
  `;

  // Single scan of widget_views (bot-filtered), independent so a missing table
  // degrades views to empty without losing the signup breakdowns.
  const viewSql = `
    SELECT d.dim AS dim, d.value AS value, COUNT(*) AS count
    FROM ${widgetViews},
    UNNEST([
      STRUCT('day' AS dim, FORMAT_DATE('%Y-%m-%d', ingest_day) AS value),
      STRUCT('referrer' AS dim, referrer_host AS value)
    ]) AS d
    WHERE tenant_id = @tenant_id AND campaign_id = @campaign_id AND is_bot = FALSE AND d.value IS NOT NULL
    GROUP BY d.dim, d.value
  `;

  const [signupRows, kpiRows, viewRows] = await Promise.all([
    runQuery<DimRow>(target, signupSql, params),
    runQuery<KpiRow>(target, kpiSql, params),
    runQuery<DimRow>(target, viewSql, params),
  ]);

  // The signup dim query is the floor: if it fails, fall back to Firestore entirely.
  if (signupRows === null) return null;

  const byDim = bucketByDim(signupRows);
  const viewByDim = viewRows ? bucketByDim(viewRows) : new Map<string, CountRow[]>();

  return {
    utm: {
      source: topN(byDim.get("source")),
      medium: topN(byDim.get("medium")),
      campaign: topN(byDim.get("campaign")),
      content: topN(byDim.get("content")),
      term: topN(byDim.get("term")),
    },
    referrerSources: topN(byDim.get("referrer")),
    signupsByDay: chronological(byDim.get("day")),
    viewsByDay: chronological(viewByDim.get("day")),
    viewReferrerSources: topN(viewByDim.get("referrer")),
    hasViews: viewRows !== null,
    kpis: kpiRows ? kpisFromRow(kpiRows[0]) : null,
  };
}

interface KpiRow {
  total: number | string;
  verified: number | string;
  unverified: number | string;
  offboarded: number | string;
  total_referrals: number | string;
  referred: number | string;
}

function kpisFromRow(row: KpiRow | undefined): BqKpis {
  const n = (v: number | string | undefined) => Number(v ?? 0);
  const totalSignups = n(row?.total);
  const referredSignups = n(row?.referred);
  return {
    totalSignups,
    verifiedSignups: n(row?.verified),
    unverifiedSignups: n(row?.unverified),
    offboardedSignups: n(row?.offboarded),
    totalReferrals: n(row?.total_referrals),
    referredSignups,
    organicSignups: totalSignups - referredSignups,
  };
}

function bucketByDim(rows: DimRow[]): Map<string, CountRow[]> {
  const out = new Map<string, CountRow[]>();
  for (const r of rows) {
    if (r.value == null) continue;
    const list = out.get(r.dim) ?? [];
    list.push({ value: String(r.value), count: Number(r.count) });
    out.set(r.dim, list);
  }
  return out;
}

function topN(rows: CountRow[] | undefined): CountRow[] {
  return (rows ?? []).sort((a, b) => b.count - a.count).slice(0, TOP_N);
}

function chronological(rows: CountRow[] | undefined): CountRow[] {
  return (rows ?? []).slice().sort((a, b) => (a.value < b.value ? -1 : 1));
}

// --- email engagement breakdown (un-caps the Firestore 50k read) ------------

/** Raw event-type tallies for a (node) or (node, arm); shaped to feed email.ts. */
export interface RawEngagement {
  sent: number;
  opened: number;
  clicked: number;
  failed: number; // hard bounce + reject → undelivered (matches aggregateEvents)
  unsubscribed: number; // unsub events (post-delivery; does NOT reduce delivered)
}

export interface BqEmailBreakdown {
  /** Whole-sequence totals + distinct enrolled recipients (across all nodes). */
  sequence: RawEngagement & { enrolled: number };
  /** Per email node, with per-A/B-arm sub-tallies. */
  nodes: Array<{
    nodeId: string;
    counts: RawEngagement;
    arms: Array<{ variantId: string; counts: RawEngagement }>;
  }>;
}

interface EmailTallyRow {
  node_id: string;
  variant_id: string;
  type: string;
  count: number | string;
}

const ZERO: RawEngagement = { sent: 0, opened: 0, clicked: 0, failed: 0, unsubscribed: 0 };

/**
 * Compute per-node / per-arm email engagement for a journey from
 * `email_events_latest`, with NO 50k cap. Returns null when the pipeline is
 * off/unconfigured or the query fails (→ Firestore fallback). A successful but
 * empty result returns a zero-filled breakdown (NOT null) — that's a real "0
 * events" answer, distinct from "BigQuery unavailable".
 */
/**
 * Per-node / per-arm tallies for one sequence. A launch's welcome sequence can
 * span both journey engines (engine move), so it takes every journey id the
 * sequence has used and counts them as one.
 */
export async function computeBqEmailBreakdown(
  ctx: TenantContext,
  journeyIds: string | string[],
): Promise<BqEmailBreakdown | null> {
  const target = resolveTarget(ctx.region);
  if (!target) return null;

  const ids = Array.isArray(journeyIds) ? journeyIds : [journeyIds];
  if (ids.length === 0) return null;
  const params = { tenant_id: ctx.tenantId, journey_ids: ids };
  const table = fqtn(target.project, target.dataset, "email_events_latest");

  const tallySql = `
    SELECT node_id, variant_id, type, COUNT(*) AS count
    FROM ${table}
    WHERE tenant_id = @tenant_id AND journey_id IN UNNEST(@journey_ids)
    GROUP BY node_id, variant_id, type
  `;
  // Distinct enrolled recipients (send events) across the whole sequence.
  const enrolledSql = `
    SELECT COUNT(DISTINCT signup_id) AS enrolled
    FROM ${table}
    WHERE tenant_id = @tenant_id AND journey_id IN UNNEST(@journey_ids) AND type = 'send'
  `;

  const [tallyRows, enrolledRows] = await Promise.all([
    runQuery<EmailTallyRow>(target, tallySql, params),
    runQuery<{ enrolled: number | string }>(target, enrolledSql, params),
  ]);
  if (tallyRows === null || enrolledRows === null) return null;

  // node_id -> variant_id -> RawEngagement (mutable accumulators)
  const nodes = new Map<string, Map<string, RawEngagement>>();
  const sequence: RawEngagement = { ...ZERO };
  for (const row of tallyRows) {
    const bucket = bucketForType(row.type);
    if (!bucket) continue; // soft_bounce/spam don't map to a tallied bucket
    const n = Number(row.count);
    const arms = nodes.get(row.node_id) ?? new Map<string, RawEngagement>();
    const arm = arms.get(row.variant_id) ?? { ...ZERO };
    arm[bucket] += n;
    arms.set(row.variant_id, arm);
    nodes.set(row.node_id, arms);
    sequence[bucket] += n;
  }

  return {
    sequence: { ...sequence, enrolled: Number(enrolledRows[0]?.enrolled ?? 0) },
    nodes: [...nodes.entries()].map(([nodeId, arms]) => ({
      nodeId,
      counts: sumArms(arms),
      arms: [...arms.entries()].map(([variantId, counts]) => ({ variantId, counts })),
    })),
  };
}

function bucketForType(type: string): keyof RawEngagement | null {
  switch (type) {
    case "send":
      return "sent";
    case "open":
      return "opened";
    case "click":
      return "clicked";
    case "bounce":
    case "reject":
      return "failed";
    case "unsub":
      return "unsubscribed";
    default:
      return null;
  }
}

function sumArms(arms: Map<string, RawEngagement>): RawEngagement {
  const total: RawEngagement = { ...ZERO };
  for (const a of arms.values()) {
    total.sent += a.sent;
    total.opened += a.opened;
    total.clicked += a.clicked;
    total.failed += a.failed;
    total.unsubscribed += a.unsubscribed;
  }
  return total;
}

// --- widget-view ingestion (write path for the public beacon endpoint) ------

/** A normalized, PII-free widget impression row (see lib/analytics/viewIngest). */
export interface WidgetViewRow {
  event_id: string;
  tenant_id: string;
  campaign_id: string;
  event_ts: string; // ISO-8601 UTC
  referrer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  ua_class: string;
  is_bot: boolean;
  ingest_day: string; // YYYY-MM-DD (partition key)
}

/**
 * Insert one widget-view row into the region's `widget_views` table. Best-effort
 * and fire-and-forget relative to the beacon's 204 — a dropped view is
 * acceptable; never throws to the caller. No-op (returns false) when the
 * pipeline is off/unconfigured.
 */
export async function recordWidgetView(
  ctx: TenantContext,
  row: WidgetViewRow,
): Promise<boolean> {
  const target = resolveTarget(ctx.region);
  if (!target) return false;
  const client = await getClient(target.project);
  if (!client) return false;
  try {
    await client.dataset(target.dataset).table("widget_views").insert([row]);
    return true;
  } catch (err) {
    console.warn("[analytics-bq] widget_views insert failed:", err);
    return false;
  }
}

// --- tenant-wide Insights (nav v2 phase 4) ------------------------------------

/** A whole number of days, 1–365 (interpolated into INTERVAL; never user input). */
function safeDays(days: number): number {
  return Math.min(365, Math.max(1, Math.floor(days)));
}

export interface BqSignupSources {
  /** value = source class key (see src/lib/insights/sources.ts). */
  classes: CountRow[];
  /** utm_campaign values of signups that came from content. */
  contentCampaigns: CountRow[];
}

/**
 * Signups in the last `days`, by estimated source, across every launch. One scan
 * of signups_latest; the CASE is built from the constant rule table in
 * src/lib/insights/sources.ts. Null when BigQuery is unavailable.
 */
export async function computeBqSignupSources(
  ctx: TenantContext,
  opts: { days: number; caseSql: string; contentKeys: string[] },
): Promise<BqSignupSources | null> {
  const target = resolveTarget(ctx.region);
  if (!target) return null;
  const table = fqtn(target.project, target.dataset, "signups_latest");
  const content = opts.contentKeys.filter((k) => /^[a-z_]+$/.test(k)).map((k) => `'${k}'`).join(", ") || "''";
  const sql = `
    SELECT src, IF(src IN (${content}), utm_campaign, NULL) AS campaign, COUNT(*) AS count
    FROM (
      SELECT ${opts.caseSql} AS src, utm_campaign
      FROM ${table}
      WHERE tenant_id = @tenant_id
        AND created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${safeDays(opts.days)} DAY)
        AND status IN ('verified_active', 'unverified', 'offboarded')
    )
    GROUP BY src, campaign
  `;
  const rows = await runQuery<{ src: string; campaign: string | null; count: number | string }>(target, sql, {
    tenant_id: ctx.tenantId,
  });
  if (rows === null) return null;
  const classes = new Map<string, number>();
  const campaigns = new Map<string, number>();
  for (const r of rows) {
    const n = Number(r.count);
    classes.set(r.src, (classes.get(r.src) ?? 0) + n);
    if (r.campaign) campaigns.set(r.campaign, (campaigns.get(r.campaign) ?? 0) + n);
  }
  const sorted = (m: Map<string, number>) =>
    [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  return { classes: sorted(classes), contentCampaigns: sorted(campaigns).slice(0, TOP_N) };
}

export interface BqEmailStat {
  journeyId: string;
  nodeId: string;
  sends: number;
  /** Distinct people who opened / clicked that email. */
  opens: number;
  clicks: number;
}

/**
 * Every email's sends, unique opens and unique clicks in the last `days`, across
 * launch journeys, invites and lifecycle journeys (email_events_latest). Null when
 * BigQuery is unavailable.
 */
export async function computeBqEmailStats(ctx: TenantContext, opts: { days: number }): Promise<BqEmailStat[] | null> {
  const target = resolveTarget(ctx.region);
  if (!target) return null;
  const table = fqtn(target.project, target.dataset, "email_events_latest");
  const sql = `
    SELECT journey_id, node_id,
      COUNTIF(type = 'send') AS sends,
      COUNT(DISTINCT IF(type = 'open', signup_id, NULL)) AS opens,
      COUNT(DISTINCT IF(type = 'click', signup_id, NULL)) AS clicks
    FROM ${table}
    WHERE tenant_id = @tenant_id
      AND event_ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${safeDays(opts.days)} DAY)
    GROUP BY journey_id, node_id
  `;
  const rows = await runQuery<{ journey_id: string; node_id: string; sends: number | string; opens: number | string; clicks: number | string }>(
    target,
    sql,
    { tenant_id: ctx.tenantId },
  );
  if (rows === null) return null;
  return rows
    .filter((r) => r.journey_id)
    .map((r) => ({
      journeyId: r.journey_id,
      nodeId: r.node_id ?? "",
      sends: Number(r.sends),
      opens: Number(r.opens),
      clicks: Number(r.clicks),
    }));
}
