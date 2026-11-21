import { z } from "zod";
import { meaningsOf, type Meaning, type MeaningKey } from "@/lib/metrics/meanings";
import { LIVE_BY, LIVE_LIMITS, streamOf, type ConnectorManifest, type LiveBy } from "./manifest";
import { LIVE_HOOKS } from "./handlers";
import type { HookFailure, HookInput, LiveQuery, LiveRow } from "./handlers/types";
import type { ConnectorFetchDeps } from "./safeFetch";
import { cleanPagePath } from "./paths";

/**
 * A live read of a connection's numbers, bounded (Connectors 1 plan, live reads):
 * - at most 93 days and 100 rows, whatever is asked;
 * - a 512 KB body at most (the manifest's cap, enforced in safe fetch);
 * - grouped only by a dimension from the fixed list the stream allows;
 * - page paths without query strings or fragments (cleanPagePath);
 * - every number comes back with its meaning, and a number with no meaning is dropped.
 *
 * Who may read is decided before this (src/lib/connectors/grants.ts); this only reads.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export const LiveRequestSchema = z
  .object({
    stream: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
    from: z.string().regex(DATE),
    to: z.string().regex(DATE),
    by: z.enum(LIVE_BY).default("day"),
    limit: z.coerce.number().int().min(1).max(LIVE_LIMITS.maxRows).default(LIVE_LIMITS.maxRows),
  })
  .strict();
export type LiveRequest = z.input<typeof LiveRequestSchema>;

export type LiveRequestError = "invalid_input" | "unknown_stream" | "bad_dates" | "too_many_days" | "by_not_allowed";

function dayMs(day: string): number {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return new Date(ms).toISOString().slice(0, 10) === day ? ms : Number.NaN;
}

/** Check a request against the manifest and the hard caps. */
export function checkLiveRequest(manifest: ConnectorManifest, raw: unknown, now: Date): { ok: true; query: LiveQuery } | { ok: false; error: LiveRequestError } {
  const parsed = LiveRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  const q = parsed.data;
  const stream = streamOf(manifest, q.stream);
  if (!stream) return { ok: false, error: "unknown_stream" };
  if (!stream.liveBy.includes(q.by)) return { ok: false, error: "by_not_allowed" };
  const from = dayMs(q.from);
  const to = dayMs(q.to);
  const today = dayMs(now.toISOString().slice(0, 10));
  if (Number.isNaN(from) || Number.isNaN(to) || from > to || to > today) return { ok: false, error: "bad_dates" };
  if ((to - from) / DAY_MS + 1 > LIVE_LIMITS.maxDays) return { ok: false, error: "too_many_days" };
  return { ok: true, query: { stream: q.stream, from: q.from, to: q.to, by: q.by, limit: q.limit } };
}

export { cleanPagePath };

/** The days a stream's numbers take to settle, in words. */
export function lagWords(lagDays: number): string {
  if (lagDays <= 0) return "Numbers arrive within minutes.";
  if (lagDays === 1) return "A day's numbers are complete the next day.";
  return `A day's numbers are complete about ${lagDays} days later.`;
}

export interface LiveAnswer {
  connectorId: string;
  stream: string;
  from: string;
  to: string;
  by: LiveBy;
  rows: LiveRow[];
  /** The meaning of every number in rows. */
  meanings: Partial<Record<MeaningKey, Meaning>>;
  lag: { days: number; words: string };
  notes: string[];
  asOf: string;
}

/**
 * Read live through the connector's hook. Rows keep only the stream's keys and measures, page
 * values are cleaned, and at most `limit` rows come back.
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
  const r = await hook({ ...input, today: now.toISOString().slice(0, 10) }, deps);
  if (!r.ok) return r;

  const measures = new Set<string>(stream.measures);
  const keys = new Set<string>(stream.keys);
  const pageKeys = new Set(Object.entries(stream.joins).filter(([, shared]) => shared === "page").map(([k]) => k));
  const rows = r.rows.slice(0, Math.min(query.limit, LIVE_LIMITS.maxRows)).map((row) => {
    const out: LiveRow = {};
    for (const [k, v] of Object.entries(row)) {
      if (measures.has(k)) out[k] = typeof v === "number" && Number.isFinite(v) ? v : null;
      else if (keys.has(k)) out[k] = typeof v === "string" ? (pageKeys.has(k) ? cleanPagePath(v) : v) : null;
    }
    return out;
  });
  return {
    ok: true,
    answer: {
      connectorId: manifest.id,
      stream: stream.stream,
      from: query.from,
      to: query.to,
      by: query.by,
      rows,
      meanings: meaningsOf(stream.measures),
      lag: { days: stream.lagDays, words: lagWords(stream.lagDays) },
      notes: r.notes,
      asOf: now.toISOString(),
    },
  };
}
