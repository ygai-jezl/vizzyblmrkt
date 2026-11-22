import type { ConnectorErrorCode } from "../messages";
import { cleanPagePath } from "../paths";
import { connectorFetch, type ConnectorResponse } from "../safeFetch";
import type { AccountsHook, ConnectorAccount, HookFailure, LiveHook, LiveRow, VerifyHook } from "./types";

/**
 * Google Search Console's hooks (developers.google.com/webmaster-tools/v1), called with a signed
 * in connection's access token from the token keeper:
 *
 * - siteCheck (verify) lists the account's sites (sites.list). With no site picked yet it proves
 *   the sign in works; with one, that the Google account still has verified access to it.
 * - sites (the picker) lists the sites, leaving out siteUnverifiedUser: an unverified site gives
 *   no data, and anyone can add any address to their own list.
 * - searchAnalytics reads searchAnalytics.query for the picked site, grouped by date, page or
 *   query, web results, finalized data only. By page, Google's full addresses are cut to their
 *   paths and rows for the same path are added together (clicks and impressions summed, click
 *   rate worked out again, position weighted by impressions).
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

export const NOT_FINAL_NOTE = "Search Console's last 3 days aren't final yet, so they may be missing or low.";

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
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Rows for the same page path, added together. */
function mergePages(rows: LiveRow[]): LiveRow[] {
  const byPath = new Map<string, { clicks: number; impressions: number; weighted: number; positioned: number }>();
  for (const r of rows) {
    const path = cleanPagePath(String(r.page));
    const acc = byPath.get(path) ?? { clicks: 0, impressions: 0, weighted: 0, positioned: 0 };
    const impressions = (r.searchImpressions as number | null) ?? 0;
    acc.clicks += (r.searchClicks as number | null) ?? 0;
    acc.impressions += impressions;
    if (typeof r.searchPosition === "number") {
      acc.weighted += r.searchPosition * impressions;
      acc.positioned += impressions;
    }
    byPath.set(path, acc);
  }
  return [...byPath].map(([page, a]) => ({
    page,
    searchClicks: a.clicks,
    searchImpressions: a.impressions,
    searchCtr: a.impressions > 0 ? a.clicks / a.impressions : null,
    searchPosition: a.positioned > 0 ? a.weighted / a.positioned : null,
  }));
}

export const searchAnalytics: LiveHook = async (input, deps) => {
  const { query } = input;
  if (query.stream !== "search_performance" || !(query.by in DIMENSION)) return { ok: false, code: "query_refused", retryAfterSec: null };
  if (!input.account) return { ok: false, code: "account_needed", retryAfterSec: null };
  const limit = Math.max(1, Math.min(100, Math.trunc(query.limit)));
  const res = await connectorFetch(
    {
      manifest: input.manifest,
      connection: input.connection,
      url: queryUrl(input.account),
      method: "POST",
      json: { startDate: query.from, endDate: query.to, dimensions: [DIMENSION[query.by]], type: "web", dataState: "final", rowLimit: limit },
      token: input.token,
    },
    deps,
  );
  if (!res.ok) return googleFailure(res);
  const raw = (res.body as { rows?: unknown } | null)?.rows;
  if (raw !== undefined && !Array.isArray(raw)) return { ok: false, code: "bad_response", retryAfterSec: null };
  const key = KEY[query.by];
  let rows: LiveRow[] = [];
  for (const r of (raw ?? []) as Row[]) {
    const value = Array.isArray(r?.keys) && typeof r.keys[0] === "string" ? r.keys[0] : null;
    if (value === null || (query.by === "day" && !DATE.test(value))) continue;
    rows.push({ [key]: value, searchClicks: num(r.clicks), searchImpressions: num(r.impressions), searchCtr: num(r.ctr), searchPosition: num(r.position) });
  }
  if (query.by === "page") rows = mergePages(rows);
  rows =
    query.by === "day"
      ? rows.sort((a, b) => String(a.day).localeCompare(String(b.day)))
      : rows.sort((a, b) => ((b.searchClicks as number | null) ?? 0) - ((a.searchClicks as number | null) ?? 0));
  const notes: string[] = [];
  const settled = new Date(Date.parse(`${input.today}T00:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10);
  if (query.to > settled) notes.push(NOT_FINAL_NOTE);
  return { ok: true, rows: rows.slice(0, limit), notes };
};
