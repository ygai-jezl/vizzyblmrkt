import type { SnapshotNote, SnapshotRow } from "@/lib/types/metricSnapshot";
import { newestDue, planDays } from "../collect/schedule";
import { cleanPagePath } from "../paths";
import { addDays, cappedNote, daysIn, daysWords, earlierDay, isTimeZone, laterDay, nothingYetNote, PERIOD_DAYS, resolveWindow, todayIn, type LivePeriod } from "../period";
import { connectorFetch } from "../safeFetch";
import { googleFailure } from "./searchConsole";
import type { AccountsHook, CollectHook, CollectResult, ConnectorAccount, HookFailure, HookInput, LiveHook, LiveRow, VerifyHook } from "./types";

/**
 * Google Analytics 4's hooks, called with a signed in connection's access token from the token
 * keeper or a shared connection's minted token:
 *
 * - properties (the picker) lists the properties the token can see through the Admin API's
 *   accountSummaries.list (GET analyticsadmin.googleapis.com/v1beta/accountSummaries, up to 200
 *   accounts a page, at most 3 pages), each with its account and type.
 * - propertyCheck (verify): with no property picked it proves the token works; with one, that the
 *   property is still in that list.
 * - runReport reads the Data API's properties.runReport (POST analyticsdata.googleapis.com/v1beta/
 *   {property}:runReport) by date, page (unifiedPagePathScreen) or landing page (landingPage),
 *   each a path without its query string (an app's screen class isn't a path, so it is left out
 *   with a note), with totals and returnPropertyQuota. Google's metadata
 *   says the property's time zone, and when rows were rolled into "(other)", sampled or held
 *   back below its privacy thresholds; each becomes a note, as does a property low on its daily
 *   tokens.
 *
 * Google's error body tells this copy's setup (an API not turned on), a quota (RESOURCE_EXHAUSTED,
 * which a property out of tokens answers) and a property the token can't read (403) apart, with
 * the same reading as Search Console's (googleFailure).
 */

const SUMMARIES = "https://analyticsadmin.googleapis.com/v1beta/accountSummaries";
const runReportUrl = (property: string) => `https://analyticsdata.googleapis.com/v1beta/${property}:runReport`;
export const PROPERTY_RE = /^properties\/\d{1,20}$/;
/** The most properties the picker shows, and the most account pages one list reads. */
export const MAX_PROPERTIES = 200;
const MAX_PAGES = 3;
const PAGE_SIZE = 200;
/** Each grouping's dimension: pages as the Pages and screens report, landing pages as the Landing page report. */
const DIMENSION = { day: "date", page: "unifiedPagePathScreen", landing: "landingPage" } as const;
/** Google's metric names and the meaning key each becomes. */
export const GA4_METRICS = [
  ["sessions", "ga4Sessions"],
  ["activeUsers", "ga4ActiveUsers"],
  ["screenPageViews", "ga4Views"],
  ["keyEvents", "ga4KeyEvents"],
] as const;
/**
 * The metrics each grouping asks for, in Google's report order. Sessions by page match no report,
 * so pages leave them out, and so does a read by day for one page: sessions for one page are read
 * by landing page.
 */
export const METRICS_BY = {
  day: ["sessions", "activeUsers", "screenPageViews", "keyEvents"],
  page: ["screenPageViews", "activeUsers", "keyEvents"],
  landing: ["sessions", "activeUsers", "keyEvents"],
} as const;
const ORDER_BY = { page: "screenPageViews", landing: "sessions" } as const;
/** Days before a day's numbers are usually final. */
const LAG_DAYS = 2;
/** Below these, a property is low on Google Analytics tokens for the day or the hour. */
const LOW_TOKENS = { day: 20_000, hour: 4_000 };

export const THRESHOLD_NOTE = "Google Analytics held back some small numbers to protect visitors' privacy, so these may be low.";
export const OTHER_NOTE = "Google Analytics grouped some rarely visited pages as (other), so they aren't listed one by one.";
export const SAMPLED_NOTE = "Google Analytics worked these numbers out from a sample of the visits, so they are estimates.";
export const QUOTA_NOTE = "This property has used most of its Google Analytics allowance for now, so reads may stop for a while.";
export const APP_SCREENS_NOTE = "This property also counts app screens. They aren't web pages, so they aren't listed here, but the totals include them.";

const TYPE_WORDS: Readonly<Record<string, string>> = {
  PROPERTY_TYPE_SUBPROPERTY: "subproperty",
  PROPERTY_TYPE_ROLLUP: "roll up property",
};

interface Property {
  id: string;
  label: string;
  account: string;
  type: string;
}

const text = (v: unknown, max = 200): string | null => (typeof v === "string" && v.length <= max ? v : null);

/** The properties in one accountSummaries.list page, and its next page token; null when it isn't one. */
export function summariesFrom(body: unknown): { properties: Property[]; next: string } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { accountSummaries?: unknown; nextPageToken?: unknown };
  if (b.accountSummaries !== undefined && !Array.isArray(b.accountSummaries)) return null;
  const properties: Property[] = [];
  for (const a of (b.accountSummaries ?? []) as Array<{ displayName?: unknown; propertySummaries?: unknown }>) {
    if (!a || !Array.isArray(a.propertySummaries)) continue;
    const account = text(a.displayName) ?? "";
    for (const p of a.propertySummaries as Array<{ property?: unknown; displayName?: unknown; propertyType?: unknown }>) {
      const id = text(p?.property, 40);
      if (!id || !PROPERTY_RE.test(id)) continue;
      properties.push({ id, label: text(p.displayName) || id, account, type: text(p.propertyType, 60) ?? "" });
    }
  }
  return { properties, next: text(b.nextPageToken, 2000) ?? "" };
}

async function listProperties(input: HookInput, deps: Parameters<VerifyHook>[1]): Promise<{ ok: true; properties: Property[]; more: boolean } | HookFailure> {
  const properties: Property[] = [];
  let pageToken = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${SUMMARIES}?pageSize=${PAGE_SIZE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const res = await connectorFetch({ manifest: input.manifest, connection: input.connection, url, method: "GET", token: input.token }, deps);
    if (!res.ok) return googleFailure(res);
    const parsed = summariesFrom(res.body);
    if (!parsed) return { ok: false, code: "bad_response", retryAfterSec: null };
    properties.push(...parsed.properties);
    pageToken = parsed.next;
    if (!pageToken) return { ok: true, properties, more: false };
  }
  return { ok: true, properties, more: true };
}

/** A property's account, and its type when it isn't an ordinary one, as people read it. */
function detailOf(p: Property): string | null {
  const type = TYPE_WORDS[p.type];
  if (p.account && type) return `${p.account}, ${type}`;
  return p.account || type || null;
}

export const properties: AccountsHook = async (input, deps) => {
  const r = await listProperties(input, deps);
  if (!r.ok) return r;
  const accounts: ConnectorAccount[] = r.properties
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
    .map((p) => ({ id: p.id, label: p.label, detail: detailOf(p) }));
  return { ok: true, accounts: accounts.slice(0, MAX_PROPERTIES), more: r.more || accounts.length > MAX_PROPERTIES };
};

export const propertyCheck: VerifyHook = async (input, deps) => {
  const r = await listProperties(input, deps);
  if (!r.ok) return r;
  if (!input.account) return { ok: true };
  return r.properties.some((p) => p.id === input.account) ? { ok: true } : { ok: false, code: "account_refused", retryAfterSec: null };
};

const count = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const remaining = (q: unknown): number | null => {
  const r = (q as { remaining?: unknown } | null)?.remaining;
  return typeof r === "number" && Number.isFinite(r) ? r : null;
};

type By = keyof typeof DIMENSION;

/** Google's relative dates for a named period, which it resolves in the property's own time zone. */
export function relativeRange(period: LivePeriod): { startDate: string; endDate: string } {
  return period === "yesterday" ? { startDate: "yesterday", endDate: "yesterday" } : { startDate: `${PERIOD_DAYS[period]}daysAgo`, endDate: "yesterday" };
}

/** An exact match on a string dimension. */
const exact = (fieldName: string, value: string) => ({ filter: { fieldName, stringFilter: { matchType: "EXACT", value } } });

/**
 * The dimension filter: only a page filter, one path matched exactly. Landing pages send no filter,
 * as Google's Landing page report table doesn't, so the totals and rowCount are the report's own;
 * its "(not set)" row is left out of the rows here instead.
 */
function dimensionFilter(by: By, page: string | undefined): Record<string, unknown> | null {
  return page ? exact(by === "landing" ? "landingPage" : "unifiedPagePathScreen", page) : null;
}

/** The metrics a read asks for: a read by day for one page asks for the page's own (no sessions). */
export function metricsFor(by: By, page: string | undefined): readonly string[] {
  return by === "day" && page ? METRICS_BY.page : METRICS_BY[by];
}

/** The runReport body for one read. Days ask for every day, so the latest are never cut. */
export function reportBody(by: By, range: { startDate: string; endDate: string }, rows: number, page: string | undefined): Record<string, unknown> {
  const filter = dimensionFilter(by, page);
  return {
    dateRanges: [range],
    dimensions: [{ name: DIMENSION[by] }],
    metrics: metricsFor(by, page).map((name) => ({ name })),
    ...(filter ? { dimensionFilter: filter } : {}),
    orderBys: by === "day" ? [{ dimension: { dimensionName: "date" } }] : [{ metric: { metricName: ORDER_BY[by] }, desc: true }],
    limit: rows,
    metricAggregations: ["TOTAL"],
    keepEmptyRows: by === "day",
    returnPropertyQuota: true,
  };
}

interface ReportBody {
  metricHeaders?: unknown;
  rows?: unknown;
  totals?: unknown;
  rowCount?: unknown;
  metadata?: unknown;
  propertyQuota?: unknown;
}

/** Google's metric values by meaning key, matched by its header names so their order can't mix them up. */
function valuesOf(headers: readonly string[], values: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const list = Array.isArray(values) ? (values as Array<{ value?: unknown }>) : [];
  headers.forEach((name, i) => {
    const key = KEY_OF.get(name);
    if (key) out[key] = count(list[i]?.value);
  });
  return out;
}

const KEY_OF = new Map<string, string>(GA4_METRICS.map(([name, key]) => [name, key]));

/** "Google Analytics lists 212 pages for these days; this shows the top 50 by views." */
export function showingNote(by: "page" | "landing", shown: number, of: number): string {
  return by === "landing"
    ? `Google Analytics lists ${of} landing pages for these days; this shows the top ${shown} by sessions.`
    : `Google Analytics lists ${of} pages and screens for these days; this shows the top ${shown} by views.`;
}

/** The days not finished yet, dated. */
export function notFinalNote(from: string, to: string): string {
  return `Google Analytics can take a day or two to finish a day's numbers, so ${daysWords(from, to)} may be low.`;
}

/**
 * Read a property the way Google Analytics' own reports do:
 * - a named period is sent as Google's relative dates (28daysAgo to yesterday), so Google works
 *   the days out in the property's time zone, which its answer names (metadata.timeZone);
 * - explicit days are sent as asked; when the last one isn't over yet in the property's zone,
 *   the read is made again ending yesterday there, with a dated note;
 * - pages are grouped by unifiedPagePathScreen with views, active users and key events (Pages and
 *   screens), web paths only; landing pages by landingPage with sessions, active users and key
 *   events (Landing page), with no filter so the totals are the report's, and its "(not set)" row
 *   left out of the rows; days with every metric, empty days included, or a page's own metrics
 *   when the read is for one page;
 * - totals (metricAggregations TOTAL) count each person once for the whole period, and rowCount
 *   says how many rows Google has.
 */
export const runReport: LiveHook = async (input, deps) => {
  const { query } = input;
  if (query.stream !== "site_traffic" || !(query.by in DIMENSION)) return { ok: false, code: "query_refused", retryAfterSec: null };
  if (!input.account) return { ok: false, code: "account_needed", retryAfterSec: null };
  if (!PROPERTY_RE.test(input.account)) return { ok: false, code: "account_refused", retryAfterSec: null };
  const by = query.by as By;
  const now = deps.now ?? new Date();
  const limit = Math.max(1, Math.min(100, Math.trunc(query.limit)));
  const rowsFor = (days: number) => (by === "day" ? Math.min(days, 100) : limit);
  const call = (range: { startDate: string; endDate: string }, days: number) =>
    connectorFetch(
      { manifest: input.manifest, connection: input.connection, url: runReportUrl(input.account), method: "POST", json: reportBody(by, range, rowsFor(days), query.page), token: input.token },
      deps,
    );

  const notes = new Set<string>();
  let from = query.from ?? "";
  let to = query.to ?? "";
  let res = await call(query.period ? relativeRange(query.period) : { startDate: from, endDate: to }, query.period ? PERIOD_DAYS[query.period] : daysIn(from, to));
  if (!res.ok) return googleFailure(res);
  let body = res.body as ReportBody | null;
  if (!body || typeof body !== "object") return { ok: false, code: "bad_response", retryAfterSec: null };
  const zone = (body.metadata as { timeZone?: unknown } | undefined)?.timeZone;
  const timeZone = isTimeZone(zone) ? zone : null;
  const propertyToday = todayIn(now, timeZone ?? "UTC");
  const yesterday = addDays(propertyToday, -1);
  if (query.period) {
    to = yesterday;
    from = addDays(to, -(PERIOD_DAYS[query.period] - 1));
  } else if (to > yesterday) {
    // The last day asked isn't over in the property's zone: read again, ending on its yesterday.
    const window = resolveWindow({ from, to }, yesterday);
    if (window.empty) {
      return { ok: true, rows: [], notes: [nothingYetNote("Google Analytics", from, to, yesterday)], period: { from, to, timeZone, finalThrough: addDays(propertyToday, -LAG_DAYS) }, more: false };
    }
    to = window.to;
    notes.add(cappedNote("Google Analytics", yesterday));
    res = await call({ startDate: from, endDate: to }, daysIn(from, to));
    if (!res.ok) return googleFailure(res);
    body = res.body as ReportBody | null;
    if (!body || typeof body !== "object") return { ok: false, code: "bad_response", retryAfterSec: null };
  }
  if (body.rows !== undefined && !Array.isArray(body.rows)) return { ok: false, code: "bad_response", retryAfterSec: null };

  const headers = Array.isArray(body.metricHeaders) ? (body.metricHeaders as Array<{ name?: unknown }>).map((h) => (typeof h?.name === "string" ? h.name : "")) : [];
  const rows: LiveRow[] = [];
  const listed = (body.rows ?? []) as Array<{ dimensionValues?: unknown; metricValues?: unknown }>;
  for (const r of listed) {
    const dim = Array.isArray(r?.dimensionValues) ? (r.dimensionValues[0] as { value?: unknown } | undefined)?.value : undefined;
    if (typeof dim !== "string") continue;
    let value: string;
    if (by === "day") {
      if (!/^\d{8}$/.test(dim)) continue;
      value = `${dim.slice(0, 4)}-${dim.slice(4, 6)}-${dim.slice(6, 8)}`;
    } else {
      if (dim === "(other)") {
        notes.add(OTHER_NOTE);
        continue;
      }
      if (dim === "(not set)" || dim.length > 2000) continue;
      // An app stream's screen class (MainActivity) isn't a path: leave it out rather than make one up.
      if (!dim.startsWith("/")) {
        if (by === "page") notes.add(APP_SCREENS_NOTE);
        continue;
      }
      value = cleanPagePath(dim);
    }
    rows.push({ [by]: value, ...valuesOf(headers, r.metricValues) });
  }
  const totalsRow = Array.isArray(body.totals) ? (body.totals[0] as { metricValues?: unknown } | undefined) : undefined;
  const totals = totalsRow ? valuesOf(headers, totalsRow.metricValues) : undefined;
  const rowCount = typeof body.rowCount === "number" && Number.isInteger(body.rowCount) && body.rowCount >= 0 ? body.rowCount : null;
  const more = rowCount !== null && rowCount > listed.length;
  if (more && by !== "day") notes.add(showingNote(by, rows.length, rowCount));

  const meta = (body.metadata ?? {}) as { subjectToThresholding?: unknown; dataLossFromOtherRow?: unknown; samplingMetadatas?: unknown };
  if (meta.subjectToThresholding === true) notes.add(THRESHOLD_NOTE);
  if (meta.dataLossFromOtherRow === true) notes.add(OTHER_NOTE);
  if (Array.isArray(meta.samplingMetadatas) && meta.samplingMetadatas.length) notes.add(SAMPLED_NOTE);
  const quota = (body.propertyQuota ?? {}) as { tokensPerDay?: unknown; tokensPerHour?: unknown };
  const day = remaining(quota.tokensPerDay);
  const hour = remaining(quota.tokensPerHour);
  if ((day !== null && day < LOW_TOKENS.day) || (hour !== null && hour < LOW_TOKENS.hour)) notes.add(QUOTA_NOTE);
  const finalThrough = earlierDay(addDays(propertyToday, -LAG_DAYS), to);
  if (to > finalThrough) notes.add(notFinalNote(laterDay(from, addDays(finalThrough, 1)), to));

  const sorted =
    by === "day"
      ? rows.sort((a, b) => String(a.day).localeCompare(String(b.day)))
      : rows.sort((a, b) => {
          const order = by === "landing" ? ["ga4Sessions", "ga4ActiveUsers"] : ["ga4Views", "ga4ActiveUsers"];
          for (const k of order) {
            const d = ((b[k] as number | null) ?? 0) - ((a[k] as number | null) ?? 0);
            if (d) return d;
          }
          return String(a[by]).localeCompare(String(b[by]));
        });
  return { ok: true, rows: sorted, notes: [...notes], period: { from, to, timeZone, finalThrough }, ...(totals ? { totals } : {}), more };
};

// --- Collecting (Connectors 2, ADR-0012) ----------------------------------------------------------

const batchUrl = (property: string) => `https://analyticsdata.googleapis.com/v1beta/${property}:batchRunReports`;
/** Days a collect run reads: 3 calls of 2 days, each day a page and a landing report. */
export const COLLECT_DAYS_PER_RUN = 6;
/** Days in one batchRunReports call: 4 reports, under Google's 5. */
export const DAYS_PER_BATCH = 2;
/** Rows asked of each report before the cut to 500; halved once when an answer is too big. */
export const COLLECT_ROWS = 1000;
/** A day is first read 2 days later and read again on day 8, both from 06:00 in the property's zone. */
export const FIRST_PASS_DAYS = 2;
export const FINAL_PASS_DAYS = 8;
export const PASS_HOUR = 6;
/**
 * Below this many of the project's tokens for the property this hour (20% of a standard
 * property's 14,000), the collector holds itself for an hour so live reads keep the rest.
 */
export const LOW_PROJECT_TOKENS = 2_800;
const HOUR_MS = 3_600_000;

interface CollectReport {
  rows: SnapshotRow[];
  totals: Record<string, number | null> | null;
  more: boolean;
  notes: Set<SnapshotNote>;
  timeZone: string | null;
  quota: { projectHour: number | null; day: number | null };
}

/**
 * One report's rows as kept rows: paths only (an app's screen class isn't one, so it is left out
 * with a note), "(other)" and "(not set)" left out, and query string variants of one landing page
 * added together. A merged row adds sessions, views and key events, but not active users: the same
 * person may be in more than one.
 */
function reportRows(by: "page" | "landing", body: ReportBody): CollectReport {
  const headers = Array.isArray(body.metricHeaders) ? (body.metricHeaders as Array<{ name?: unknown }>).map((h) => (typeof h?.name === "string" ? h.name : "")) : [];
  const notes = new Set<SnapshotNote>();
  const merged = new Map<string, { m: Record<string, number>; n: number }>();
  const listed = Array.isArray(body.rows) ? (body.rows as Array<{ dimensionValues?: unknown; metricValues?: unknown }>) : [];
  for (const r of listed) {
    const dim = Array.isArray(r?.dimensionValues) ? (r.dimensionValues[0] as { value?: unknown } | undefined)?.value : undefined;
    if (typeof dim !== "string" || dim === "(not set)" || dim.length > 2000) continue;
    if (dim === "(other)") {
      notes.add("other_row");
      continue;
    }
    if (!dim.startsWith("/")) {
      notes.add("app_screens");
      continue;
    }
    const key = cleanPagePath(dim);
    const values = valuesOf(headers, r.metricValues);
    const acc = merged.get(key);
    if (!acc) {
      const m: Record<string, number> = {};
      for (const [k, v] of Object.entries(values)) if (v !== null) m[k] = v;
      merged.set(key, { m, n: 1 });
      continue;
    }
    acc.n += 1;
    delete acc.m.ga4ActiveUsers;
    for (const [k, v] of Object.entries(values)) if (v !== null && k !== "ga4ActiveUsers") acc.m[k] = (acc.m[k] ?? 0) + v;
  }
  const totalsRow = Array.isArray(body.totals) ? (body.totals[0] as { metricValues?: unknown } | undefined) : undefined;
  const meta = (body.metadata ?? {}) as { timeZone?: unknown; subjectToThresholding?: unknown; dataLossFromOtherRow?: unknown; samplingMetadatas?: unknown };
  if (meta.subjectToThresholding === true) notes.add("thresholded");
  if (meta.dataLossFromOtherRow === true) notes.add("other_row");
  if (Array.isArray(meta.samplingMetadatas) && meta.samplingMetadatas.length) notes.add("sampled");
  const rowCount = typeof body.rowCount === "number" && Number.isInteger(body.rowCount) ? body.rowCount : null;
  const quota = (body.propertyQuota ?? {}) as { tokensPerProjectPerHour?: unknown; tokensPerDay?: unknown };
  return {
    rows: [...merged.entries()].map(([key, v]) => ({ key, m: v.m })),
    totals: totalsRow ? valuesOf(headers, totalsRow.metricValues) : null,
    more: rowCount !== null && rowCount > listed.length,
    notes,
    timeZone: isTimeZone(meta.timeZone) ? meta.timeZone : null,
    quota: { projectHour: remaining(quota.tokensPerProjectPerHour), day: remaining(quota.tokensPerDay) },
  };
}

/** A day's totals: views, active users and key events from the page report, sessions from the landing one. */
function dayTotals(page: CollectReport, landing: CollectReport): Record<string, number | null> {
  return {
    ga4Sessions: landing.totals?.ga4Sessions ?? null,
    ga4ActiveUsers: page.totals?.ga4ActiveUsers ?? null,
    ga4Views: page.totals?.ga4Views ?? null,
    ga4KeyEvents: page.totals?.ga4KeyEvents ?? null,
  };
}

/**
 * Collect a property's days (ADR-0012). A day D is first read 2 days later from 06:00 in the
 * property's zone and marked not final; it is read again from day 8, when Google Analytics no
 * longer changes it ("some data can arrive late, potentially up to 7 days delayed"), and marked
 * final. Each day is two reports, one by page and one by landing page, that day alone, 1,000 rows
 * asked in the main measure's order with the day's totals; two days go in one batchRunReports call
 * (4 reports, under Google's 5), at most 3 calls a run, one at a time. An answer past the byte cap
 * is asked again once with half the rows. Every call returns the property's quota: under 20% of the
 * project's tokens for the hour, the collector holds itself for an hour.
 */
export const collectDays: CollectHook = async (input, deps) => {
  const { ask } = input;
  const keepDays = ask.stream.collect.keepDays;
  let timeZone = ask.cursor.timeZone;
  const base: CollectResult = { days: [], newest: null, reachFrom: null, timeZone, probed: false, hold: null, failure: null };
  if (!input.account) return { ...base, failure: { ok: false, code: "account_needed", retryAfterSec: null } };
  if (!PROPERTY_RE.test(input.account)) return { ...base, failure: { ok: false, code: "account_refused", retryAfterSec: null } };
  const zone = timeZone ?? "UTC";
  const newest = newestDue(ask.now, zone, FIRST_PASS_DAYS, PASS_HOUR);
  const finalLine = newestDue(ask.now, zone, FINAL_PASS_DAYS, PASS_HOUR);
  const out: CollectResult = { ...base, newest };
  const plan = planDays(ask.cursor, newest, { keepDays, maxDays: COLLECT_DAYS_PER_RUN, rereadThrough: finalLine });

  for (let i = 0; i < plan.length; i += DAYS_PER_BATCH) {
    if (!ask.canStart()) break;
    const days = plan.slice(i, i + DAYS_PER_BATCH).map((p) => p.day);
    const call = (rows: number) =>
      connectorFetch(
        {
          manifest: input.manifest,
          connection: input.connection,
          url: batchUrl(input.account),
          method: "POST",
          json: { requests: days.flatMap((d) => (["page", "landing"] as const).map((by) => reportBody(by, { startDate: d, endDate: d }, rows, undefined))) },
          token: input.token,
        },
        deps,
      );
    let res = await call(COLLECT_ROWS);
    if (!res.ok && res.code === "body_too_large") res = await call(COLLECT_ROWS / 2);
    if (!res.ok) return { ...out, failure: googleFailure(res) };
    const reports = (res.body as { reports?: unknown } | null)?.reports;
    if (!Array.isArray(reports) || reports.length !== days.length * 2) return { ...out, failure: { ok: false, code: "bad_response", retryAfterSec: null } };
    let low = false;
    days.forEach((day, j) => {
      const page = reportRows("page", (reports[j * 2] ?? {}) as ReportBody);
      const landing = reportRows("landing", (reports[j * 2 + 1] ?? {}) as ReportBody);
      timeZone = page.timeZone ?? landing.timeZone ?? timeZone;
      const notes = [...new Set([...page.notes, ...landing.notes])];
      out.days.push({
        day,
        final: day <= finalLine,
        docs: [
          { by: "day", totals: dayTotals(page, landing), rows: [], more: false, notes },
          { by: "page", totals: null, rows: page.rows, more: page.more, notes: [...page.notes] },
          { by: "landing", totals: null, rows: landing.rows, more: landing.more, notes: [...landing.notes] },
        ],
      });
      for (const q of [page.quota, landing.quota]) if ((q.projectHour !== null && q.projectHour < LOW_PROJECT_TOKENS) || (q.day !== null && q.day < LOW_TOKENS.day)) low = true;
    });
    out.timeZone = timeZone;
    if (low) return { ...out, hold: { untilMs: ask.now.getTime() + HOUR_MS, reason: "tokens_low" } };
  }
  return out;
};
