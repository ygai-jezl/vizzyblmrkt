import { randomUUID } from "node:crypto";
import { isSecureOrigin, originOf } from "./origin.js";
import { HEADERS, sign } from "./signing.js";

/**
 * @yougrowai/node — send your product's user events to YouGrow lifecycle journeys.
 *
 *   const yg = new YouGrow({ keyId: process.env.YOUGROW_KEY_ID!, secret: process.env.YOUGROW_SECRET! });
 *   yg.identify({ userId: user.id, traits: { email: user.email }, consent: { basis: "soft_opt_in" } });
 *   yg.track({ userId: user.id, event: "user.signed_up" });
 *   await yg.flush();
 *
 * Server-side only (the secret signs every request). Messages are batched (≤100
 * per request) and sent in the background, one request at a time, once
 * `flushAt` are queued or `flushIntervalMs` after the first. A request is
 * abandoned after `timeoutMs` and retried with capped backoff on network
 * errors, timeouts, 429 and 5xx. Every message carries a messageId, so a
 * retried or duplicated send is harmless.
 *
 * The background timer never keeps a process alive. In a serverless function,
 * `await flush()` before returning; in a script, `await close()` before exiting.
 * Both also wait for sends already in progress.
 */

export { HEADERS, sign, type Direction } from "./signing.js";

export type ConsentBasis = "consent" | "soft_opt_in" | "corporate_subscriber" | "none";
export type TraitValue = string | number | boolean | null;

export interface YouGrowOptions {
  keyId: string;
  secret: string;
  /**
   * YouGrow's origin, e.g. from YOUGROW_ORIGIN. Defaults to https://yougrow.ai;
   * set it when you're connected to another YouGrow instance (staging, self-hosted).
   */
  origin?: string;
  /** Ingest URL. Defaults to `${origin}/api/v1/events`; wins over `origin`. */
  endpoint?: string;
  /** Send in the background once this many messages are queued (default 20, max 100). */
  flushAt?: number;
  /** Send in the background this long after the first queued message (default 5000). 0 = only on flush(). */
  flushIntervalMs?: number;
  /** Abandon a request after this long (default 10000); it's retried like a network error. */
  timeoutMs?: number;
  /** Retries per batch for network errors, timeouts, 429 and 5xx (default 3). */
  maxRetries?: number;
  /** Longest wait between retries (default 5000), even when Retry-After asks for more. */
  maxRetryWaitMs?: number;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch;
  /**
   * Called when a background send still fails after its retries; the batch is
   * dropped. Without it, one console.warn line is logged.
   */
  onError?: (err: Error) => void;
}

export interface IdentifyInput {
  userId: string;
  traits?: Record<string, TraitValue>;
  consent?: { basis: ConsentBasis; source?: string };
  timestamp?: Date | string;
  messageId?: string;
}

export interface TrackInput {
  userId: string;
  event: string;
  properties?: Record<string, unknown>;
  traits?: Record<string, TraitValue>;
  timestamp?: Date | string;
  messageId?: string;
}

export interface StepCompletedOptions {
  timestamp?: Date | string;
  /** A stable id such as `${userId}:step:${step}` makes a repeat count once. */
  messageId?: string;
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: Array<{ index: number; messageId: string | null; reason: string }>;
}

type Message = Record<string, unknown> & { messageId: string };

const MAX_BATCH = 100;
/** The longest delay a Node timer accepts. */
const MAX_TIMER_MS = 2_147_483_647;

export class YouGrowError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "YouGrowError";
  }
}

export class YouGrow {
  private readonly keyId: string;
  private readonly secret: string;
  private readonly endpoint: string;
  private readonly flushAt: number;
  private readonly flushIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryWaitMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onError?: (err: Error) => void;
  private queue: Message[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Every send in progress, from the background or a flush(), until it settles. */
  private readonly inFlight = new Set<Promise<unknown>>();
  /** A background send is running; `backgroundDue` asks for another straight after it. */
  private backgroundBusy = false;
  private backgroundDue = false;

  constructor(opts: YouGrowOptions) {
    if (!opts.keyId || !opts.secret) throw new Error("YouGrow: keyId and secret are required");
    this.keyId = opts.keyId;
    this.secret = opts.secret;
    this.endpoint = opts.endpoint || eventsUrl(opts.origin);
    this.flushAt = Math.min(Math.max(opts.flushAt ?? 20, 1), MAX_BATCH);
    this.flushIntervalMs = opts.flushIntervalMs ?? 5000;
    this.timeoutMs = Math.min(Math.max(Math.floor(opts.timeoutMs ?? 10_000), 1), MAX_TIMER_MS);
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? 5000;
    this.fetchImpl = opts.fetch ?? fetch;
    this.onError = opts.onError;
  }

  /** Who the user is: email, name, timezone, plan… plus the consent basis. Returns the messageId. */
  identify(input: IdentifyInput): string {
    return this.enqueue({
      type: "identify",
      messageId: input.messageId ?? randomUUID(),
      userId: input.userId,
      timestamp: iso(input.timestamp),
      traits: input.traits ?? {},
      ...(input.consent ? { consent: input.consent } : {}),
    });
  }

  /** Something the user did. Returns the messageId. */
  track(input: TrackInput): string {
    return this.enqueue({
      type: "track",
      messageId: input.messageId ?? randomUUID(),
      userId: input.userId,
      timestamp: iso(input.timestamp),
      event: input.event,
      properties: input.properties ?? {},
      ...(input.traits ? { traits: input.traits } : {}),
    });
  }

  /**
   * Shorthand for the reserved `onboarding.step_completed` event. The third
   * argument is a timestamp, or `{ timestamp, messageId }`. Returns the messageId.
   */
  stepCompleted(userId: string, step: string, opts?: Date | string | StepCompletedOptions): string {
    const { timestamp, messageId }: StepCompletedOptions =
      typeof opts === "string" || opts instanceof Date ? { timestamp: opts } : (opts ?? {});
    return this.track({ userId, event: "onboarding.step_completed", properties: { step }, timestamp, messageId });
  }

  /**
   * Send everything queued, and wait for sends already in progress. Resolves
   * with one result per request this call made, or rejects with its failure. A
   * background send's failure was already reported (onError), so it isn't
   * rethrown. Either way, every message queued before the call has been sent
   * or reported by the time this settles.
   */
  async flush(): Promise<IngestResult[]> {
    this.clearTimer();
    const earlier = [...this.inFlight];
    const results: IngestResult[] = [];
    try {
      while (this.queue.length > 0) {
        const sending = this.send(this.queue.splice(0, MAX_BATCH));
        this.remember(sending);
        results.push(await sending);
      }
    } finally {
      await Promise.allSettled(earlier);
    }
    return results;
  }

  /** Flush until nothing is queued or in flight, and stop the timer. Call before your process exits. */
  async close(): Promise<IngestResult[]> {
    const results: IngestResult[] = [];
    try {
      do {
        results.push(...(await this.flush()));
      } while (this.queue.length > 0 || this.inFlight.size > 0);
    } finally {
      this.clearTimer();
    }
    return results;
  }

  private enqueue(msg: Message): string {
    this.queue.push(msg);
    if (this.queue.length >= this.flushAt) {
      this.sendInBackground();
    } else if (this.flushIntervalMs > 0 && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.sendInBackground();
      }, this.flushIntervalMs);
      this.timer.unref?.();
    }
    return msg.messageId;
  }

  /**
   * Send what's queued without waiting (flush() and close() still wait for it).
   * One background request at a time: what's queued meanwhile goes in the next
   * one, up to 100 messages, so a burst becomes a few full requests rather than
   * many parallel ones that trip the rate limit.
   */
  private sendInBackground(): void {
    this.clearTimer();
    if (this.backgroundBusy) {
      this.backgroundDue = true;
      return;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, MAX_BATCH);
    const sent = this.send(batch).then(
      () => undefined,
      (err: unknown) => this.report(err, batch.length),
    );
    this.remember(sent);
    this.backgroundBusy = true;
    void sent.then(() => {
      this.backgroundBusy = false;
      const again = this.backgroundDue || this.queue.length >= this.flushAt;
      this.backgroundDue = false;
      if (again) this.sendInBackground();
    });
  }

  /** Remember a send until it settles, so flush() and close() can wait for it. */
  private remember(sending: Promise<unknown>): void {
    this.inFlight.add(sending);
    const forget = () => {
      this.inFlight.delete(sending);
    };
    sending.then(forget, forget);
  }

  /** A background batch failed for good: tell onError, or log one line (never the secret, signature or body). */
  private report(err: unknown, dropped: number): void {
    const error = err instanceof Error ? err : new Error(String(err));
    try {
      if (this.onError) this.onError(error);
      else console.warn(`[@yougrowai/node] background send failed, ${dropped} message(s) dropped: ${error.message}`);
    } catch {
      // A throwing onError mustn't become an unhandled rejection.
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async send(batch: Message[]): Promise<IngestResult> {
    const body = JSON.stringify({ batch });
    for (let attempt = 0; ; attempt += 1) {
      // Sign every attempt afresh: the timestamp must stay inside the 5-minute window.
      const ts = Math.floor(Date.now() / 1000);
      let res: Response;
      let data: unknown;
      try {
        res = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [HEADERS.keyId]: this.keyId,
            [HEADERS.timestamp]: String(ts),
            [HEADERS.signature]: sign(this.secret, "events", ts, body),
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        data = res.ok ? await res.json() : await res.json().catch(() => undefined);
      } catch (err) {
        // Network error or timeout (the body is read under the same deadline).
        if (attempt >= this.maxRetries) throw err;
        await sleep(this.retryWait(attempt));
        continue;
      }
      if (res.ok) return data as IngestResult;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
        const code = (data as { error?: string } | undefined)?.error ?? `http_${res.status}`;
        throw new YouGrowError(`YouGrow ingest failed: ${code}`, res.status, data);
      }
      await sleep(this.retryWait(attempt, res.headers.get("retry-after")));
    }
  }

  /** Retry-After (seconds) if given, else exponential backoff with full jitter; never over maxRetryWaitMs. */
  private retryWait(attempt: number, retryAfter?: string | null): number {
    const hinted = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
    if (hinted) return Math.min(hinted, this.maxRetryWaitMs);
    return Math.random() * Math.min(500 * 2 ** attempt, this.maxRetryWaitMs);
  }
}

function eventsUrl(origin: string | undefined): string {
  const o = originOf(origin);
  if (!isSecureOrigin(o)) throw new Error("YouGrow: origin must be https, e.g. https://yougrow.ai");
  return `${o}/api/v1/events`;
}

function iso(t: Date | string | undefined): string {
  if (t === undefined) return new Date().toISOString();
  return typeof t === "string" ? t : t.toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
