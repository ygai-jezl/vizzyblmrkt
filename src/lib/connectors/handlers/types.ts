import type { DataConnection } from "@/lib/types/dataConnection";
import type { ConnectorManifest, LiveBy } from "../manifest";
import type { ConnectorErrorCode } from "../messages";
import type { LivePeriod, ReadPeriod } from "../period";
import type { ConnectorFetchDeps } from "../safeFetch";

/**
 * What a connector's code (its hooks) receives and returns. Hooks call providers only through
 * connectorFetch (src/lib/connectors/safeFetch.ts) and return codes, never a provider's words.
 */

export interface HookInput {
  manifest: ConnectorManifest;
  connection: Pick<DataConnection, "id" | "tenantId" | "pausedAt" | "health">;
  /** The non secret account (a zone id, a site), or "" when a signed in connection has none picked yet. */
  account: string;
  /** The opened secret, used only for the call. */
  token: string;
}

export type HookFailure = { ok: false; code: ConnectorErrorCode; retryAfterSec: number | null };

export type VerifyResult = { ok: true } | HookFailure;

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
