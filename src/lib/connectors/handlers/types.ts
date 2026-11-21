import type { DataConnection } from "@/lib/types/dataConnection";
import type { ConnectorManifest, LiveBy } from "../manifest";
import type { ConnectorErrorCode } from "../messages";
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

/** One live read, already checked against the manifest and the hard caps. */
export interface LiveQuery {
  stream: string;
  /** Inclusive dates, YYYY-MM-DD, in UTC. */
  from: string;
  to: string;
  by: LiveBy;
  limit: number;
}

export type LiveRow = Record<string, string | number | null>;

export type LiveHookResult = { ok: true; rows: LiveRow[]; notes: string[] } | HookFailure;

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
export type LiveHook = (input: HookInput & { query: LiveQuery; today: string }, deps: ConnectorFetchDeps) => Promise<LiveHookResult>;
