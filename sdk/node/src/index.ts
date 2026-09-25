import { randomUUID } from "node:crypto";
import { isSecureOrigin, originOf } from "./origin.js";

/**
 * @yougrowai/node — keep your users' state in YouGrow lifecycle journeys (API v2).
 *
 *   const yg = new YouGrow({ keyId: process.env.YOUGROW_KEY_ID!, secret: process.env.YOUGROW_SECRET! });
 *   await yg.users.update(user.id, { email: user.email, signedUpAt: user.createdAt.toISOString(), consent: "soft_opt_in" });
 *
 * Server-side only: the secret authenticates every request (HTTP Basic). Each
 * method resolves once its request is done (a batch's, one per 100 users), with
 * nothing queued or sent in the background, so it's safe in serverless
 * functions. A request is abandoned after `timeoutMs` and retried with capped,
 * jittered backoff on network errors, timeouts, 429 and 5xx; any other error
 * status throws a YouGrowError straight away.
 */

// ---- The v2 contract (mirrors src/lib/connect/v2/contract.ts; a platform test compares them) ----

export type ConsentBasis = "consent" | "soft_opt_in" | "corporate_subscriber" | "none";

/**
 * Any subset of a user's state, as a JSON Merge Patch (RFC 7396): fields sent
 * replace YouGrow's, fields left out stay, `null` clears, and `steps`, `facts`
 * and `traits` merge key by key. Timestamps are ISO 8601 with a zone, e.g.
 * `new Date().toISOString()`.
 */
export interface UserPatch {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  /** An IANA time zone, e.g. "Europe/London". */
  timezone?: string | null;
  /** A BCP 47 locale, e.g. "en-GB". */
  locale?: string | null;
  /** When the account was created. Starts sign-up journeys while inside their window. */
  signedUpAt?: string;
  /** The legal basis for marketing email. */
  consent?: ConsentBasis | null;
  /** false = the person opted out of lifecycle email in your product. */
  subscribed?: boolean;
  /** Never email this person, in any journey (staff, test accounts, invited teammates). */
  excluded?: { reason: string } | null;
  /** Onboarding step id → when it was done (null: not done). */
  steps?: Record<string, string | null>;
  /** Fact id → its latest value (null removes it). */
  facts?: Record<string, number | string | boolean | null>;
  /** Anything else journeys branch on (null removes a key). */
  traits?: Record<string, string | number | boolean | null>;
  /** When you read this state. A write older than the stored one is ignored. */
  updatedAt?: string;
}

/** A user's state as YouGrow holds it. */
export interface UserState {
  userId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  timezone: string | null;
  locale: string | null;
  signedUpAt: string | null;
  consent: ConsentBasis | null;
  subscribed: boolean;
  excluded: { reason: string } | null;
  steps: Record<string, string>;
  facts: Record<string, string | number | boolean>;
  traits: Record<string, string | number | boolean>;
  updatedAt: string | null;
}

/** `users.get` adds what YouGrow decided: journeys and opt-outs. */
export interface UserView extends UserState {
  enrolments: Array<{ journeyId: string; status: string; mode: string; enrolledAt: string }>;
  /** Unsubscribes made in YouGrow's emails. They hold until the person lifts them; the API can't. */
  optOuts: Array<{ scope: "all" | "category"; category: string | null; at: string | null }>;
}

/** Why a write was ignored: older than the stored state, or than the user's deletion. */
export type SkipReason = "stale_write" | "deleted_later";

export type PatchResponse =
  /** `ignoredFields`: profile fields whose value was invalid, so left as they were; the rest applied. */
  | { applied: true; user: UserState; ignoredFields?: FieldError[] }
  | { applied: false; reason: SkipReason; storedUpdatedAt?: string | null; user?: UserState };

/** What was wrong with one field, e.g. `{ path: "traits.plan", message: "…" }`. */
export interface FieldError {
  path: string;
  message: string;
}

/** One user in `users.batch`: their id plus a patch. */
export interface BatchItem extends UserPatch {
  userId: string;
}

export interface BatchResponse {
  applied: number;
  ignored: number;
  failed: number;
  /**
   * The ignored and failed items, and applied ones whose invalid profile fields were
   * left as they were (reason `fields_ignored`). `index` is the item's position in your array.
   */
  results: Array<{ index: number; userId: string | null; status: "applied" | "ignored" | "failed"; reason: string; fields?: FieldError[] }>;
}

/** The connection behind your key (`GET /api/v2/me`). */
export interface MeResponse {
  connection: { id: string; name: string; environment: "staging" | "production" | null; status: "active" | "paused" | "revoked" };
  keyId: string;
  /** A new secret was issued in the last 24 hours; the previous one works until then. */
  rotating: boolean;
}

export interface EventResult {
  recorded: boolean;
  duplicate: boolean;
}

// ---- The client ----

export interface YouGrowOptions {
  /** Your connection's key id (`ygk_…`). */
  keyId: string;
  /** Its secret (`ygs_…`). Server-side only. */
  secret: string;
  /**
   * YouGrow's origin, e.g. from YOUGROW_ORIGIN. Defaults to https://yougrow.ai;
   * set it when you're connected to another YouGrow instance (staging, self-hosted).
   */
  origin?: string;
  /** Abandon a request after this long (default 10000); it's retried like a network error. */
  timeoutMs?: number;
  /** Retries per request for network errors, timeouts, 429 and 5xx (default 3). */
  maxRetries?: number;
  /** Longest wait between retries (default 5000), even when Retry-After asks for more. */
  maxRetryWaitMs?: number;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch;
}

export interface BatchOptions {
  /** Don't log the console.warn line about failed items. */
  quiet?: boolean;
  /** Throw a YouGrowBatchError, carrying the result, if any item failed. Every item is still sent. */
  throwOnItemError?: boolean;
}

export interface TrackOptions {
  properties?: Record<string, unknown>;
  /** When it happened (ISO 8601 with a zone). */
  occurredAt?: string;
  /** The same key is recorded once. Defaults to a random key per call, so the SDK's own retries never count twice. */
  idempotencyKey?: string;
}

export interface UsersApi {
  /** Merge a patch into one user's state; creates the user if YouGrow hasn't seen them. */
  update(userId: string, patch: UserPatch): Promise<PatchResponse>;
  /**
   * Patch any number of users, 100 per request, one request after another. One
   * bad item never fails the rest: the result lists the ignored and failed ones,
   * and failures are logged in one console.warn line (see BatchOptions).
   */
  batch(items: readonly BatchItem[], opts?: BatchOptions): Promise<BatchResponse>;
  /** The user's state, journeys and opt-outs, or null if YouGrow doesn't know them. */
  get(userId: string): Promise<UserView | null>;
  /** Erase the user and their history. Safe to repeat, and for users YouGrow never saw. */
  delete(userId: string): Promise<void>;
}

export interface EventsApi {
  /** Record a milestone, e.g. "report.exported". Optional: journeys run on state. */
  track(userId: string, event: string, opts?: TrackOptions): Promise<EventResult>;
}

const USERS_PATH = "/api/v2/users";
/** The API's limits: users per batch request, and bytes per request body. */
const MAX_BATCH = 100;
const MAX_BODY_BYTES = 512 * 1024;
const BATCH_ENVELOPE_BYTES = '{"users":[]}'.length;
const MAX_USER_ID = 256;
/** The longest delay a Node timer accepts. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The API refused a request, or it still failed after the retries: a 429, a 5xx,
 * or a timeout or network failure (`status` 0, `code` `timeout` or `network_error`).
 */
export class YouGrowError extends Error {
  /** The API's error code (`invalid`, `unauthorized`, `rate_limited`…), `timeout` or `network_error`, or `http_<status>`. */
  readonly code: string;
  /** For a 400: which fields were wrong, and why. */
  readonly fields?: FieldError[];
  /**
   * True for a 429, a 5xx, a timeout or a network failure: trying again later may
   * work, so a queue or trigger should rethrow it for redelivery. Anything else
   * (a 400, 401, 404…) won't succeed as it is.
   */
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "YouGrowError";
    const b = asRecord(body);
    this.code = typeof b?.error === "string" ? b.error : `http_${status}`;
    if (Array.isArray(b?.fields)) this.fields = b.fields as FieldError[];
    this.retryable = status === 0 || status === 429 || status >= 500;
  }
}

/** From `users.batch` with `throwOnItemError`: some items failed. The rest were applied; `result` says which. */
export class YouGrowBatchError extends Error {
  constructor(
    message: string,
    readonly result: BatchResponse,
  ) {
    super(message);
    this.name = "YouGrowBatchError";
  }
}

export class YouGrow {
  readonly users: UsersApi;
  readonly events: EventsApi;
  readonly #origin: string;
  /** Private (#), so logging the client never prints the credentials. */
  readonly #authorization: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #maxRetryWaitMs: number;
  readonly #fetch: typeof fetch;

  constructor(opts: YouGrowOptions) {
    if (!opts.keyId || !opts.secret) throw new Error("YouGrow: keyId and secret are required");
    this.#origin = originOf(opts.origin);
    if (!isSecureOrigin(this.#origin)) throw new Error("YouGrow: origin must be https, e.g. https://yougrow.ai");
    this.#authorization = `Basic ${Buffer.from(`${opts.keyId}:${opts.secret}`, "utf8").toString("base64")}`;
    this.#timeoutMs = whole(opts.timeoutMs, 10_000, 1, MAX_TIMER_MS);
    this.#maxRetries = whole(opts.maxRetries, 3, 0, Number.MAX_SAFE_INTEGER);
    this.#maxRetryWaitMs = whole(opts.maxRetryWaitMs, 5_000, 0, MAX_TIMER_MS);
    this.#fetch = opts.fetch ?? globalThis.fetch;

    this.users = {
      update: async (userId, patch) => (await this.#send("PATCH", userPath(userId), JSON.stringify(patch))) as PatchResponse,
      batch: (items, batchOpts) => this.#patchMany(items, batchOpts),
      get: async (userId) => {
        try {
          return (await this.#send("GET", userPath(userId))) as UserView;
        } catch (err) {
          // Only the API's own "no such user": a 404 from anything else (e.g. a wrong origin) still throws.
          if (err instanceof YouGrowError && err.status === 404 && err.code === "not_found") return null;
          throw err;
        }
      },
      delete: async (userId) => {
        await this.#send("DELETE", userPath(userId));
      },
    };
    this.events = {
      track: async (userId, event, options = {}) => {
        const path = `${userPath(userId)}/events`;
        const { properties, occurredAt } = options;
        // One key for every attempt, so a retry is never recorded twice.
        const body = { event, properties, occurredAt, idempotencyKey: options.idempotencyKey ?? randomUUID() };
        return (await this.#send("POST", path, JSON.stringify(body))) as EventResult;
      },
    };
  }

  /**
   * The connection behind your key: its name, environment and status. A credential
   * check — and a way to catch a key from the wrong environment — before you send.
   */
  async me(): Promise<MeResponse> {
    return (await this.#send("GET", "/api/v2/me")) as MeResponse;
  }

  async #patchMany(items: readonly BatchItem[], opts: BatchOptions = {}): Promise<BatchResponse> {
    if (!Array.isArray(items)) throw new TypeError("YouGrow: users.batch takes an array of { userId, ...patch }");
    const total: BatchResponse = { applied: 0, ignored: 0, failed: 0, results: [] };
    for (const chunk of chunks(items)) {
      if (chunk.bytes > MAX_BODY_BYTES) {
        // One item bigger than any request may be: it can't be valid, so it fails here.
        const userId = asRecord(items[chunk.start])?.userId;
        total.failed += 1;
        total.results.push({ index: chunk.start, userId: typeof userId === "string" ? userId : null, status: "failed", reason: "body_too_large" });
        continue;
      }
      const r = (await this.#send("POST", `${USERS_PATH}/batch`, `{"users":[${chunk.json.join(",")}]}`)) as BatchResponse;
      total.applied += r.applied;
      total.ignored += r.ignored;
      total.failed += r.failed;
      for (const item of r.results) total.results.push({ ...item, index: chunk.start + item.index });
    }
    if (total.failed > 0) {
      const summary = failureSummary(total, items.length);
      if (opts.throwOnItemError) throw new YouGrowBatchError(`YouGrow ${summary}`, total);
      if (!opts.quiet) console.warn(`[@yougrowai/node] ${summary}`);
    }
    return total;
  }

  /**
   * One request, retried on network errors, timeouts, 429 and 5xx. Resolves
   * with the JSON body (none for DELETE); an error status throws a YouGrowError.
   */
  async #send(method: string, path: string, body?: string): Promise<unknown> {
    const headers: Record<string, string> = { authorization: this.#authorization, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const doFetch = this.#fetch; // called unbound: some fetch implementations refuse another `this`
    for (let attempt = 0; ; attempt += 1) {
      let res: Response;
      let text: string;
      try {
        res = await doFetch(`${this.#origin}${path}`, { method, headers, body, signal: AbortSignal.timeout(this.#timeoutMs) });
        text = await res.text(); // under the same deadline
      } catch (err) {
        // Network error or timeout.
        if (attempt >= this.#maxRetries) throw transportError(err);
        await sleep(this.#retryWait(attempt));
        continue;
      }
      const data = parseJson(text);
      if (res.ok) {
        if (method !== "DELETE" && !asRecord(data)) {
          throw new YouGrowError(`YouGrow API ${res.status}: the response isn't JSON (is origin right?)`, res.status);
        }
        return data;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.#maxRetries) {
        await sleep(this.#retryWait(attempt, res.headers.get("retry-after")));
        continue;
      }
      throw apiError(res.status, data);
    }
  }

  /** Retry-After (seconds) if given, else exponential backoff with full jitter; never over maxRetryWaitMs. */
  #retryWait(attempt: number, retryAfter?: string | null): number {
    const seconds = retryAfter?.trim();
    if (seconds && /^\d+$/.test(seconds)) return Math.min(Number(seconds) * 1000, this.#maxRetryWaitMs);
    return Math.random() * Math.min(500 * 2 ** attempt, this.#maxRetryWaitMs);
  }
}

/** `/api/v2/users/{userId}`, refusing an id the API can't take before anything is sent. */
function userPath(userId: string): string {
  const problem = userIdProblem(userId);
  if (problem) throw new TypeError(`YouGrow: userId ${problem}`);
  return `${USERS_PATH}/${encodeURIComponent(userId)}`;
}

function userIdProblem(userId: unknown): string | null {
  if (typeof userId !== "string") return "must be a string";
  if (userId.length === 0) return "is empty";
  if (userId.length > MAX_USER_ID) return `is over ${MAX_USER_ID} characters`;
  // "batch" is a route; "." and ".." vanish from a URL path.
  if (userId === "batch" || userId === "." || userId === "..") return `can't be "${userId}"`;
  return null;
}

/**
 * Consecutive runs of batch items, one request each: at most 100 users and
 * 512 KB of body. A run over the limit is a single item too big to send.
 */
function* chunks(items: readonly unknown[]): Generator<{ start: number; json: string[]; bytes: number }> {
  let chunk = { start: 0, json: [] as string[], bytes: BATCH_ENVELOPE_BYTES };
  for (let i = 0; i < items.length; i += 1) {
    const json = JSON.stringify(items[i]) ?? "null";
    const size = Buffer.byteLength(json, "utf8");
    // + 1 for the comma before it.
    if (chunk.json.length === MAX_BATCH || (chunk.json.length > 0 && chunk.bytes + 1 + size > MAX_BODY_BYTES)) {
      yield chunk;
      chunk = { start: i, json: [], bytes: BATCH_ENVELOPE_BYTES };
    }
    chunk.bytes += (chunk.json.length > 0 ? 1 : 0) + size;
    chunk.json.push(json);
  }
  if (chunk.json.length > 0) yield chunk;
}

/** e.g. "users.batch: 2 of 250 users failed (u3: invalid, u17: invalid)". Ids and reasons only, never the data. */
function failureSummary(r: BatchResponse, count: number): string {
  const failed = r.results.filter((x) => x.status === "failed");
  const shown = failed.slice(0, 3).map((x) => `${x.userId ?? `item ${x.index}`}: ${x.reason}`);
  if (failed.length > 3) shown.push(`+${failed.length - 3} more`);
  return `users.batch: ${r.failed} of ${count} users failed${shown.length > 0 ? ` (${shown.join(", ")})` : ""}`;
}

/** e.g. "YouGrow API 400 invalid: traits.plan: …". */
/** A timeout or network failure that outlasted the retries: status 0, retryable, the original error as `cause`. */
function transportError(err: unknown): YouGrowError {
  const code = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timeout" : "network_error";
  const detail = err instanceof Error ? err.message : String(err);
  return new YouGrowError(`YouGrow API ${code}: ${detail}`, 0, { error: code }, { cause: err });
}

function apiError(status: number, body: unknown): YouGrowError {
  const b = asRecord(body);
  const fields = Array.isArray(b?.fields) ? (b.fields as FieldError[]) : [];
  let detail = fields
    .slice(0, 3)
    .map((f) => `${f.path}: ${f.message}`)
    .join("; ");
  if (fields.length > 3) detail += `; +${fields.length - 3} more`;
  if (!detail && typeof b?.message === "string") detail = b.message;
  const code = typeof b?.error === "string" ? ` ${b.error}` : "";
  return new YouGrowError(`YouGrow API ${status}${code}${detail ? `: ${detail}` : ""}`, status, body);
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function parseJson(text: string): unknown {
  try {
    return text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

/** A whole number in [min, max] from an option; unset or not a number means the default. */
function whole(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), min), max) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
