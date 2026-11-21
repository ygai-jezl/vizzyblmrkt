import { createHash, randomBytes } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { readBytesUpTo } from "@/lib/security/ssrf";
import type { ConnectorErrorCode } from "./messages";
import { codeForThrow, defaultTransport, retryAfter, type Transport } from "./safeFetch";

/**
 * Share access (Connectors 1c, ADR-0011): connect Google data without signing in, by sharing the
 * property with a Google address made for that one connection. Grounded in Google's IAM docs (read
 * through the Developer Knowledge MCP): "Create service accounts", projects.serviceAccounts create,
 * delete and list, and "Create short-lived credentials" (iamcredentials generateAccessToken).
 *
 * - Each connection gets its own service account in the identities project,
 *   CONNECTORS_IDENTITIES_PROJECT, a Google Cloud project used only for this. Unset, share access
 *   is hidden, which is how a self-hosted copy without one behaves; Sign in with Google still works.
 * - The account id is `ygc-` and 20 random characters: 24 characters, inside Google's rule of 6 to
 *   30 matching [a-z]([-a-z0-9]*[a-z0-9]). It never holds the brand or the connection, because the
 *   brand's admin pastes the address into their property. The description names the connection and
 *   a hash of the brand, so the operator purge can find a brand's leftover accounts.
 * - Calls are the app's own, to fixed Google hosts (iam.googleapis.com and
 *   iamcredentials.googleapis.com), with the app's own token from google-auth-library. The app's
 *   runtime account holds three roles on the identities project only: Create Service Accounts,
 *   Delete Service Accounts and a custom role with iam.serviceAccounts.getAccessToken.
 * - Tokens are minted for 300 seconds with only the connector's one read scope, kept in this
 *   server's memory until a minute before they run out, and never sealed or stored.
 * - A new account can take a minute or more to work (IAM reads are eventually consistent), so
 *   minting a token for a young account retries with backoff.
 * - Deleted accounts don't count towards the project's service account quota; a full project says
 *   so plainly (share_quota) so the screen can offer Sign in with Google.
 *
 * Every call goes through src/lib/security/ssrf.ts safeFetch with no redirects, on 443, with a
 * timeout and a capped body. Logs name the host and a code, never a token. Nothing here throws.
 */

export const IAM_ORIGIN = "https://iam.googleapis.com";
export const IAM_CREDENTIALS_ORIGIN = "https://iamcredentials.googleapis.com";
const HOSTS = new Set(["iam.googleapis.com", "iamcredentials.googleapis.com"]);
const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";
/** How long a minted token lasts. */
export const SHARE_TOKEN_LIFETIME_SEC = 300;
/** A cached token is handed out only while more than this is left. */
const TOKEN_MARGIN_MS = 60_000;
const TOKEN_CACHE_MAX = 500;
/** Minting retries for an account younger than this, while IAM catches up with its creation. */
export const YOUNG_ACCOUNT_MS = 10 * 60_000;
/** The waits between minting attempts for a young account: about 7 seconds in all. */
export const MINT_BACKOFF_MS = [1_000, 2_000, 4_000] as const;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024;
/** Accounts read per page when listing (Google's maximum), and the most pages one purge reads. */
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 50;
export const SHARE_ACCOUNT_PREFIX = "ygc-";
const ACCOUNT_ID_RE = /^ygc-[a-z2-7]{20}$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** A Google Cloud project id: 6 to 30 lower case letters, digits and hyphens, starting with a letter. */
const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const UNIQUE_ID_RE = /^\d{1,30}$/;
const CONNECTION_RE = /^dcn_[a-z2-7]{20}$/;
const DESCRIPTION_RE = /\bconnection=(dcn_[a-z2-7]{20}) brand=([0-9a-f]{16})\b/;

export interface ShareDeps {
  transport?: Transport;
  /** The app's own access token (google-auth-library), or null when it has none. Tests pass a stub. */
  appToken?: () => Promise<string | null>;
  log?: (line: string) => void;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
}

/** The identities project, or null when CONNECTORS_IDENTITIES_PROJECT is unset or not a project id. */
export function identitiesProject(): string | null {
  const p = (process.env.CONNECTORS_IDENTITIES_PROJECT ?? "").trim();
  return PROJECT_RE.test(p) ? p : null;
}

/** Whether this copy can offer share access: it has an identities project. */
export function isShareAccessConfigured(): boolean {
  return identitiesProject() !== null;
}

/** A new account id: `ygc-` and 20 random base32 characters, never the brand or the connection. */
export function newShareAccountId(): string {
  const bytes = randomBytes(20);
  let out = SHARE_ACCOUNT_PREFIX;
  for (let i = 0; i < 20; i++) out += BASE32[bytes[i]! & 31];
  return out;
}

/** A short, one way tag for a brand, so the purge can tell its accounts from another brand's. */
export function brandTag(tenantId: string): string {
  return createHash("sha256").update(`yougrow-connector-brand:${tenantId}`).digest("hex").slice(0, 16);
}

/** The description an account carries: the connection and the brand's tag, no names. */
export function shareDescription(tenantId: string, connectionId: string): string {
  return `YouGrow connected data. connection=${connectionId} brand=${brandTag(tenantId)}`;
}

/** The connection and brand tag an account's description names, or null for one YouGrow didn't make. */
export function parseShareDescription(description: unknown): { connectionId: string; brand: string } | null {
  if (typeof description !== "string") return null;
  const m = DESCRIPTION_RE.exec(description);
  return m ? { connectionId: m[1]!, brand: m[2]! } : null;
}

let _auth: GoogleAuth | null = null;
async function defaultAppToken(): Promise<string | null> {
  if (!_auth) _auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM] });
  try {
    return (await _auth.getAccessToken()) ?? null;
  } catch {
    return null;
  }
}

type Called = { ok: true; status: number; body: unknown; retryAfterSec: number | null } | { ok: false; code: ConnectorErrorCode };

/** One call to IAM or IAM Credentials with the app's own token. Never throws. */
async function iamCall(method: "GET" | "POST" | "DELETE", url: string, body: unknown, deps: ShareDeps): Promise<Called> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, code: "host_not_allowed" };
  }
  if (!HOSTS.has(host) || !url.startsWith("https://")) {
    log(`[connectors] share ${host} host_not_allowed`);
    return { ok: false, code: "host_not_allowed" };
  }
  const token = await (deps.appToken ?? defaultAppToken)();
  if (!token) {
    log(`[connectors] share ${host} share_unconfigured no_app_token`);
    return { ok: false, code: "share_unconfigured" };
  }
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await (deps.transport ?? defaultTransport)(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, { maxRedirects: 0, allowedPorts: [443], timeoutMs: TIMEOUT_MS });
  } catch (err) {
    const code = codeForThrow(err);
    log(`[connectors] share ${host} ${code}`);
    return { ok: false, code };
  }
  if (res.status >= 300 && res.status < 400) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    log(`[connectors] share ${host} redirect_refused ${res.status}`);
    return { ok: false, code: "redirect_refused" };
  }
  let parsed: unknown = null;
  try {
    const { bytes, truncated } = await readBytesUpTo(res, MAX_BYTES);
    parsed = truncated || !bytes.length ? null : JSON.parse(bytes.toString("utf8"));
  } catch {
    parsed = null;
  }
  return { ok: true, status: res.status, body: parsed, retryAfterSec: res.status === 429 ? retryAfter(res) : null };
}

interface GoogleError {
  status: string;
  message: string;
  reasons: string[];
}

function googleError(body: unknown): GoogleError {
  const e = (body as { error?: unknown } | null)?.error;
  if (!e || typeof e !== "object") return { status: "", message: "", reasons: [] };
  const err = e as { status?: unknown; message?: unknown; details?: unknown; errors?: unknown };
  const reasons: string[] = [];
  for (const list of [err.details, err.errors]) {
    if (Array.isArray(list)) for (const d of list) if (d && typeof (d as { reason?: unknown }).reason === "string") reasons.push((d as { reason: string }).reason);
  }
  return { status: typeof err.status === "string" ? err.status : "", message: typeof err.message === "string" ? err.message : "", reasons };
}

/**
 * The code for a refused IAM call. A full project (Google's "Maximum number of service accounts on
 * project reached") is share_quota; an API not turned on, a missing permission or a missing project
 * is this copy's setup; a rate limit is rate_limited; 5xx is the provider.
 */
export function iamFailureCode(status: number, body: unknown): ConnectorErrorCode {
  const e = googleError(body);
  if (/maximum number of service accounts|service account (count|quota)/i.test(e.message)) return "share_quota";
  if (e.reasons.includes("SERVICE_DISABLED") || e.reasons.includes("accessNotConfigured")) return "share_unconfigured";
  if (status === 429 || e.status === "RESOURCE_EXHAUSTED") return "rate_limited";
  if (status === 401 || status === 403 || status === 404) return "share_unconfigured";
  if (status >= 500) return "provider_error";
  return "bad_response";
}

export interface ShareAccount {
  email: string;
  uniqueId: string;
}

export type ShareResult<T> = ({ ok: true } & T) | { ok: false; code: ConnectorErrorCode; retryAfterSec: number | null };

function accountFrom(body: unknown, project: string): ShareAccount | null {
  const b = body as { email?: unknown; uniqueId?: unknown } | null;
  if (!b || typeof b.email !== "string" || typeof b.uniqueId !== "string") return null;
  if (!b.email.endsWith(`@${project}.iam.gserviceaccount.com`) || !ACCOUNT_ID_RE.test(b.email.split("@")[0]!) || !UNIQUE_ID_RE.test(b.uniqueId)) return null;
  return { email: b.email, uniqueId: b.uniqueId };
}

/**
 * Make the Google address for one connection: POST .../projects/{project}/serviceAccounts. A
 * clash on the random id (Google's 409) tries a new one, twice at most.
 */
export async function createShareAccount(project: string, tenantId: string, connectionId: string, deps: ShareDeps = {}): Promise<ShareResult<{ account: ShareAccount }>> {
  if (!PROJECT_RE.test(project) || !CONNECTION_RE.test(connectionId)) return { ok: false, code: "share_unconfigured", retryAfterSec: null };
  const log = deps.log ?? ((line: string) => console.warn(line));
  for (let attempt = 0; attempt < 3; attempt++) {
    const accountId = newShareAccountId();
    const r = await iamCall(
      "POST",
      `${IAM_ORIGIN}/v1/projects/${project}/serviceAccounts`,
      { accountId, serviceAccount: { displayName: "YouGrow connection", description: shareDescription(tenantId, connectionId) } },
      deps,
    );
    if (!r.ok) return { ok: false, code: r.code, retryAfterSec: null };
    if (r.status === 409) continue;
    if (r.status < 200 || r.status >= 300) {
      const code = iamFailureCode(r.status, r.body);
      log(`[connectors] share iam.googleapis.com create ${code} ${r.status}`);
      return { ok: false, code, retryAfterSec: r.retryAfterSec };
    }
    const account = accountFrom(r.body, project);
    return account ? { ok: true, account } : { ok: false, code: "bad_response", retryAfterSec: null };
  }
  return { ok: false, code: "provider_error", retryAfterSec: null };
}

/**
 * Delete a connection's address by its unique id (stable even if a new account later takes the
 * same name): DELETE .../projects/{project}/serviceAccounts/{uniqueId}. Already gone counts as done.
 */
export async function deleteShareAccount(project: string, uniqueId: string, deps: ShareDeps = {}): Promise<ShareResult<{ gone: boolean }>> {
  if (!PROJECT_RE.test(project) || !UNIQUE_ID_RE.test(uniqueId)) return { ok: false, code: "share_unconfigured", retryAfterSec: null };
  const r = await iamCall("DELETE", `${IAM_ORIGIN}/v1/projects/${project}/serviceAccounts/${uniqueId}`, undefined, deps);
  if (!r.ok) return { ok: false, code: r.code, retryAfterSec: null };
  if (r.status === 404) return { ok: true, gone: true };
  if (r.status >= 200 && r.status < 300) return { ok: true, gone: false };
  const code = iamFailureCode(r.status, r.body);
  (deps.log ?? ((line: string) => console.warn(line)))(`[connectors] share iam.googleapis.com delete ${code} ${r.status}`);
  return { ok: false, code, retryAfterSec: r.retryAfterSec };
}

export interface ListedShareAccount extends ShareAccount {
  /** The connection and brand tag its description names, or null. */
  owner: { connectionId: string; brand: string } | null;
}

/**
 * Every address YouGrow made in the identities project (ids starting `ygc-`), page by page, for
 * the purge. complete is false when it stopped at the page cap.
 */
export async function listShareAccounts(project: string, deps: ShareDeps = {}): Promise<ShareResult<{ accounts: ListedShareAccount[]; complete: boolean }>> {
  if (!PROJECT_RE.test(project)) return { ok: false, code: "share_unconfigured", retryAfterSec: null };
  const accounts: ListedShareAccount[] = [];
  let pageToken = "";
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const q = new URLSearchParams({ pageSize: String(LIST_PAGE_SIZE) });
    if (pageToken) q.set("pageToken", pageToken);
    const r = await iamCall("GET", `${IAM_ORIGIN}/v1/projects/${project}/serviceAccounts?${q.toString()}`, undefined, deps);
    if (!r.ok) return { ok: false, code: r.code, retryAfterSec: null };
    if (r.status < 200 || r.status >= 300) return { ok: false, code: iamFailureCode(r.status, r.body), retryAfterSec: r.retryAfterSec };
    const b = r.body as { accounts?: unknown; nextPageToken?: unknown } | null;
    if (!b || typeof b !== "object") return { ok: false, code: "bad_response", retryAfterSec: null };
    for (const a of Array.isArray(b.accounts) ? b.accounts : []) {
      const account = accountFrom(a, project);
      if (account) accounts.push({ ...account, owner: parseShareDescription((a as { description?: unknown }).description) });
    }
    pageToken = typeof b.nextPageToken === "string" ? b.nextPageToken : "";
    if (!pageToken) return { ok: true, accounts, complete: true };
  }
  return { ok: true, accounts, complete: false };
}

// --- Short lived tokens ------------------------------------------------------------------------

const tokens = new Map<string, { token: string; expiresAtMs: number }>();

/** Forget an address's tokens (on disconnect), so nothing minted for it is handed out again. */
export function forgetShareTokens(email: string): void {
  for (const key of [...tokens.keys()]) if (key.startsWith(`${email}|`)) tokens.delete(key);
}

/** For tests. */
export function __resetShareTokens(): void {
  tokens.clear();
}

function remember(key: string, token: string, expiresAtMs: number): void {
  if (tokens.size >= TOKEN_CACHE_MAX) {
    const oldest = tokens.keys().next().value;
    if (oldest !== undefined) tokens.delete(oldest);
  }
  tokens.set(key, { token, expiresAtMs });
}

/**
 * A token for a connection's address with its one read scope, lasting 300 seconds: from this
 * server's memory while more than a minute is left, else minted through generateAccessToken
 * (`projects/-/serviceAccounts/{email}`, the wildcard Google requires). A young account that IAM
 * can't see yet is retried with backoff, then reported as share_pending.
 */
export async function shareAccessToken(
  sa: { email: string; createdAt: string },
  scope: string,
  deps: ShareDeps = {},
): Promise<ShareResult<{ token: string }>> {
  const now = deps.now ?? new Date();
  const key = `${sa.email}|${scope}`;
  const kept = tokens.get(key);
  if (kept && kept.expiresAtMs - now.getTime() > TOKEN_MARGIN_MS) return { ok: true, token: kept.token };
  if (!sa.email.endsWith(".iam.gserviceaccount.com") || !ACCOUNT_ID_RE.test(sa.email.split("@")[0]!)) return { ok: false, code: "share_unconfigured", retryAfterSec: null };

  const young = now.getTime() - Date.parse(sa.createdAt) < YOUNG_ACCOUNT_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const url = `${IAM_CREDENTIALS_ORIGIN}/v1/projects/-/serviceAccounts/${encodeURIComponent(sa.email)}:generateAccessToken`;
  for (let attempt = 0; ; attempt++) {
    const r = await iamCall("POST", url, { scope: [scope], lifetime: `${SHARE_TOKEN_LIFETIME_SEC}s` }, deps);
    if (r.ok && r.status >= 200 && r.status < 300) {
      const b = r.body as { accessToken?: unknown; expireTime?: unknown } | null;
      const expires = typeof b?.expireTime === "string" ? Date.parse(b.expireTime) : Number.NaN;
      if (typeof b?.accessToken !== "string" || !b.accessToken || !Number.isFinite(expires)) return { ok: false, code: "bad_response", retryAfterSec: null };
      remember(key, b.accessToken, Math.min(expires, now.getTime() + SHARE_TOKEN_LIFETIME_SEC * 1000));
      return { ok: true, token: b.accessToken };
    }
    // IAM may not see a new account for a minute or more: 403 (the wildcard hides 404) or 404.
    const notYet = r.ok && (r.status === 403 || r.status === 404);
    if (notYet && young && attempt < MINT_BACKOFF_MS.length) {
      await sleep(MINT_BACKOFF_MS[attempt]!);
      continue;
    }
    if (!r.ok) return { ok: false, code: r.code, retryAfterSec: null };
    if (notYet) return { ok: false, code: young ? "share_pending" : "share_unconfigured", retryAfterSec: null };
    const code = iamFailureCode(r.status, r.body);
    (deps.log ?? ((line: string) => console.warn(line)))(`[connectors] share iamcredentials.googleapis.com ${code} ${r.status}`);
    return { ok: false, code, retryAfterSec: r.retryAfterSec };
  }
}
