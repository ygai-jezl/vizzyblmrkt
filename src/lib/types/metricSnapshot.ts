/**
 * Collected numbers (Connectors 2, ADR-0012): one connected source's numbers for one day, or for
 * the 28 or 90 days to its last collected day, in the brand's regional `metric_snapshots`, written
 * only through src/lib/connectors/snapshots.ts and read by id.
 *
 * - Day docs: `${connectionId}_${gen}_${stream}_${by}_${day}`, the provider's own day in its own
 *   time zone (Search Console: Pacific time; Google Analytics: the property's zone; Cloudflare: UTC).
 * - Rolled docs: `..._${by}_r28` and `_r90`, rewritten once a day from the day docs, so no hot path
 *   adds up 90 day docs.
 * - Planning docs (Search Console): `..._searchConsole_question_r28`, a ready line per brand map
 *   question whose words people searched.
 *
 * `gen` is the connection's collect generation, bumped by Change property, so an old site's numbers
 * never share an id with the new site's. Every number is keyed by its meaning
 * (src/lib/metrics/meanings.ts). `ttlAt` is written as a Date, the day plus the stream's keepDays,
 * for the time to live `infra/lifecycle/setup.sh ttl` turns on; Firestore hands it back as a
 * Timestamp, so it is never read. Readers read by day, as expired docs stay until Firestore deletes
 * them (oldestAlive in src/lib/connectors/snapshots.ts says which can still be there).
 */

/** The groupings a day is kept by: the live read's own (src/lib/connectors/manifest.ts LIVE_BY). */
export const SNAPSHOT_BY = ["day", "page", "topic", "landing"] as const;
export type SnapshotBy = (typeof SNAPSHOT_BY)[number];

/** The planning docs' groupings (Search Console only). */
export const PLANNING_BY = ["question", "subject"] as const;
export type PlanningBy = (typeof PLANNING_BY)[number];

/** The rolled spans, each ending on the last collected day. */
export const ROLLED_SPANS = { r28: 28, r90: 90 } as const;
export type RolledSpan = keyof typeof ROLLED_SPANS;

/**
 * Why a day's numbers may not be the provider's whole story, as codes the readers put in words:
 * - other_row: Google Analytics rolled rarely visited rows into "(other)", left out here;
 * - sampled: Google Analytics worked the numbers out from a sample;
 * - thresholded: Google Analytics held back small numbers to protect visitors' privacy;
 * - app_screens: a Google Analytics property that also counts app screens, left out of the rows.
 */
export const SNAPSHOT_NOTES = ["other_row", "sampled", "thresholded", "app_screens"] as const;
export type SnapshotNote = (typeof SNAPSHOT_NOTES)[number];

/**
 * Cloudflare's numbers for a day: end users (its adaptive dataset, filtered to eyeball traffic, as
 * its Traffic tab shows) where that reaches, else all traffic (its daily totals, bots included).
 */
export type SnapshotBasis = "end_users" | "all_traffic" | "mixed";

/**
 * One kept row: its key (a page path, a search's words, a day, or a question id on a planning doc),
 * the host it was seen on (Search Console keeps hosts apart), and its numbers by meaning key.
 * - cutDays (rolled docs): the days it was missing while that day's rows were cut, so it may have
 *   been there below the floor;
 * - label and subjectId (planning docs): the search's words, and the question's subject.
 */
export interface SnapshotRow {
  key: string;
  host?: string;
  m: Record<string, number>;
  cutDays?: number;
  label?: string;
  subjectId?: string;
}

export interface MetricSnapshot {
  id: string;
  tenantId: string;
  connectionId: string;
  gen: number;
  /** What was read: the site, the property or the zone. */
  account: string;
  connectorId: string;
  stream: string;
  by: SnapshotBy | PlanningBy;
  /** A day doc's day, YYYY-MM-DD in the provider's zone; null on rolled and planning docs. */
  day: string | null;
  /** A rolled or planning doc's days, inclusive; null on day docs. */
  window: { from: string; to: string } | null;
  /** How many of the window's days were collected (rolled and planning docs). */
  days: number | null;
  timeZone: string | null;
  /** True when the provider no longer changes these numbers (every day of a rolled doc). */
  final: boolean;
  /** The day's (or window's) totals by meaning key; null where a number can't be given. */
  totals: Record<string, number | null> | null;
  rows: SnapshotRow[];
  /** Rows the provider listed, and how many were not kept (cut, or a key over 500 characters). */
  rowsSeen: number;
  rowsDropped: number;
  /** The provider has more rows than it sent. */
  more: boolean;
  /** The last kept row's numbers, when rows were cut: a missing row is at most this. */
  floor: Record<string, number> | null;
  basis: SnapshotBasis | null;
  notes: SnapshotNote[];
  collectedAt: string;
  /** The time to live: written as a Date, the last day plus the stream's keepDays. Read back it is a Firestore Timestamp, so it is typed unknown: never read it as a date. */
  ttlAt: unknown;
}
