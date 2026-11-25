import { isRateLimited, type RateLimitConfig } from "@/lib/tenant";
import { readBytesUpTo, safeFetch as ssrfSafeFetch } from "@/lib/security/ssrf";
import type { DataConnection } from "@/lib/types/dataConnection";
import type { ConnectorManifest } from "./manifest";
import { isCallPaused } from "./health";
import type { ConnectorErrorCode } from "./messages";

/**
 * The one outbound fetch for connector API calls. Every call a connector makes goes through here:
 *
 * - The URL's host must be one of the manifest's declared hosts, exactly, over https on 443,
 *   before any request is made.
 * - A paused connection is refused before any request.
 * - Rate limits per connection and per brand for this connector (isRateLimited, keyed by a hash),
 *   and for a brand's part of an organisation's connection (Connectors 3) a third, per organisation
 *   connection (`connector-src:<connector>`), from the manifest's limits.source. They fail open, so
 *   the pause on the record is the hard stop.
 * - It calls src/lib/security/ssrf.ts safeFetch with maxRedirects 0 and allowedPorts [443].
 *   That helper follows redirects itself and copies the same init, Authorization included, into
 *   every hop; with 0 any 3xx throws after one request, and any 3xx that comes back anyway is
 *   refused here, so a token is never sent to a second address.
 * - Its own timeout, and the body read up to the manifest's byte cap (512 KB at most).
 * - Logs name the host and the code, never the path, query, body or token.
 */

export interface ConnectorCall {
  manifest: Pick<ConnectorManifest, "id" | "api">;
  /** The connection (or, while connecting, the one about to be saved). A part names its source. */
  connection: Pick<DataConnection, "id" | "tenantId" | "pausedAt" | "health"> & { source?: Pick<NonNullable<DataConnection["source"]>, "organisationId" | "connectionId"> };
  url: string;
  method: "GET" | "POST";
  /** A JSON body, sent as application/json. */
  json?: unknown;
  /** The bearer token, added as the Authorization header here and nowhere else. */
  token: string;
}

export type ConnectorResponse =
  | { ok: true; status: number; body: unknown }
  | { ok: false; code: ConnectorErrorCode; status: number | null; body: unknown; retryAfterSec: number | null };

/** How a request goes out: src/lib/security/ssrf.ts safeFetch, or a stub in tests. */
export type Transport = (url: string, init: RequestInit, opts: { maxRedirects: number; allowedPorts: number[]; timeoutMs: number }) => Promise<Response>;

export interface ConnectorFetchDeps {
  transport?: Transport;
  limit?: (subject: string, config: RateLimitConfig) => Promise<boolean>;
  log?: (line: string) => void;
  now?: Date;
}

/** The URL, if it is https on 443 to one of the declared hosts; else null. */
export function declaredUrl(raw: string, hosts: readonly string[]): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  return hosts.includes(url.hostname) ? url : null;
}

/** A 429's Retry-After in seconds, capped at an hour, or null. */
export function retryAfter(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 3600);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, Math.min(3600, Math.round((at - Date.now()) / 1000)));
}

function codeForStatus(status: number): ConnectorErrorCode {
  if (status === 401 || status === 403) return "token_refused";
  if (status === 404) return "account_refused";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_error";
  return "query_refused";
}

/** The code for a request that threw: a refused address, a redirect, a timeout or the network. */
export function codeForThrow(err: unknown): ConnectorErrorCode {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : "";
  if (message === "too_many_redirects") return "redirect_refused";
  if (["invalid_url", "scheme_not_https", "host_blocked", "port_blocked"].includes(message)) return "host_not_allowed";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return "network";
}

export const defaultTransport: Transport = (url, init, opts) => ssrfSafeFetch(url, init, opts);

/** Make one connector API call. Never throws; a refusal or failure comes back as a code. */
export async function connectorFetch(call: ConnectorCall, deps: ConnectorFetchDeps = {}): Promise<ConnectorResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  const { manifest, connection } = call;
  const fail = (code: ConnectorErrorCode, status: number | null = null, body: unknown = null, retryAfterSec: number | null = null): ConnectorResponse => {
    log(`[connectors] ${manifest.id} ${hostOf(call.url)} ${code}${status ? ` ${status}` : ""}`);
    return { ok: false, code, status, body, retryAfterSec };
  };

  const url = declaredUrl(call.url, manifest.api.hosts);
  if (!url) return fail("host_not_allowed");
  if (isCallPaused(connection, deps.now ?? new Date())) return fail("paused");

  const limit = deps.limit ?? ((subject: string, config: RateLimitConfig) => isRateLimited(subject, config));
  const { connection: perConnection, brand } = manifest.api.limits;
  const overConnection = await limit(`${connection.tenantId}:${connection.id}`, { prefix: `connector-conn:${manifest.id}`, burstLimit: perConnection.perMinute, hourlyLimit: perConnection.perHour });
  if (overConnection) return fail("busy");
  const overBrand = await limit(`${connection.tenantId}`, { prefix: `connector-brand:${manifest.id}`, burstLimit: brand.perMinute, hourlyLimit: brand.perHour });
  if (overBrand) return fail("busy");
  const shared = manifest.api.limits.source;
  if (connection.source && shared) {
    // Every brand's part of one organisation connection draws on one budget, as the provider counts it.
    const overSource = await limit(`${connection.source.organisationId}:${connection.source.connectionId}`, { prefix: `connector-src:${manifest.id}`, burstLimit: shared.perMinute, hourlyLimit: shared.perHour });
    if (overSource) return fail("busy");
  }

  const headers: Record<string, string> = { authorization: `Bearer ${call.token}`, accept: "application/json" };
  if (call.json !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await (deps.transport ?? defaultTransport)(url.toString(), { method: call.method, headers, body: call.json === undefined ? undefined : JSON.stringify(call.json) }, {
      maxRedirects: 0,
      allowedPorts: [443],
      timeoutMs: manifest.api.timeoutMs,
    });
  } catch (err) {
    return fail(codeForThrow(err));
  }

  if (res.status >= 300 && res.status < 400) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return fail("redirect_refused", res.status);
  }

  let body: unknown = null;
  let readCode: ConnectorErrorCode | null = null;
  try {
    const { bytes, truncated } = await readBytesUpTo(res, manifest.api.maxBytes);
    if (truncated) readCode = "body_too_large";
    else body = bytes.length ? JSON.parse(bytes.toString("utf8")) : null;
  } catch (err) {
    readCode = codeForThrow(err) === "timeout" ? "timeout" : "bad_response";
  }

  if (res.status < 200 || res.status >= 300) return fail(codeForStatus(res.status), res.status, readCode ? null : body, res.status === 429 ? retryAfter(res) : null);
  if (readCode) return fail(readCode, res.status);
  if (body === null) return fail("bad_response", res.status);
  return { ok: true, status: res.status, body };
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return "(bad url)";
  }
}
