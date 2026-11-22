import { cleanPagePath } from "../paths";
import { connectorFetch } from "../safeFetch";
import { googleFailure } from "./searchConsole";
import type { AccountsHook, ConnectorAccount, HookFailure, HookInput, LiveHook, LiveRow, VerifyHook } from "./types";

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
 *   {property}:runReport) by date or pagePath, which is the path without its query string, with
 *   returnPropertyQuota. Google's metadata says when rows were rolled into "(other)", sampled or
 *   held back below its privacy thresholds; each becomes a note, as does a property low on its
 *   daily tokens.
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
const DIMENSION = { day: "date", page: "pagePath" } as const;
/** Google's metric names, in the order asked, and the meaning key each becomes. */
export const GA4_METRICS = [
  ["sessions", "ga4Sessions"],
  ["activeUsers", "ga4ActiveUsers"],
  ["screenPageViews", "ga4Views"],
  ["keyEvents", "ga4KeyEvents"],
] as const;
/** Below these, a property is low on Google Analytics tokens for the day or the hour. */
const LOW_TOKENS = { day: 20_000, hour: 4_000 };

export const THRESHOLD_NOTE = "Google Analytics held back some small numbers to protect visitors' privacy, so these may be low.";
export const OTHER_NOTE = "Google Analytics grouped some rarely visited pages as (other), so they aren't listed one by one.";
export const SAMPLED_NOTE = "Google Analytics worked these numbers out from a sample of the visits, so they are estimates.";
export const QUOTA_NOTE = "This property has used most of its Google Analytics allowance for now, so reads may stop for a while.";
export const NOT_FINAL_NOTE = "Google Analytics can take a day or two to finish a day's numbers, so the last 2 days may be low.";

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

export const runReport: LiveHook = async (input, deps) => {
  const { query } = input;
  if (query.stream !== "site_traffic" || !(query.by in DIMENSION)) return { ok: false, code: "query_refused", retryAfterSec: null };
  if (!input.account) return { ok: false, code: "account_needed", retryAfterSec: null };
  if (!PROPERTY_RE.test(input.account)) return { ok: false, code: "account_refused", retryAfterSec: null };
  const by = query.by as keyof typeof DIMENSION;
  const limit = Math.max(1, Math.min(100, Math.trunc(query.limit)));
  const res = await connectorFetch(
    {
      manifest: input.manifest,
      connection: input.connection,
      url: runReportUrl(input.account),
      method: "POST",
      json: {
        dateRanges: [{ startDate: query.from, endDate: query.to }],
        dimensions: [{ name: DIMENSION[by] }],
        metrics: GA4_METRICS.map(([name]) => ({ name })),
        orderBys: by === "day" ? [{ dimension: { dimensionName: "date" } }] : [{ metric: { metricName: "screenPageViews" }, desc: true }],
        limit,
        keepEmptyRows: false,
        returnPropertyQuota: true,
      },
      token: input.token,
    },
    deps,
  );
  if (!res.ok) return googleFailure(res);
  const body = res.body as { metricHeaders?: unknown; rows?: unknown; metadata?: unknown; propertyQuota?: unknown } | null;
  if (!body || (body.rows !== undefined && !Array.isArray(body.rows))) return { ok: false, code: "bad_response", retryAfterSec: null };
  // Metric columns by Google's header names, so their order can't mix the meanings up.
  const headers = Array.isArray(body.metricHeaders) ? (body.metricHeaders as Array<{ name?: unknown }>).map((h) => (typeof h?.name === "string" ? h.name : "")) : [];
  const keyOf = new Map<string, string>(GA4_METRICS.map(([name, key]) => [name, key]));
  const notes = new Set<string>();
  const rows: LiveRow[] = [];
  for (const r of (body.rows ?? []) as Array<{ dimensionValues?: unknown; metricValues?: unknown }>) {
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
      value = cleanPagePath(dim);
    }
    const row: LiveRow = { [by]: value, ga4Sessions: null, ga4ActiveUsers: null, ga4Views: null, ga4KeyEvents: null };
    const values = Array.isArray(r.metricValues) ? (r.metricValues as Array<{ value?: unknown }>) : [];
    headers.forEach((name, i) => {
      const key = keyOf.get(name);
      if (key) row[key] = count(values[i]?.value);
    });
    rows.push(row);
  }
  const meta = (body.metadata ?? {}) as { subjectToThresholding?: unknown; dataLossFromOtherRow?: unknown; samplingMetadatas?: unknown };
  if (meta.subjectToThresholding === true) notes.add(THRESHOLD_NOTE);
  if (meta.dataLossFromOtherRow === true) notes.add(OTHER_NOTE);
  if (Array.isArray(meta.samplingMetadatas) && meta.samplingMetadatas.length) notes.add(SAMPLED_NOTE);
  const quota = (body.propertyQuota ?? {}) as { tokensPerDay?: unknown; tokensPerHour?: unknown };
  const day = remaining(quota.tokensPerDay);
  const hour = remaining(quota.tokensPerHour);
  if ((day !== null && day < LOW_TOKENS.day) || (hour !== null && hour < LOW_TOKENS.hour)) notes.add(QUOTA_NOTE);
  const settled = new Date(Date.parse(`${input.today}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
  if (query.to > settled) notes.add(NOT_FINAL_NOTE);

  const sorted =
    by === "day"
      ? rows.sort((a, b) => String(a.day).localeCompare(String(b.day)))
      : rows.sort((a, b) => ((b.ga4Views as number | null) ?? 0) - ((a.ga4Views as number | null) ?? 0));
  return { ok: true, rows: sorted.slice(0, limit), notes: [...notes] };
};
