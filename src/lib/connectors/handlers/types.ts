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
  /** The non secret account (a zone id). */
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

export type VerifyHook = (input: HookInput, deps: ConnectorFetchDeps) => Promise<VerifyResult>;
export type LiveHook = (input: HookInput & { query: LiveQuery; today: string }, deps: ConnectorFetchDeps) => Promise<LiveHookResult>;
