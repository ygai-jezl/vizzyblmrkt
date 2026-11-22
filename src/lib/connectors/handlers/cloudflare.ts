import type { ConnectorErrorCode } from "../messages";
import { connectorFetch, type ConnectorResponse } from "../safeFetch";
import type { AccountsHook, ConnectorAccount, HookFailure, LiveHook, LiveRow, VerifyHook } from "./types";

/**
 * Cloudflare's hooks, over its GraphQL Analytics API (developers.cloudflare.com/analytics/
 * graphql-api). It answers HTTP 200 even when a query fails, with the reasons in `errors`
 * ("Unauthorized", "zones [...] are not authorized", "cannot request data older than...",
 * "rate limiter budget depleted..."), so every answer's `errors` is read before its data.
 *
 * - zoneProbe proves the token reads analytics for this zone: one tiny query on the daily dataset
 *   (user/tokens/verify may refuse account tokens and doesn't prove zone access).
 * - zoneDaily reads requests and page views from httpRequests1dGroups and visits from
 *   httpRequestsAdaptiveGroups (sum.visits, sampled, about 31 days kept on every plan). When only
 *   the visits part fails, the totals still come back, with visits empty and a note.
 * - zones lists the zones a pasted token can see, for the picker on the Listing (GET
 *   /client/v4/zones, which needs Zone Read; at most 50 a page, so at most 4 pages). This one is
 *   REST: it answers `success`, `errors` with numeric codes, `result` and `result_info`. A token
 *   Cloudflare doesn't accept at all is token_refused; one that may not list zones (403, or no
 *   zones listed) means the Zone ID is typed instead, and Connect checks the token with it.
 *
 * Variables carry every value from outside; the query text is fixed but for a row limit that is
 * an integer checked here.
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

const daily = (limit: number) => `query ZoneDaily($zoneTag: string, $from: Date, $to: Date) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      totals: httpRequests1dGroups(limit: ${limit}, filter: { date_geq: $from, date_leq: $to }, orderBy: [date_ASC]) {
        dimensions { date }
        sum { requests pageViews }
      }
      visits: httpRequestsAdaptiveGroups(limit: ${limit}, filter: { date_geq: $from, date_leq: $to, requestSource: "eyeball" }, orderBy: [date_ASC]) {
        dimensions { date }
        sum { visits }
      }
    }
  }
}`;

/** When only the sampled visits part fails: it keeps about a month, and some plans give fewer days at once. */
export const VISITS_NOTE = "Visits aren't available for these days: Cloudflare keeps them for about a month, and some plans give only a few days at a time.";

interface GraphQLError {
  message?: unknown;
  path?: unknown;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

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

/** True when every error is about the visits part of the query alone. */
function onlyVisitsFailed(errors: readonly GraphQLError[]): boolean {
  return errors.length > 0 && errors.every((e) => Array.isArray(e.path) && e.path.includes("visits") && !e.path.includes("totals"));
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

export const zoneDaily: LiveHook = async (input, deps) => {
  const { query } = input;
  if (query.stream !== "zone_daily" || query.by !== "day") return { ok: false, code: "query_refused", retryAfterSec: null };
  const limit = Math.max(1, Math.min(100, Math.trunc(query.limit)));
  const res = await connectorFetch(
    {
      manifest: input.manifest,
      connection: input.connection,
      url: GRAPHQL,
      method: "POST",
      json: { query: daily(limit), variables: { zoneTag: input.account, from: query.from, to: query.to } },
      token: input.token,
    },
    deps,
  );
  if (!res.ok) return failure(res);
  const errors = errorsOf(res.body);
  const visitsFailed = onlyVisitsFailed(errors);
  if (errors.length && !visitsFailed) return { ok: false, code: classifyErrors(errors), retryAfterSec: null };
  const zones = zonesOf(res.body);
  if (!zones) return { ok: false, code: "bad_response", retryAfterSec: null };
  if (zones.length !== 1) return { ok: false, code: "account_refused", retryAfterSec: null };
  const zone = zones[0] as { totals?: unknown; visits?: unknown };
  if (!Array.isArray(zone.totals)) return { ok: false, code: "bad_response", retryAfterSec: null };

  const byDay = new Map<string, LiveRow>();
  const row = (day: string): LiveRow => {
    let r = byDay.get(day);
    if (!r) {
      r = { day, cfRequests: null, cfPageViews: null, cfVisits: null };
      byDay.set(day, r);
    }
    return r;
  };
  for (const g of zone.totals as Array<{ dimensions?: { date?: unknown }; sum?: { requests?: unknown; pageViews?: unknown } }>) {
    const day = g?.dimensions?.date;
    if (typeof day !== "string" || !DATE.test(day)) continue;
    const r = row(day);
    r.cfRequests = count(g.sum?.requests);
    r.cfPageViews = count(g.sum?.pageViews);
  }
  if (Array.isArray(zone.visits)) {
    for (const g of zone.visits as Array<{ dimensions?: { date?: unknown }; sum?: { visits?: unknown } }>) {
      const day = g?.dimensions?.date;
      if (typeof day !== "string" || !DATE.test(day)) continue;
      row(day).cfVisits = count(g.sum?.visits);
    }
  }

  const notes: string[] = [];
  if (visitsFailed || !Array.isArray(zone.visits)) notes.push(VISITS_NOTE);
  if (query.to >= input.today) notes.push("Today's numbers are still coming in.");
  const rows = [...byDay.values()].filter((r) => (r.day as string) >= query.from && (r.day as string) <= query.to).sort((a, b) => String(a.day).localeCompare(String(b.day)));
  return { ok: true, rows: rows.slice(0, limit), notes };
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
