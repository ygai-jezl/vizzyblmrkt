import type { SnapshotRow } from "@/lib/types/metricSnapshot";
import { nextAt, planDays } from "../collect/schedule";
import type { ConnectorErrorCode } from "../messages";
import { cleanPagePath } from "../paths";
import { addDays, cappedNote, daysIn, dayWords, daysWords, earlierDay, isDay, laterDay, nothingYetNote, resolveWindow, todayIn } from "../period";
import { connectorFetch, type ConnectorResponse } from "../safeFetch";
import type { AccountsHook, CollectHook, CollectResult, ConnectorAccount, HookFailure, LiveHook, LiveRow, VerifyHook } from "./types";

/**
 * Google Search Console's hooks (developers.google.com/webmaster-tools/v1), called with a signed
 * in connection's access token from the token keeper:
 *
 * - siteCheck (verify) lists the account's sites (sites.list). With no site picked yet it proves
 *   the sign in works; with one, that the Google account still has verified access to it.
 * - sites (the picker) lists the sites, leaving out siteUnverifiedUser: an unverified site gives
 *   no data, and anyone can add any address to their own list.
 * - searchAnalytics reads searchAnalytics.query for the picked site, grouped by date, page or
 *   query, web results, the same days and data as Search Console's own Performance report (see
 *   searchAnalytics below), with the report's headline totals from a query with no dimensions. By
 *   page, Google's full addresses are cut to their host and path, and rows for the same host and
 *   path are added together (clicks and impressions summed, click rate worked out again, position
 *   weighted by impressions). A read for one page keeps each host apart the same way.
 *
 * Google's error body names the reason: an API not turned on in this copy's Google project is its
 * setup, not the connection's; a rate or quota reason is a rate limit; any other 403 means the
 * Google account can't read that site.
 */

const SITES = "https://searchconsole.googleapis.com/webmasters/v3/sites";
const queryUrl = (site: string) => `${SITES}/${encodeURIComponent(site)}/searchAnalytics/query`;
/** The most sites the picker shows. */
export const MAX_SITES = 200;

const PERMISSIONS: Readonly<Record<string, string>> = {
  siteOwner: "Owner",
  siteFullUser: "Full user",
  siteRestrictedUser: "Restricted user",
};
const DIMENSION = { day: "date", page: "page", topic: "query" } as const;
const KEY = { day: "day", page: "page", topic: "query" } as const;
/** Search Console's days are Pacific time. */
export const PACIFIC = "America/Los_Angeles";
/** The rows asked of Google for pages and searches, before merging and cutting: its own default. */
export const FETCH_ROWS = 1000;
/** The days the date probe reads, as Google's guide suggests. */
const PROBE_DAYS = 10;

interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

/** Every reason string in a Google error body. */
function googleReasons(body: unknown): string[] {
  const error = (body as { error?: unknown } | null)?.error;
  if (!error || typeof error !== "object") return [];
  const e = error as { status?: unknown; errors?: unknown; details?: unknown };
  const out: string[] = [];
  if (typeof e.status === "string") out.push(e.status);
  for (const list of [e.errors, e.details]) {
    if (Array.isArray(list)) for (const item of list) if (item && typeof (item as { reason?: unknown }).reason === "string") out.push((item as { reason: string }).reason);
  }
  return out;
}

/** The code for a failed Google API call, refined by the reasons in its body. */
export function googleFailure(res: Extract<ConnectorResponse, { ok: false }>): HookFailure {
  const reasons = googleReasons(res.body);
  let code: ConnectorErrorCode = res.code;
  if (reasons.some((r) => r === "SERVICE_DISABLED" || r === "accessNotConfigured")) code = "signin_unconfigured";
  else if (reasons.some((r) => /rateLimitExceeded|quotaExceeded|RESOURCE_EXHAUSTED/.test(r))) code = "rate_limited";
  else if (res.status === 401) code = "signin_refused";
  else if (res.status === 403) code = "account_refused";
  return { ok: false, code, retryAfterSec: res.retryAfterSec };
}

/** The sites in a sites.list answer, or null when it isn't one. Google sends {} for none. */
export function sitesFrom(body: unknown): SiteEntry[] | null {
  if (!body || typeof body !== "object") return null;
  const entries = (body as { siteEntry?: unknown }).siteEntry;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) return null;
  return entries.filter(
    (e): e is SiteEntry => !!e && typeof (e as SiteEntry).siteUrl === "string" && typeof (e as SiteEntry).permissionLevel === "string" && (e as SiteEntry).siteUrl.length <= 2000,
  );
}

const isVerified = (e: SiteEntry) => Object.prototype.hasOwnProperty.call(PERMISSIONS, e.permissionLevel);

/** A site as people read it: a domain property says so, a URL prefix is shown as it is. */
export function siteLabel(siteUrl: string): string {
  return siteUrl.startsWith("sc-domain:") ? `${siteUrl.slice("sc-domain:".length)} (whole domain)` : siteUrl;
}

async function listSites(input: Parameters<VerifyHook>[0], deps: Parameters<VerifyHook>[1]): Promise<{ ok: true; sites: SiteEntry[] } | HookFailure> {
  const res = await connectorFetch({ manifest: input.manifest, connection: input.connection, url: SITES, method: "GET", token: input.token }, deps);
  if (!res.ok) return googleFailure(res);
  const sites = sitesFrom(res.body);
  return sites ? { ok: true, sites } : { ok: false, code: "bad_response", retryAfterSec: null };
}

export const siteCheck: VerifyHook = async (input, deps) => {
  const r = await listSites(input, deps);
  if (!r.ok) return r;
  if (!input.account) return { ok: true };
  return r.sites.some((s) => s.siteUrl === input.account && isVerified(s)) ? { ok: true } : { ok: false, code: "account_refused", retryAfterSec: null };
};

export const sites: AccountsHook = async (input, deps) => {
  const r = await listSites(input, deps);
  if (!r.ok) return r;
  const accounts: ConnectorAccount[] = r.sites
    .filter(isVerified)
    .sort((a, b) => siteLabel(a.siteUrl).localeCompare(siteLabel(b.siteUrl)))
    .map((s) => ({ id: s.siteUrl, label: siteLabel(s.siteUrl), detail: PERMISSIONS[s.permissionLevel] ?? null }));
  return { ok: true, accounts: accounts.slice(0, MAX_SITES), more: accounts.length > MAX_SITES };
};

interface Row {
  keys?: unknown;
  clicks?: unknown;
  impressions?: unknown;
  ctr?: unknown;
  position?: unknown;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** A page address as its host and path: the path is the join key, the host keeps rows apart. */
function hostAndPath(raw: string): { host: string; path: string } {
  try {
    const url = new URL(raw);
    return { host: url.host.toLowerCase(), path: cleanPagePath(raw) };
  } catch {
    return { host: "", path: cleanPagePath(raw) };
  }
}

/** A row of a read grouped by day or search for one page: Google's full address rides beside it until the rows are merged. */
const ADDRESS = "address";

/**
 * Rows for the same host and path added together: Google's addresses that differ only by a query
 * string, a fragment or http and https. Clicks and impressions are summed, the click rate worked
 * out again and position weighted by impressions; `merged` says how many were added, when more
 * than one. Different hosts stay apart, as Search Console's Pages report lists them.
 *
 * By page, the address is the row's `page` and becomes its path. By day or search (a read for one
 * page, grouped by that and page), the address rides as `address` and rows merge only within the
 * same day or search; the path is the page asked for, so it isn't repeated on the row.
 */
export function mergeByHost(rows: readonly LiveRow[], key: "page" | "day" | "query" = "page"): LiveRow[] {
  const byKey = new Map<string, { host: string; page: string; group: string; clicks: number; impressions: number; weighted: number; positioned: number; n: number; first: LiveRow }>();
  for (const r of rows) {
    const { host, path } = hostAndPath(String(key === "page" ? r.page : r[ADDRESS]));
    const group = key === "page" ? path : String(r[key]);
    const id = `${group}\u0000${host}\u0000${path}`;
    const acc = byKey.get(id) ?? { host, page: path, group, clicks: 0, impressions: 0, weighted: 0, positioned: 0, n: 0, first: r };
    const impressions = (r.searchImpressions as number | null) ?? 0;
    acc.clicks += (r.searchClicks as number | null) ?? 0;
    acc.impressions += impressions;
    if (typeof r.searchPosition === "number") {
      acc.weighted += r.searchPosition * impressions;
      acc.positioned += impressions;
    }
    acc.n += 1;
    byKey.set(id, acc);
  }
  return [...byKey.values()].map((a): LiveRow => ({
    [key]: key === "page" ? a.page : a.group,
    host: a.host,
    // One address: Google's own numbers, untouched.
    ...(a.n === 1
      ? {
          searchClicks: a.first.searchClicks ?? null,
          searchImpressions: a.first.searchImpressions ?? null,
          searchCtr: a.first.searchCtr ?? null,
          searchPosition: a.first.searchPosition ?? null,
        }
      : {
          searchClicks: a.clicks,
          searchImpressions: a.impressions,
          searchCtr: a.impressions > 0 ? a.clicks / a.impressions : null,
          searchPosition: a.positioned > 0 ? a.weighted / a.positioned : null,
          merged: a.n,
        }),
  }));
}

/** Page rows merged by host and path (mergeByHost by page). */
export const mergePages = (rows: readonly LiveRow[]): LiveRow[] => mergeByHost(rows, "page");

/** Most clicked first, then most shown, then by name: Google breaks ties in no fixed order. */
function byClicks(key: "page" | "query") {
  return (a: LiveRow, b: LiveRow) =>
    ((b.searchClicks as number | null) ?? 0) - ((a.searchClicks as number | null) ?? 0) ||
    ((b.searchImpressions as number | null) ?? 0) - ((a.searchImpressions as number | null) ?? 0) ||
    String(a[key]).localeCompare(String(b[key])) ||
    String(a.host ?? "").localeCompare(String(b.host ?? ""));
}

/**
 * An RE2 pattern for one path on any of the site's hosts, with or without a query string or
 * fragment. The read groups by page beside it, so each host stays a row of its own and the query
 * string variants of one host are added together with a `merged` count, as page rows are.
 */
export function pagePattern(path: string): string {
  return `^https?://[^/]+${path.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&")}([?#].*)?$`;
}

/**
 * The last complete Pacific day, from a small query grouped by date over the last 10 days with
 * dataState all, as Google suggests: the day before metadata.first_incomplete_date (either
 * spelling); without it, the newest day listed; with nothing listed, yesterday. Never today.
 * Google defines first_incomplete_date as the first day still being collected, not as the
 * report's own boundary, so the dev check compares the days read with the report's Dates tab.
 */
export function lastCompleteFrom(body: unknown, today: string): string {
  const yesterday = addDays(today, -1);
  const b = (body ?? {}) as { rows?: unknown; metadata?: { first_incomplete_date?: unknown; firstIncompleteDate?: unknown } };
  const first = b.metadata?.first_incomplete_date ?? b.metadata?.firstIncompleteDate;
  if (isDay(first)) return earlierDay(addDays(first, -1), yesterday);
  let newest = "";
  if (Array.isArray(b.rows)) {
    for (const r of b.rows as Row[]) {
      const day = Array.isArray(r?.keys) ? r.keys[0] : null;
      if (isDay(day) && day > newest) newest = day;
    }
  }
  return newest ? earlierDay(newest, yesterday) : yesterday;
}

export const MERGED_NOTE =
  "A row with merged adds together Search Console addresses for the same page that differ only by a query string, a fragment or http and https. Search Console's Pages report lists those one by one.";

/**
 * The days that usually aren't final yet, dated. Google finishes a day 2 to 3 days later and the
 * read doesn't ask which, so the note says "may".
 */
export function notFinalNote(from: string, to: string): string {
  return `Search Console's numbers for ${daysWords(from, to)} may not be final yet. Its own report shows them too, and they may still change a little.`;
}

/** When the totals query fails but the rows came back. */
export const NO_TOTALS_NOTE = "Search Console didn't send its totals for these days this time, so this answer has none.";

/**
 * The report's headline totals: one row from a query with no dimensions, or zeros when Google
 * lists nothing (no impressions on those days); null when the answer isn't one.
 */
export function totalsFrom(body: unknown): Record<string, number | null> | null {
  const rows = (body as { rows?: unknown } | null)?.rows;
  if (body === null || typeof body !== "object" || (rows !== undefined && !Array.isArray(rows))) return null;
  const r = (Array.isArray(rows) ? rows[0] : undefined) as Row | undefined;
  if (!r) return { searchClicks: 0, searchImpressions: 0, searchCtr: null, searchPosition: null };
  return { searchClicks: num(r.clicks), searchImpressions: num(r.impressions), searchCtr: num(r.ctr), searchPosition: num(r.position) };
}

/**
 * Search analytics for the picked site, matching Search Console's own Performance report:
 * - "last N days" are the N complete Pacific days ending on its last complete day, which a small
 *   date probe finds (dataState all, grouped by date, the last 10 days);
 * - reads use dataState all, so fresh days the report shows are included, never the preliminary
 *   ones after them; settledOnly reads final numbers only, for Connectors 2;
 * - pages: up to 1,000 rows are fetched before rows for the same host and path are added together;
 * - one page: grouped by page as well, so hosts stay apart (by day, a row per day and host);
 * - totals: the report's headline clicks, impressions, click rate and position, from the same query
 *   with no dimensions, for the whole site (not for a read of one page, whose rows are by host, nor
 *   a settled read).
 */
export const searchAnalytics: LiveHook = async (input, deps) => {
  const { query } = input;
  if (query.stream !== "search_performance" || !(query.by in DIMENSION)) return { ok: false, code: "query_refused", retryAfterSec: null };
  if (!input.account) return { ok: false, code: "account_needed", retryAfterSec: null };
  const by = query.by as keyof typeof DIMENSION;
  const today = input.today;
  const lag = input.manifest.produces.find((p) => p.stream === query.stream)?.lagDays ?? 3;
  const usuallyFinal = addDays(today, -lag);
  const post = (json: unknown) => connectorFetch({ manifest: input.manifest, connection: input.connection, url: queryUrl(input.account), method: "POST", json, token: input.token }, deps);

  // The last complete day: a probe, unless every day asked is long complete or only final numbers are read.
  let lastComplete: string;
  if (query.settledOnly) lastComplete = usuallyFinal;
  else if (!query.period && query.to && query.to <= usuallyFinal) lastComplete = query.to;
  else {
    const probe = await post({ startDate: addDays(today, -(PROBE_DAYS - 1)), endDate: today, dimensions: ["date"], type: "web", dataState: "all", rowLimit: PROBE_DAYS });
    if (!probe.ok) return googleFailure(probe);
    lastComplete = lastCompleteFrom(probe.body, today);
  }
  const window = resolveWindow(query, lastComplete);
  const finalThrough = query.settledOnly ? window.to : earlierDay(usuallyFinal, window.to);
  const period = { from: window.from, to: window.to, timeZone: PACIFIC, finalThrough };
  if (window.empty) return { ok: true, rows: [], notes: [nothingYetNote("Search Console", window.from, window.to, lastComplete)], period, more: false };

  const days = daysIn(window.from, window.to);
  // One page, grouped by day or search: by page as well, so each host stays apart.
  const byHost = Boolean(query.page) && by !== "page";
  const rowLimit = by === "day" && !byHost ? days : FETCH_ROWS;
  const ask = {
    startDate: window.from,
    endDate: window.to,
    type: "web",
    dataState: query.settledOnly ? "final" : "all",
    ...(query.page ? { dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "includingRegex", expression: pagePattern(query.page) }] }] } : {}),
  };
  const res = await post({ ...ask, dimensions: byHost ? [DIMENSION[by], "page"] : [DIMENSION[by]], rowLimit });
  if (!res.ok) return googleFailure(res);
  const raw = (res.body as { rows?: unknown } | null)?.rows;
  if (raw !== undefined && !Array.isArray(raw)) return { ok: false, code: "bad_response", retryAfterSec: null };
  const key = KEY[by];
  let rows: LiveRow[] = [];
  for (const r of (raw ?? []) as Row[]) {
    const keys = Array.isArray(r?.keys) ? (r.keys as unknown[]) : [];
    const value = typeof keys[0] === "string" ? keys[0] : null;
    const address = byHost ? (typeof keys[1] === "string" && keys[1].length <= 2000 ? keys[1] : null) : undefined;
    if (value === null || address === null || (by === "day" && !isDay(value))) continue;
    if (by !== "day" && value.length > 2000) continue;
    rows.push({ [key]: value, ...(address ? { [ADDRESS]: address } : {}), searchClicks: num(r.clicks), searchImpressions: num(r.impressions), searchCtr: num(r.ctr), searchPosition: num(r.position) });
  }
  // Google sent as many rows as asked: it may have more.
  const googleFull = rowLimit === FETCH_ROWS && (raw ?? []).length >= FETCH_ROWS;
  if (by === "page" || byHost) rows = mergeByHost(rows, key);
  rows =
    by === "day"
      ? rows.sort((a, b) => String(a.day).localeCompare(String(b.day)) || String(a.host ?? "").localeCompare(String(b.host ?? "")))
      : rows.sort(byClicks(by === "page" ? "page" : "query"));

  // The report's headline totals for the whole site. Not for one page (its rows are by host) nor a
  // settled read (Connectors 2 collects days). A failure here leaves the rows standing, with a note.
  const wantsTotals = !query.page && !query.settledOnly;
  let totals: Record<string, number | null> | null = null;
  if (wantsTotals) {
    const t = await post(ask);
    totals = t.ok ? totalsFrom(t.body) : null;
  }

  const notes: string[] = [];
  if (window.capped) notes.push(query.settledOnly ? `Search Console's final numbers usually end on ${dayWords(lastComplete)}, so this read ends there.` : cappedNote("Search Console", lastComplete));
  if (query.period === "yesterday" && lastComplete < addDays(today, -1)) notes.push(nothingYetNote("Search Console", addDays(lastComplete, 1), addDays(today, -1), lastComplete));
  if (!query.settledOnly && window.to > finalThrough) notes.push(notFinalNote(laterDay(window.from, addDays(finalThrough, 1)), window.to));
  if (rows.some((r) => typeof r.merged === "number")) notes.push(MERGED_NOTE);
  if (wantsTotals && !totals) notes.push(NO_TOTALS_NOTE);
  return { ok: true, rows, notes, period, ...(totals ? { totals } : {}), more: googleFull };
};

// --- Collecting (Connectors 2, ADR-0012) ----------------------------------------------------------

/** Days a collect run reads page and search rows for (two calls each): 11 calls with the probe. */
export const COLLECT_DAYS_PER_RUN = 5;
/** Days the probe reads past the keep window while filling, so the oldest kept day is listed too. */
const PROBE_SPARE_DAYS = 9;
/** The hour, in UTC, of a day's first probe. */
export const FIRST_PROBE_HOUR_UTC = 9;

/** A day's totals from a probe row: the property's own numbers for the day (Google's byProperty). */
function dayTotalsOf(r: Row): Record<string, number | null> {
  return { searchClicks: num(r.clicks) ?? 0, searchImpressions: num(r.impressions) ?? 0, searchCtr: num(r.ctr), searchPosition: num(r.position) };
}

/** A day Google lists nothing for had no impressions: its totals are zeros. */
const ZERO_TOTALS: Record<string, number | null> = { searchClicks: 0, searchImpressions: 0, searchCtr: null, searchPosition: null };

/** A row's numbers by meaning key, leaving out any Google didn't send. */
function measuresOf(r: LiveRow): Record<string, number> {
  const m: Record<string, number> = {};
  for (const k of ["searchClicks", "searchImpressions", "searchCtr", "searchPosition", "merged"]) {
    const v = r[k];
    if (typeof v === "number" && Number.isFinite(v)) m[k] = v;
  }
  return m;
}

/**
 * Collect Search Console's final days (ADR-0012), each once:
 * 1. a probe grouped by date with dataState final, over the last 10 Pacific days (while filling,
 *    over the keep window and 9 days more), lists the days Google has finished, which are the
 *    newest day's frontier, and gives each day's totals for the property (no extra call);
 * 2. the days to read are planned from the cursor: new days oldest first, then the backfill newest
 *    first, at most 5 a run;
 * 3. each listed day gets one query by page and one by search, that day alone, final numbers,
 *    1,000 rows asked; a day at or before the frontier that the probe doesn't list had no data and
 *    gets zeros with no further call.
 * An empty probe writes nothing and asks for a hold until the next day. Every call goes through
 * safe fetch; the first failure stops the run, keeping the days already read.
 */
export const collectDays: CollectHook = async (input, deps) => {
  const { ask } = input;
  const keepDays = ask.stream.collect.keepDays;
  // The first probe of a day comes at 09:00 UTC, after Pacific midnight in summer and winter.
  const base: CollectResult = { days: [], newest: null, moreDue: false, nextDueMs: nextAt(ask.now, "UTC", FIRST_PROBE_HOUR_UTC, 0).getTime(), reachFrom: null, timeZone: PACIFIC, probed: false, hold: null, failure: null };
  if (!input.account) return { ...base, failure: { ok: false, code: "account_needed", retryAfterSec: null } };
  const today = todayIn(ask.now, PACIFIC);
  const post = (json: unknown) => connectorFetch({ manifest: input.manifest, connection: input.connection, url: queryUrl(input.account), method: "POST", json, token: input.token }, deps);

  const widest = addDays(today, -(keepDays + PROBE_SPARE_DAYS));
  const from = ask.cursor.filled && ask.cursor.lastDay ? laterDay(widest, earlierDay(addDays(ask.cursor.lastDay, 1), addDays(today, -(PROBE_DAYS - 1)))) : widest;
  const probe = await post({ startDate: from, endDate: today, dimensions: ["date"], type: "web", dataState: "final", rowLimit: daysIn(from, today) });
  if (!probe.ok) return { ...base, failure: googleFailure(probe) };
  const listed = (probe.body as { rows?: unknown } | null)?.rows;
  if (listed !== undefined && !Array.isArray(listed)) return { ...base, probed: true, failure: { ok: false, code: "bad_response", retryAfterSec: null } };
  const totals = new Map<string, Record<string, number | null>>();
  for (const r of (listed ?? []) as Row[]) {
    const day = Array.isArray(r?.keys) ? r.keys[0] : null;
    if (isDay(day) && day >= from && day <= today) totals.set(day, dayTotalsOf(r));
  }
  if (!totals.size) return { ...base, probed: true, hold: { untilMs: 0, reason: "no_data" } };
  const newest = [...totals.keys()].sort().at(-1)!;
  const out: CollectResult = { ...base, probed: true, newest };

  const planned = planDays(ask.cursor, newest, { keepDays, maxDays: COLLECT_DAYS_PER_RUN + 1 }).filter((p) => p.day >= from);
  const plan = planned.slice(0, COLLECT_DAYS_PER_RUN);
  out.moreDue = planned.length > plan.length;
  const rowsOf = async (day: string, by: "page" | "topic"): Promise<{ ok: true; rows: SnapshotRow[]; more: boolean } | HookFailure> => {
    const res = await post({ startDate: day, endDate: day, dimensions: [DIMENSION[by]], type: "web", dataState: "final", rowLimit: FETCH_ROWS });
    if (!res.ok) return googleFailure(res);
    const raw = (res.body as { rows?: unknown } | null)?.rows;
    if (raw !== undefined && !Array.isArray(raw)) return { ok: false, code: "bad_response", retryAfterSec: null };
    let rows: LiveRow[] = [];
    for (const r of (raw ?? []) as Row[]) {
      const value = Array.isArray(r?.keys) && typeof r.keys[0] === "string" ? r.keys[0] : null;
      if (value === null || value.length > 2000) continue;
      rows.push({ [KEY[by]]: value, searchClicks: num(r.clicks), searchImpressions: num(r.impressions), searchCtr: num(r.ctr), searchPosition: num(r.position) });
    }
    if (by === "page") rows = mergePages(rows);
    const key = KEY[by];
    return {
      ok: true,
      more: (raw ?? []).length >= FETCH_ROWS,
      rows: rows.map((r): SnapshotRow => ({ key: String(r[key]), ...(typeof r.host === "string" && r.host ? { host: r.host } : {}), m: measuresOf(r) })),
    };
  };

  for (const p of plan) {
    if (!ask.canStart()) {
      out.moreDue = true;
      break;
    }
    const dayTotals = totals.get(p.day);
    if (!dayTotals) {
      // At or before the frontier and not listed: no impressions that day.
      out.days.push({ day: p.day, final: true, docs: [{ by: "day", totals: ZERO_TOTALS, rows: [], more: false }, { by: "page", totals: null, rows: [], more: false }, { by: "topic", totals: null, rows: [], more: false }] });
      continue;
    }
    const page = await rowsOf(p.day, "page");
    if (!page.ok) return { ...out, failure: page };
    const topic = await rowsOf(p.day, "topic");
    if (!topic.ok) return { ...out, failure: topic };
    out.days.push({
      day: p.day,
      final: true,
      docs: [
        { by: "day", totals: dayTotals, rows: [], more: false },
        { by: "page", totals: null, rows: page.rows, more: page.more },
        { by: "topic", totals: null, rows: topic.rows, more: topic.more },
      ],
    });
  }
  return out;
};
