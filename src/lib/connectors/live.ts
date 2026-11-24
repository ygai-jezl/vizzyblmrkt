import { z } from "zod";
import { meaningsOf, type Meaning, type MeaningKey } from "@/lib/metrics/meanings";
import { LIVE_BY, LIVE_LIMITS, streamOf, type ConnectorManifest, type LiveBy } from "./manifest";
import { LIVE_HOOKS } from "./handlers";
import type { HookFailure, HookInput, LiveQuery, LiveRow } from "./handlers/types";
import type { ConnectorFetchDeps } from "./safeFetch";
import { cleanPagePath } from "./paths";
import { lagWords } from "./lag";
import { daysIn, isDay, LIVE_PERIODS, periodAnswer, PERIOD_DAYS, todayIn, type PeriodAnswer } from "./period";

/**
 * A live read of a connection's numbers, bounded (Connectors 1 plan, live reads):
 * - at most 93 days and 100 rows, whatever is asked;
 * - a 512 KB body at most (the manifest's cap, enforced in safe fetch);
 * - grouped only by a dimension from the fixed list the stream allows, and filtered only by one
 *   page path where the stream allows it;
 * - page paths without query strings or fragments (cleanPagePath);
 * - every number comes back with its meaning, and a number with no meaning is dropped.
 *
 * The days match the provider's own report (Connectors 1 follow-ups): a named `period` is
 * resolved by the connector's hook, in the provider's time zone and ending on its last complete
 * day; explicit days are capped there with a dated note. Every answer says which days it read.
 *
 * Who may read is decided before this (src/lib/connectors/grants.ts); this only reads.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A page path to filter on: a path, no query string, fragment, spaces or control characters. */
export const PagePathSchema = z
  .string()
  .max(512)
  .regex(/^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/, "a page path such as /pricing");

export const LiveRequestSchema = z
  .object({
    stream: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
    period: z.enum(LIVE_PERIODS).optional(),
    from: z.string().regex(DATE).optional(),
    to: z.string().regex(DATE).optional(),
    by: z.enum(LIVE_BY).default("day"),
    limit: z.coerce.number().int().min(1).max(LIVE_LIMITS.maxRows).default(LIVE_LIMITS.maxRows),
    page: PagePathSchema.optional(),
  })
  .strict();
export type LiveRequest = z.input<typeof LiveRequestSchema>;

export type LiveRequestError = "invalid_input" | "unknown_stream" | "bad_dates" | "too_many_days" | "by_not_allowed" | "page_not_allowed";

/** Check a request against the manifest and the hard caps. A period, or both from and to: never both. */
export function checkLiveRequest(manifest: ConnectorManifest, raw: unknown, now: Date): { ok: true; query: LiveQuery } | { ok: false; error: LiveRequestError } {
  const parsed = LiveRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  const q = parsed.data;
  const dated = q.from !== undefined || q.to !== undefined;
  if (q.period ? dated : q.from === undefined || q.to === undefined) return { ok: false, error: "invalid_input" };
  const stream = streamOf(manifest, q.stream);
  if (!stream) return { ok: false, error: "unknown_stream" };
  if (!stream.liveBy.includes(q.by)) return { ok: false, error: "by_not_allowed" };
  if (q.page !== undefined && !(stream.liveFilters ?? []).includes("page")) return { ok: false, error: "page_not_allowed" };
  const base = { stream: q.stream, by: q.by, limit: q.limit, ...(q.page !== undefined ? { page: q.page } : {}) };
  if (q.period) {
    if (PERIOD_DAYS[q.period] > LIVE_LIMITS.maxDays) return { ok: false, error: "too_many_days" };
    return { ok: true, query: { ...base, period: q.period } };
  }
  const from = q.from!;
  const to = q.to!;
  // Today in the provider's zone where it is fixed; UTC otherwise (a later day is never complete anywhere).
  const today = todayIn(now, stream.timeZone ?? "UTC");
  if (!isDay(from) || !isDay(to) || from > to || to > today) return { ok: false, error: "bad_dates" };
  if (daysIn(from, to) > LIVE_LIMITS.maxDays) return { ok: false, error: "too_many_days" };
  return { ok: true, query: { ...base, from, to } };
}

export { cleanPagePath };

export { lagWords };

export interface LiveAnswer {
  connectorId: string;
  /** The connector's name, for a source line under an answer. */
  connector: string;
  stream: string;
  by: LiveBy;
  /** The days read, in the provider's time zone, with the words to say them. */
  period: PeriodAnswer;
  rows: LiveRow[];
  /** The provider's own totals for the period, by measure, where it gives them; null otherwise. */
  totals: Partial<Record<MeaningKey, number | null>> | null;
  /** True when the provider has rows this answer leaves out. */
  more: boolean;
  /** The meaning of every number in rows and totals. */
  meanings: Partial<Record<MeaningKey, Meaning>>;
  /** Each said once. */
  notes: string[];
  asOf: string;
}

const numberOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Numbers about how YouGrow read the provider's rows rather than the provider's own (merged: how
 * many of its addresses a row adds up). Kept on any stream's rows and explained by their meaning,
 * but never a measure a manifest lists, collects or shows on its Listing.
 */
export const READ_COUNTS: readonly MeaningKey[] = ["merged"];

/**
 * Read live through the connector's hook. Rows keep only the stream's keys and measures, page
 * values are cleaned, and at most `limit` rows come back: the latest days for a read by day, the
 * first rows (the hook's most important) otherwise.
 */
export async function readLive(
  input: HookInput & { query: LiveQuery },
  deps: ConnectorFetchDeps = {},
): Promise<{ ok: true; answer: LiveAnswer } | HookFailure> {
  const { manifest, query } = input;
  const stream = streamOf(manifest, query.stream);
  const hook = LIVE_HOOKS[manifest.hooks.live];
  if (!stream || !hook) return { ok: false, code: "query_refused", retryAfterSec: null };
  const now = deps.now ?? new Date();
  const r = await hook({ ...input, today: todayIn(now, stream.timeZone ?? "UTC") }, deps);
  if (!r.ok) return r;

  const measures = new Set<string>(stream.measures);
  const counts = new Set<string>(READ_COUNTS);
  const keys = new Set<string>(stream.keys);
  const pageKeys = new Set(Object.entries(stream.joins).filter(([, shared]) => shared === "page").map(([k]) => k));
  const limit = Math.min(query.limit, LIVE_LIMITS.maxRows);
  const cut = r.rows.length > limit;
  const kept = cut ? (query.by === "day" ? r.rows.slice(-limit) : r.rows.slice(0, limit)) : r.rows;
  const present = new Set<string>();
  const rows = kept.map((row) => {
    const out: LiveRow = {};
    for (const [k, v] of Object.entries(row)) {
      if (measures.has(k) || counts.has(k)) {
        out[k] = numberOrNull(v);
        present.add(k);
      } else if (keys.has(k)) out[k] = typeof v === "string" ? (pageKeys.has(k) ? cleanPagePath(v) : v) : null;
    }
    return out;
  });
  let totals: Partial<Record<MeaningKey, number | null>> | null = null;
  if (r.totals) {
    totals = {};
    for (const [k, v] of Object.entries(r.totals)) {
      if (!measures.has(k)) continue;
      totals[k as MeaningKey] = numberOrNull(v);
      present.add(k);
    }
  }
  return {
    ok: true,
    answer: {
      connectorId: manifest.id,
      connector: manifest.name,
      stream: stream.stream,
      by: query.by,
      period: periodAnswer(r.period),
      rows,
      totals,
      more: cut || r.more === true,
      meanings: meaningsOf([...stream.measures, ...READ_COUNTS].filter((k) => present.has(k))),
      notes: [...new Set(r.notes)],
      asOf: now.toISOString(),
    },
  };
}
