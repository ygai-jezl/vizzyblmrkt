import type { Transport } from "../safeFetch";

/**
 * Made-up provider answers for the collect tests (Connectors 2), shaped like Search Console's
 * searchAnalytics.query, Google Analytics' batchRunReports and Cloudflare's GraphQL Analytics.
 * Every site, page, search and number here is invented; nothing calls a provider.
 */

export const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A request as the transport saw it: its URL and parsed JSON body. */
export interface SeenCall {
  url: string;
  body: Record<string, unknown>;
}

/** A transport that answers each call with `route(call)`, recording every call. */
export function routedTransport(route: (call: SeenCall) => Response) {
  const calls: SeenCall[] = [];
  const transport: Transport = async (url, init) => {
    const call = { url, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} };
    calls.push(call);
    return route(call);
  };
  return { transport, calls };
}

// --- Search Console ---------------------------------------------------------------------------

/** A probe's answer: one row per day Google lists, with the property's totals for it. */
export function scDays(days: Array<{ day: string; clicks: number; impressions: number; position?: number }>) {
  return { rows: days.map((d) => ({ keys: [d.day], clicks: d.clicks, impressions: d.impressions, ctr: d.impressions ? d.clicks / d.impressions : 0, position: d.position ?? 9.5 })), responseAggregationType: "byProperty" };
}

/** Rows by page (full addresses) or by search, for one day. */
export function scRows(rows: Array<{ key: string; clicks: number; impressions: number; position?: number }>) {
  return { rows: rows.map((r) => ({ keys: [r.key], clicks: r.clicks, impressions: r.impressions, ctr: r.impressions ? r.clicks / r.impressions : 0, position: r.position ?? 8 })) };
}

/** Google's quota error, as searchAnalytics.query sends it. */
export const SC_QUOTA = { error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "quotaExceeded" }] } };

// --- Google Analytics -------------------------------------------------------------------------

/** One report of a batch: rows of a dimension with metric values, its totals and its metadata. */
export function ga4Report(opts: {
  metrics: string[];
  rows: Array<{ dim: string; values: number[] }>;
  totals: number[];
  rowCount?: number;
  timeZone?: string;
  other?: boolean;
  sampled?: boolean;
  thresholded?: boolean;
  projectHourLeft?: number;
}) {
  const metricValues = (values: number[]) => values.map((v) => ({ value: String(v) }));
  return {
    metricHeaders: opts.metrics.map((name) => ({ name, type: "TYPE_INTEGER" })),
    rows: opts.rows.map((r) => ({ dimensionValues: [{ value: r.dim }], metricValues: metricValues(r.values) })),
    totals: [{ dimensionValues: [{ value: "RESERVED_TOTAL" }], metricValues: metricValues(opts.totals) }],
    rowCount: opts.rowCount ?? opts.rows.length,
    metadata: {
      timeZone: opts.timeZone ?? "Europe/London",
      currencyCode: "GBP",
      ...(opts.other ? { dataLossFromOtherRow: true } : {}),
      ...(opts.sampled ? { samplingMetadatas: [{ samplesReadCount: "100", samplingSpaceSize: "1000" }] } : {}),
      ...(opts.thresholded ? { subjectToThresholding: true } : {}),
    },
    propertyQuota: {
      tokensPerDay: { consumed: 10, remaining: 199_000 },
      tokensPerHour: { consumed: 10, remaining: 39_000 },
      tokensPerProjectPerHour: { consumed: 10, remaining: opts.projectHourLeft ?? 13_000 },
    },
  };
}

/** A page report and a landing report for one day, as collectDays asks for them. */
export function ga4Day(opts: { views?: number; sessions?: number; users?: number; keyEvents?: number; timeZone?: string; projectHourLeft?: number; other?: boolean } = {}) {
  const views = opts.views ?? 120;
  const sessions = opts.sessions ?? 80;
  const users = opts.users ?? 60;
  const keyEvents = opts.keyEvents ?? 4;
  return [
    ga4Report({
      metrics: ["screenPageViews", "activeUsers", "keyEvents"],
      rows: [
        { dim: "/pricing", values: [70, 40, 3] },
        { dim: "/blog/first-post", values: [50, 30, 1] },
        ...(opts.other ? [{ dim: "(other)", values: [5, 5, 0] }] : []),
      ],
      totals: [views, users, keyEvents],
      timeZone: opts.timeZone,
      projectHourLeft: opts.projectHourLeft,
      other: opts.other,
    }),
    ga4Report({
      metrics: ["sessions", "activeUsers", "keyEvents"],
      rows: [
        { dim: "/pricing?ref=newsletter", values: [30, 25, 2] },
        { dim: "/pricing", values: [20, 18, 1] },
        { dim: "(not set)", values: [5, 5, 0] },
      ],
      totals: [sessions, users, keyEvents],
      timeZone: opts.timeZone,
      projectHourLeft: opts.projectHourLeft,
    }),
  ];
}

// --- Cloudflare -------------------------------------------------------------------------------

/** The zone's settings node for both datasets, in seconds. */
export function cfSettings(opts: { adaptiveDays?: number; dailyDays?: number | null } = {}) {
  return {
    data: {
      viewer: {
        zones: [
          {
            settings: {
              httpRequestsAdaptiveGroups: { enabled: true, notOlderThan: (opts.adaptiveDays ?? 31) * 86_400, maxDuration: 30 * 86_400 },
              httpRequests1dGroups: opts.dailyDays === null ? null : { enabled: true, notOlderThan: (opts.dailyDays ?? 365) * 86_400, maxDuration: 400 * 86_400 },
            },
          },
        ],
      },
    },
    errors: null,
  };
}

/** The daily totals for each day, and end user numbers for the days given. */
export function cfDays(days: string[], endUserDays: string[] = []) {
  return {
    data: {
      viewer: {
        zones: [
          {
            daily: days.map((d, i) => ({ dimensions: { date: d }, sum: { requests: 2000 + i, pageViews: 300 + i }, uniq: { uniques: 90 + i } })),
            total: [{ uniq: { uniques: 500 } }],
            traffic: endUserDays.map((d, i) => ({ dimensions: { date: d }, count: 1500 + i, sum: { visits: 120 + i } })),
            pages: endUserDays.map((d, i) => ({ dimensions: { date: d }, count: 250 + i })),
          },
        ],
      },
    },
    errors: null,
  };
}
