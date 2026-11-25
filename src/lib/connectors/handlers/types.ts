import type { DataConnection } from "@/lib/types/dataConnection";
import type { SnapshotBasis, SnapshotBy, SnapshotNote, SnapshotRow } from "@/lib/types/metricSnapshot";
import type { CollectCursor } from "../collect/schedule";
import type { ConnectorManifest, LiveBy, ProducedStream } from "../manifest";
import type { ConnectorErrorCode } from "../messages";
import type { LivePeriod, ReadPeriod } from "../period";
import type { ConnectorFetchDeps } from "../safeFetch";

/**
 * What a connector's code (its hooks) receives and returns. Hooks call providers only through
 * connectorFetch (src/lib/connectors/safeFetch.ts) and return codes, never a provider's words.
 */

export interface HookInput {
  manifest: ConnectorManifest;
  /** A brand's part names its source, so safe fetch counts it in its organisation connection's budget. */
  connection: Pick<DataConnection, "id" | "tenantId" | "pausedAt" | "health" | "source">;
  /** The non secret account (a zone id, a site), or "" when a signed in connection has none picked yet. */
  account: string;
  /** The opened secret, used only for the call. */
  token: string;
}

export type HookFailure = { ok: false; code: ConnectorErrorCode; retryAfterSec: number | null };

/**
 * A verify hook's answer. An MCP connector's verify tool also names the account the key reads (and
 * its name, where it has one), since a pasted key has no account field (ADR-0019).
 */
export type VerifyResult = { ok: true; account?: string; label?: string } | HookFailure;

/**
 * One live read, already checked against the manifest and the hard caps. It asks for either a
 * named period, which the hook resolves the way the provider's own report does, or explicit days.
 */
export interface LiveQuery {
  stream: string;
  /** A named period, set instead of from and to. */
  period?: LivePeriod;
  /** Inclusive days, YYYY-MM-DD, in the stream's time zone (the provider's); set instead of period. */
  from?: string;
  to?: string;
  by: LiveBy;
  limit: number;
  /**
   * One page path, where the stream allows it. Google Analytics matches it exactly. Search Console
   * matches the path on any of the site's hosts with any query string, and keeps each host a row
   * of its own (query string variants of one host are added together with a `merged` count).
   */
  page?: string;
  /**
   * Read only the provider's final numbers (Search Console's dataState final), ending where they
   * usually are final. For collecting days that won't change (Connectors 2); never from a request.
   */
  settledOnly?: boolean;
}

export type LiveRow = Record<string, string | number | null>;

/**
 * A hook's answer:
 * - rows: the provider's rows, sorted (days oldest first; anything else most important first);
 * - notes: plain words, each dated where it is about days;
 * - period: the days actually read, in the provider's time zone;
 * - totals: the provider's own totals for the period, by measure, where it gives them;
 * - more: the provider has rows this answer leaves out.
 */
export type LiveHookResult =
  | { ok: true; rows: LiveRow[]; notes: string[]; period: ReadPeriod; totals?: Record<string, number | null>; more?: boolean }
  | HookFailure;

/** One thing a signed in connection can read, for the picker: a site, a property. */
export interface ConnectorAccount {
  /** What is stored as the connection's account once picked (a site URL, a property id). */
  id: string;
  /** How people read it. */
  label: string;
  /** A short note beside it, such as the access the Google account has, or null. */
  detail: string | null;
}

/** more: the provider listed more than the picker shows. */
export type AccountsResult = { ok: true; accounts: ConnectorAccount[]; more: boolean } | HookFailure;

export type VerifyHook = (input: HookInput, deps: ConnectorFetchDeps) => Promise<VerifyResult>;
export type AccountsHook = (input: HookInput, deps: ConnectorFetchDeps) => Promise<AccountsResult>;
/** `today` is the day it is now in the stream's time zone (UTC for a stream without one). */
export type LiveHook = (input: HookInput & { query: LiveQuery; today: string }, deps: ConnectorFetchDeps) => Promise<LiveHookResult>;

// --- Collecting (Connectors 2, ADR-0012) ----------------------------------------------------------

/** One grouping of one collected day: its totals (the day doc only), its rows and what was cut. */
export interface CollectedDoc {
  by: SnapshotBy;
  totals: Record<string, number | null> | null;
  rows: SnapshotRow[];
  /** The provider had more rows than it sent. */
  more: boolean;
  basis?: SnapshotBasis | null;
  notes?: SnapshotNote[];
}

/** One day a collect hook read: final when the provider no longer changes it. */
export interface CollectedDay {
  day: string;
  final: boolean;
  docs: CollectedDoc[];
}

/** Why the collector holds itself back, in its own state (never the connection's health). */
export type CollectHoldReason = "quota" | "quota_day" | "tokens_low" | "server_errors" | "failed_today" | "no_data" | "too_big";

/** What a collect run asks of a hook. */
export interface CollectAsk {
  /** The stream collected, with its collect block. */
  stream: ProducedStream & { collect: NonNullable<ProducedStream["collect"]> };
  cursor: CollectCursor;
  now: Date;
  /** False once too little of the lane's time is left to start another day or call. */
  canStart: () => boolean;
}

/**
 * A collect hook's answer: the days it read (in the order read), the newest day the provider has
 * (Search Console's final frontier; null when it didn't say), the oldest it can give (a Cloudflare
 * plan's reach), the provider's zone, whether it probed, a hold it asks for, and the failure that
 * stopped it, if any. Days read before a failure are kept. `moreDue` says days are still due now
 * (the backfill, or a slice cut short); `nextDueMs`, when the next new day is due.
 */
export interface CollectResult {
  days: CollectedDay[];
  newest: string | null;
  moreDue: boolean;
  nextDueMs: number | null;
  reachFrom: string | null;
  timeZone: string | null;
  probed: boolean;
  hold: { untilMs: number; reason: CollectHoldReason } | null;
  failure: HookFailure | null;
}

export type CollectHook = (input: HookInput & { ask: CollectAsk }, deps: ConnectorFetchDeps) => Promise<CollectResult>;
