import { newestDue, planDays } from "../collect/schedule";
import type { ConnectorErrorCode } from "../messages";
import { addDays, cappedNote, daysIn, dayWords, daysWords, earlierDay, isDay, laterDay, nothingYetNote, resolveWindow } from "../period";
import { connectorFetch, type ConnectorResponse } from "../safeFetch";
import type { AccountsHook, CollectHook, CollectResult, ConnectorAccount, HookFailure, LiveHook, LiveRow, VerifyHook } from "./types";

/**
 * Cloudflare's hooks, over its GraphQL Analytics API (developers.cloudflare.com/analytics/
 * graphql-api). It answers HTTP 200 even when a query fails, with the reasons in `errors`
 * ("Unauthorized", "zones [...] are not authorized", "cannot request data older than...",
 * "rate limiter budget depleted..."), so every answer's `errors` is read before its data.
 *
 * - zoneProbe proves the token reads analytics for this zone: one tiny query on the daily dataset
 *   (user/tokens/verify may refuse account tokens and doesn't prove zone access).
 * - zoneDaily reads what the dashboard's Traffic tab shows: requests (count), page views
 *   (successful HTML responses) and visits from httpRequestsAdaptiveGroups filtered to end users
 *   (requestSource eyeball), for the days the zone's retention allows (its settings node:
 *   notOlderThan and maxDuration; at least 31 days kept and 30 days a request on every plan since
 *   2 Oct 2026). Older days, and unique visitors (uniq.uniques, what the Free plan's dashboard
 *   shows), come from the daily totals, httpRequests1dGroups, whose requests and page views count
 *   all traffic; a note names those days. Days are whole UTC days. When only the end user part
 *   fails, the daily totals stand in, with a note. Totals for the whole period come from the same
 *   datasets with no dimensions, as the dashboard's own totals do: unique visitors always, and
 *   requests, page views and visits when every day read is within the end user reach.
 * - zones lists the zones a pasted token can see, for the picker on the Listing (GET
 *   /client/v4/zones, which needs Zone Read; at most 50 a page, so at most 4 pages). This one is
 *   REST: it answers `success`, `errors` with numeric codes, `result` and `result_info`. A token
 *   Cloudflare doesn't accept at all is token_refused; one that may not list zones (403, or no
 *   zones listed) means the Zone ID is typed instead, and Connect checks the token with it.
 *
 * Variables carry every value from outside; the query text is fixed but for a row limit that is
 * an integer checked here, and whether the end user parts are asked for.
 */

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";

const PROBE = `query ZoneProbe($zoneTag: string, $from: Date, $to: Date) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequests1dGroups(limit: 1, filter: { date_geq: $from, date_leq: $to }) {
        dimensions { date }
      }
    }
  }
}`;

const SETTINGS = `query ZoneSettings($zoneTag: string) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      settings {
        httpRequestsAdaptiveGroups { enabled notOlderThan maxDuration }
      }
    }
  }
}`;

/**
 * One read: the daily dataset for every day (unique visitors, and all traffic for days the
 * adaptive one no longer keeps), and, for the days the zone's retention allows, the adaptive
 * dataset filtered to end users (requestSource eyeball), as the dashboard's Traffic tab shows:
 * requests (count) and visits, and page views as successful HTML responses.
 *
 * Totals ask the same datasets with no dimensions, which Cloudflare answers as one group for the
 * whole filter: `total` gives unique visitors for the period (daily visitors can't be added up),
 * and with `adaptiveTotals`, when every day read is within the end user reach, `trafficTotal` and
 * `pagesTotal` give its requests, visits and page views.
 */
export function zoneDailyQuery(limit: number, adaptive: boolean, adaptiveTotals = false): string {
  const rows = Math.max(1, Math.min(100, Math.trunc(limit)));
  const endUsers = `date_geq: $afrom, date_leq: $ato, requestSource: "eyeball"`;
  const html = `edgeResponseContentTypeName: "html", edgeResponseStatus_geq: 200, edgeResponseStatus_lt: 300`;
  return `query ZoneDaily($zoneTag: string, $from: Date, $to: Date${adaptive ? ", $afrom: Date, $ato: Date" : ""}) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      daily: httpRequests1dGroups(limit: ${rows}, filter: { date_geq: $from, date_leq: $to }, orderBy: [date_ASC]) {
        dimensions { date }
        sum { requests pageViews }
        uniq { uniques }
      }
      total: httpRequests1dGroups(limit: 1, filter: { date_geq: $from, date_leq: $to }) {
        uniq { uniques }
      }${
        adaptive
          ? `
      traffic: httpRequestsAdaptiveGroups(limit: ${rows}, filter: { ${endUsers} }, orderBy: [date_ASC]) {
        dimensions { date }
        count
        sum { visits }
      }
      pages: httpRequestsAdaptiveGroups(limit: ${rows}, filter: { ${endUsers}, ${html} }, orderBy: [date_ASC]) {
        dimensions { date }
        count
      }`
          : ""
      }${
        adaptive && adaptiveTotals
          ? `
      trafficTotal: httpRequestsAdaptiveGroups(limit: 1, filter: { ${endUsers} }) {
        count
        sum { visits }
      }
      pagesTotal: httpRequestsAdaptiveGroups(limit: 1, filter: { ${endUsers}, ${html} }) {
        count
      }`
          : ""
      }
    }
  }
}`;
}

/**
 * How far back, and how many days at once, the adaptive dataset reads, from the zone's settings
 * (seconds). Cloudflare documents at least 31 days kept and 30 days a request on every plan since
 * 2 Oct 2026, so those are used when the settings can't be read.
 */
export const ADAPTIVE_DEFAULTS = { notOlderThan: 31 * 86_400, maxDuration: 30 * 86_400 };

/** The settings in an answer, or the defaults; enabled false means the zone can't read the dataset. */
export function adaptiveSettings(body: unknown): { enabled: boolean; notOlderThan: number; maxDuration: number } {
  const zones = zonesOf(body);
  const set = (zones?.[0] as { settings?: { httpRequestsAdaptiveGroups?: { enabled?: unknown; notOlderThan?: unknown; maxDuration?: unknown } } } | undefined)?.settings
    ?.httpRequestsAdaptiveGroups;
  const seconds = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback);
  return {
    enabled: set?.enabled !== false,
    notOlderThan: seconds(set?.notOlderThan, ADAPTIVE_DEFAULTS.notOlderThan),
    maxDuration: seconds(set?.maxDuration, ADAPTIVE_DEFAULTS.maxDuration),
  };
}

/** The first day of a read the adaptive dataset can give: whole UTC days inside its retention and its widest range. */
export function adaptiveFrom(now: Date, from: string, to: string, s: { notOlderThan: number; maxDuration: number }): string {
  const oldest = new Date(Math.ceil((now.getTime() - s.notOlderThan * 1000) / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
  const widest = addDays(to, -(Math.max(1, Math.floor(s.maxDuration / 86_400)) - 1));
  return laterDay(laterDay(from, oldest), widest);
}

/** Days before the adaptive dataset's reach, read from the daily totals instead: dated. */
export function olderDaysNote(from: string, to: string): string {
  return `Cloudflare keeps end user numbers only for recent days, so for ${daysWords(from, to)} requests and page views count all traffic, bots included, and visits are empty.`;
}

/** When the end user part of a read fails, the daily totals stand in for every day. */
export const END_USERS_NOTE =
  "Cloudflare didn't give end user numbers for these days, so requests and page views count all traffic, bots included, and visits are empty.";

/** When the period's totals fail but the days came back. */
export const NO_TOTALS_NOTE = "Cloudflare didn't send its totals for these days this time, so this answer has none.";

/** The Free plan's delay, dated, for a read that reaches the last day. */
export function freePlanNote(day: string): string {
  return `On Cloudflare's Free plan numbers arrive 24 hours late, so if this zone is on it, ${dayWords(day)} may be low.`;
}

interface GraphQLError {
  message?: unknown;
  path?: unknown;
}

/** The code for a list of GraphQL errors, from their messages. */
export function classifyErrors(errors: readonly GraphQLError[]): ConnectorErrorCode {
  const text = errors.map((e) => String(e.message ?? "").toLowerCase()).join(" | ");
  if (/\bunauthori[sz]ed\b|authentication|invalid (api )?token/.test(text)) return "token_refused";
  if (/not authorized|does not have access|not allowed|permission/.test(text)) return "account_refused";
  if (/rate limit|budget depleted|excessive resources|too many requests/.test(text)) return "rate_limited";
  if (/older than|time range|cannot request|limit|exceed|unknown|invalid|cannot query/.test(text)) return "query_refused";
  return "provider_error";
}

function errorsOf(body: unknown): GraphQLError[] {
  const errors = (body as { errors?: unknown } | null)?.errors;
  return Array.isArray(errors) ? (errors as GraphQLError[]) : [];
}

function zonesOf(body: unknown): unknown[] | null {
  const zones = (body as { data?: { viewer?: { zones?: unknown } } } | null)?.data?.viewer?.zones;
  return Array.isArray(zones) ? zones : null;
}

/** A failed call, with its code refined by Cloudflare's own errors when it sent any. */
function failure(res: Extract<ConnectorResponse, { ok: false }>): HookFailure {
  const errors = errorsOf(res.body);
  const refined = errors.length ? classifyErrors(errors) : null;
  const code = refined && refined !== "provider_error" ? refined : res.code;
  return { ok: false, code, retryAfterSec: res.retryAfterSec };
}

function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

export const zoneProbe: VerifyHook = async (input, deps) => {
  const today = (deps.now ?? new Date()).toISOString().slice(0, 10);
  const res = await connectorFetch(
    {
      manifest: input.manifest,
      connection: input.connection,
      url: GRAPHQL,
      method: "POST",
      json: { query: PROBE, variables: { zoneTag: input.account, from: dayBefore(today), to: today } },
      token: input.token,
    },
    deps,
  );
  if (!res.ok) return failure(res);
  const errors = errorsOf(res.body);
  if (errors.length) return { ok: false, code: classifyErrors(errors), retryAfterSec: null };
  const zones = zonesOf(res.body);
  if (!zones) return { ok: false, code: "bad_response", retryAfterSec: null };
  if (zones.length !== 1) return { ok: false, code: "account_refused", retryAfterSec: null };
  return { ok: true };
};

/** Failures of the settings call that would fail the read too, so it stops there. */
const STOPS_A_READ: ReadonlySet<ConnectorErrorCode> = new Set(["token_refused", "account_refused", "rate_limited", "busy", "redirect_refused", "host_not_allowed"]);

/** The parts of a read that can fail on their own: the end user days, and the totals. */
const SOFT_PARTS = ["traffic", "pages", "total", "trafficTotal", "pagesTotal"] as const;

/**
 * The parts that failed, when every error is about one of them alone; null when any error is about
 * the daily totals or names no part, which fails the read.
 */
function softFailures(errors: readonly GraphQLError[]): Set<string> | null {
  const parts = new Set<string>();
  for (const e of errors) {
    const path = Array.isArray(e.path) ? (e.path as unknown[]) : [];
    const part = SOFT_PARTS.find((p) => path.includes(p));
    if (!part || path.includes("daily")) return null;
    parts.add(part);
  }
  return parts;
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

type Group = { dimensions?: { date?: unknown }; count?: unknown; sum?: { requests?: unknown; pageViews?: unknown; visits?: unknown }; uniq?: { uniques?: unknown } };

/** Groups by their day, for days inside the read. */
function byDay(groups: unknown, from: string, to: string): Map<string, Group> {
  const out = new Map<string, Group>();
  if (!Array.isArray(groups)) return out;
  for (const g of groups as Group[]) {
    const day = g?.dimensions?.date;
    if (typeof day === "string" && isDay(day) && day >= from && day <= to) out.set(day, g);
  }
  return out;
}

/**
 * A zone's days, as the dashboard shows them, in whole UTC days ending on the last complete one
 * (yesterday in UTC). Two calls: the zone's settings for the adaptive dataset, then the numbers.
 */
export const zoneDaily: LiveHook = async (input, deps) => {
  const { query } = input;
  if (query.stream !== "zone_daily" || query.by !== "day") return { ok: false, code: "query_refused", retryAfterSec: null };
  const now = deps.now ?? new Date();
  const today = input.today;
  const lastComplete = addDays(today, -1);
  const window = resolveWindow(query, lastComplete);
  // On the Free plan yesterday may still be low (freePlanNote), so only the day before is counted final.
  const period = { from: window.from, to: window.to, timeZone: "UTC", finalThrough: earlierDay(addDays(lastComplete, -1), window.to) };
  if (window.empty) return { ok: true, rows: [], notes: [nothingYetNote("Cloudflare", window.from, window.to, lastComplete)], period, more: false };
  const post = (json: unknown) => connectorFetch({ manifest: input.manifest, connection: input.connection, url: GRAPHQL, method: "POST", json, token: input.token }, deps);

  // How far back end user numbers go for this zone. Settings that can't be read fall back to
  // Cloudflare's documented floor, so a read never fails on them alone; a token or zone Cloudflare
  // turns down, or a rate limit, stops the read here.
  const settingsRes = await post({ query: SETTINGS, variables: { zoneTag: input.account } });
  if (!settingsRes.ok) {
    const f = failure(settingsRes);
    if (STOPS_A_READ.has(f.code)) return f;
  }
  const settings = !settingsRes.ok || errorsOf(settingsRes.body).length ? { enabled: true, ...ADAPTIVE_DEFAULTS } : adaptiveSettings(settingsRes.body);
  const afrom = settings.enabled ? adaptiveFrom(now, window.from, window.to, settings) : null;
  const adaptive = afrom !== null && afrom <= window.to;
  // Totals for requests, page views and visits only when every day read is end users alone.
  const adaptiveTotals = adaptive && afrom === window.from;

  const days = daysIn(window.from, window.to);
  const res = await post({
    query: zoneDailyQuery(days, adaptive, adaptiveTotals),
    variables: { zoneTag: input.account, from: window.from, to: window.to, ...(adaptive ? { afrom, ato: window.to } : {}) },
  });
  if (!res.ok) return failure(res);
  const errors = errorsOf(res.body);
  const soft = softFailures(errors);
  if (!soft) return { ok: false, code: classifyErrors(errors), retryAfterSec: null };
  const endUsersFailed = soft.has("traffic") || soft.has("pages");
  const zones = zonesOf(res.body);
  if (!zones) return { ok: false, code: "bad_response", retryAfterSec: null };
  if (zones.length !== 1) return { ok: false, code: "account_refused", retryAfterSec: null };
  const zone = zones[0] as { daily?: unknown; traffic?: unknown; pages?: unknown; total?: unknown; trafficTotal?: unknown; pagesTotal?: unknown };
  if (!Array.isArray(zone.daily)) return { ok: false, code: "bad_response", retryAfterSec: null };

  const endUsers = adaptive && !endUsersFailed && Array.isArray(zone.traffic) && Array.isArray(zone.pages);
  const daily = byDay(zone.daily, window.from, window.to);
  const traffic = endUsers ? byDay(zone.traffic, afrom!, window.to) : new Map<string, Group>();
  const pages = endUsers ? byDay(zone.pages, afrom!, window.to) : new Map<string, Group>();
  const rows: LiveRow[] = [];
  for (const day of [...new Set([...daily.keys(), ...traffic.keys()])].sort()) {
    const d = daily.get(day);
    const recent = endUsers && day >= afrom!;
    const t = traffic.get(day);
    rows.push({
      day,
      // End users only where the adaptive dataset reaches; a day it lists nothing for has no number
      // (it may not have arrived yet), and a day with traffic but no HTML responses had no page views.
      cfRequests: recent ? (t ? count(t.count) : null) : count(d?.sum?.requests),
      cfPageViews: recent ? (t ? count(pages.get(day)?.count ?? 0) : null) : count(d?.sum?.pageViews),
      cfVisits: recent && t ? count(t.sum?.visits) : null,
      cfUniqueVisitors: d ? count(d.uniq?.uniques) : null,
    });
  }

  // The period's own totals, as one group each: unique visitors from the daily dataset, and end
  // user requests, page views and visits where every day read is within their reach.
  const first = (v: unknown): Group | undefined => (Array.isArray(v) ? (v[0] as Group | undefined) : undefined);
  const totals: Record<string, number | null> = {};
  if (!soft.has("total") && Array.isArray(zone.total)) totals.cfUniqueVisitors = count(first(zone.total)?.uniq?.uniques);
  if (adaptiveTotals && endUsers && !soft.has("trafficTotal") && !soft.has("pagesTotal") && Array.isArray(zone.trafficTotal) && Array.isArray(zone.pagesTotal)) {
    const t = first(zone.trafficTotal);
    totals.cfRequests = t ? count(t.count) : null;
    totals.cfPageViews = t ? count(first(zone.pagesTotal)?.count ?? 0) : null;
    totals.cfVisits = t ? count(t.sum?.visits) : null;
  }
  const hasTotals = Object.keys(totals).length > 0;

  const notes: string[] = [];
  if (window.capped) notes.push(cappedNote("Cloudflare", lastComplete));
  if ((adaptive && !endUsers) || !settings.enabled) notes.push(END_USERS_NOTE);
  else if (!adaptive) notes.push(olderDaysNote(window.from, window.to));
  else if (afrom! > window.from) notes.push(olderDaysNote(window.from, addDays(afrom!, -1)));
  if (window.to >= lastComplete) notes.push(freePlanNote(window.to));
  if (!hasTotals) notes.push(NO_TOTALS_NOTE);
  return { ok: true, rows, notes, period, ...(hasTotals ? { totals } : {}), more: false };
};

const ZONES = "https://api.cloudflare.com/client/v4/zones";
/** Cloudflare lists at most 50 zones a page. */
const ZONES_PER_PAGE = 50;
/** The most zones the picker shows (4 pages); past that, the Zone ID can be typed. */
export const MAX_ZONES = 200;
/**
 * Cloudflare's codes for a token it doesn't accept at all (Invalid API Token, and an Authorization
 * header it can't read), as against one that is fine but may not list zones (9109, 10000).
 */
const TOKEN_CODES: ReadonlySet<number> = new Set([1000, 6003, 6111]);
const ZONE_ID = /^[0-9a-f]{32}$/;

function restCodes(body: unknown): number[] {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((e) => (e as { code?: unknown } | null)?.code).filter((c): c is number => typeof c === "number");
}

/** A failed zones list: a token Cloudflare refuses outright, one that may not list (403), or the call's own code. */
function zonesFailure(res: Extract<ConnectorResponse, { ok: false }>): HookFailure {
  if (res.status === 401 || restCodes(res.body).some((c) => TOKEN_CODES.has(c))) return { ok: false, code: "token_refused", retryAfterSec: null };
  if (res.status === 403) return { ok: false, code: "account_refused", retryAfterSec: null };
  return { ok: false, code: res.code, retryAfterSec: res.retryAfterSec };
}

/** The zones in one page of the list, and how many pages there are, or null when it isn't a list. */
export function zonePage(body: unknown): { zones: ConnectorAccount[]; pages: number } | null {
  const b = body as { success?: unknown; result?: unknown; result_info?: { total_pages?: unknown } } | null;
  if (!b || b.success !== true || !Array.isArray(b.result)) return null;
  const zones: ConnectorAccount[] = [];
  for (const z of b.result as Array<{ id?: unknown; name?: unknown; status?: unknown }>) {
    if (typeof z?.id !== "string" || !ZONE_ID.test(z.id) || typeof z.name !== "string" || !z.name || z.name.length > 253) continue;
    zones.push({ id: z.id, label: z.name, detail: z.status === "active" ? null : "Not active in Cloudflare yet" });
  }
  const pages = b.result_info?.total_pages;
  return { zones, pages: typeof pages === "number" && Number.isFinite(pages) && pages >= 1 ? pages : 1 };
}

export const zones: AccountsHook = async (input, deps) => {
  const out: ConnectorAccount[] = [];
  const lastPage = MAX_ZONES / ZONES_PER_PAGE;
  for (let page = 1; page <= lastPage; page++) {
    const res = await connectorFetch(
      { manifest: input.manifest, connection: input.connection, url: `${ZONES}?page=${page}&per_page=${ZONES_PER_PAGE}&order=name&direction=asc`, method: "GET", token: input.token },
      deps,
    );
    if (!res.ok) return zonesFailure(res);
    if (restCodes(res.body).some((c) => TOKEN_CODES.has(c))) return { ok: false, code: "token_refused", retryAfterSec: null };
    const listed = zonePage(res.body);
    if (!listed) return { ok: false, code: "bad_response", retryAfterSec: null };
    out.push(...listed.zones);
    if (page >= listed.pages) return { ok: true, accounts: out.slice(0, MAX_ZONES), more: false };
  }
  return { ok: true, accounts: out.slice(0, MAX_ZONES), more: true };
};

// --- Collecting (Connectors 2, ADR-0012) ----------------------------------------------------------

/** A UTC day D is collected 2 days later from 03:00 UTC: the Free plan's numbers arrive 24 hours late. */
export const COLLECT_LAG_DAYS = 2;
export const COLLECT_HOUR = 3;
/** One query reads at most this many days (its row limit). */
const MAX_QUERY_DAYS = 100;

/** Both datasets' settings: how far back each reads, and how many days at once. */
const COLLECT_SETTINGS = `query ZoneSettings($zoneTag: string) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      settings {
        httpRequestsAdaptiveGroups { enabled notOlderThan maxDuration }
        httpRequests1dGroups { enabled notOlderThan maxDuration }
      }
    }
  }
}`;

/**
 * The daily totals' reach from the zone's settings (seconds), or null when it can't be read: the
 * live limits page tells readers to take each plan's limit from this node.
 */
export function dailySettings(body: unknown): { notOlderThan: number | null; maxDuration: number | null } {
  const set = ((zonesOf(body)?.[0] as { settings?: { httpRequests1dGroups?: { notOlderThan?: unknown; maxDuration?: unknown } } } | undefined)?.settings?.httpRequests1dGroups) ?? {};
  const seconds = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  return { notOlderThan: seconds(set.notOlderThan), maxDuration: seconds(set.maxDuration) };
}

/** The oldest whole UTC day a dataset keeping `seconds` still holds. */
export function oldestDay(now: Date, seconds: number): string {
  return new Date(Math.ceil((now.getTime() - seconds * 1000) / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Collect a zone's daily totals (ADR-0012), two UTC days after each day, in one query: end user
 * requests, page views and visits (the adaptive dataset, filtered to eyeball traffic) as far back as
 * it reaches, and the daily totals before that, which count all traffic and have no visits, each
 * day marked with its basis. Unique visitors always come from the daily totals. The zone's settings
 * node gives both datasets' reach: the backfill is clamped to the daily totals' notOlderThan and
 * maxDuration. A day neither dataset lists, two days on, had no traffic. Zone totals only: AI
 * crawlers by bot and page need other datasets, some paid only.
 */
export const collectDays: CollectHook = async (input, deps) => {
  const { ask } = input;
  const keepDays = ask.stream.collect.keepDays;
  const newest = newestDue(ask.now, "UTC", COLLECT_LAG_DAYS, COLLECT_HOUR);
  const base: CollectResult = { days: [], newest, reachFrom: null, timeZone: "UTC", probed: false, hold: null, failure: null };
  if (!ask.canStart()) return base;
  const post = (json: unknown) => connectorFetch({ manifest: input.manifest, connection: input.connection, url: GRAPHQL, method: "POST", json, token: input.token }, deps);

  const settingsRes = await post({ query: COLLECT_SETTINGS, variables: { zoneTag: input.account } });
  if (!settingsRes.ok) {
    const f = failure(settingsRes);
    if (STOPS_A_READ.has(f.code)) return { ...base, failure: f };
  }
  const readable = settingsRes.ok && !errorsOf(settingsRes.body).length;
  const adaptive = readable ? adaptiveSettings(settingsRes.body) : { enabled: true, ...ADAPTIVE_DEFAULTS };
  const daily = readable ? dailySettings(settingsRes.body) : { notOlderThan: null, maxDuration: null };
  const reachFrom = daily.notOlderThan ? oldestDay(ask.now, daily.notOlderThan) : null;
  const out: CollectResult = { ...base, reachFrom };

  let plan = planDays(ask.cursor, newest, { keepDays, maxDays: keepDays, reachFrom });
  if (!plan.length) return out;
  const span = () => ({ from: plan.map((p) => p.day).sort()[0]!, to: plan.map((p) => p.day).sort().at(-1)! });
  // One query: the forward days come first, so a range too wide for one query drops the backfill.
  const widest = Math.min(MAX_QUERY_DAYS, daily.maxDuration ? Math.max(1, Math.floor(daily.maxDuration / 86_400)) : MAX_QUERY_DAYS);
  while (plan.length > 1 && daysIn(span().from, span().to) > widest) plan = plan.slice(0, -1);
  const { from, to } = span();
  const afrom = adaptive.enabled ? adaptiveFrom(ask.now, from, to, adaptive) : null;
  const endUserDays = afrom !== null && afrom <= to;
  const res = await post({
    query: zoneDailyQuery(daysIn(from, to), endUserDays, false),
    variables: { zoneTag: input.account, from, to, ...(endUserDays ? { afrom, ato: to } : {}) },
  });
  if (!res.ok) return { ...out, failure: failure(res) };
  const soft = softFailures(errorsOf(res.body));
  if (!soft) return { ...out, failure: { ok: false, code: classifyErrors(errorsOf(res.body)), retryAfterSec: null } };
  const zones = zonesOf(res.body);
  if (!zones) return { ...out, failure: { ok: false, code: "bad_response", retryAfterSec: null } };
  if (zones.length !== 1) return { ...out, failure: { ok: false, code: "account_refused", retryAfterSec: null } };
  const zone = zones[0] as { daily?: unknown; traffic?: unknown; pages?: unknown };
  if (!Array.isArray(zone.daily)) return { ...out, failure: { ok: false, code: "bad_response", retryAfterSec: null } };
  const endUsers = endUserDays && !soft.has("traffic") && !soft.has("pages") && Array.isArray(zone.traffic) && Array.isArray(zone.pages);
  const days = byDay(zone.daily, from, to);
  const traffic = endUsers ? byDay(zone.traffic, afrom!, to) : new Map<string, Group>();
  const pages = endUsers ? byDay(zone.pages, afrom!, to) : new Map<string, Group>();

  for (const p of [...plan].sort((a, b) => a.day.localeCompare(b.day))) {
    const d = days.get(p.day);
    const recent = endUsers && p.day >= afrom!;
    const t = traffic.get(p.day);
    out.days.push({
      day: p.day,
      final: true,
      docs: [
        {
          by: "day",
          totals: {
            cfRequests: recent ? (t ? count(t.count) : 0) : (d ? count(d.sum?.requests) : 0),
            cfPageViews: recent ? (t ? count(pages.get(p.day)?.count ?? 0) : 0) : (d ? count(d.sum?.pageViews) : 0),
            cfVisits: recent ? (t ? count(t.sum?.visits) : 0) : null,
            cfUniqueVisitors: d ? count(d.uniq?.uniques) : 0,
          },
          rows: [],
          more: false,
          basis: recent ? "end_users" : "all_traffic",
        },
      ],
    });
  }
  return out;
};
