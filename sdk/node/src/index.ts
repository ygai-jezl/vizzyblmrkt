import { randomUUID } from "node:crypto";
import { HEADERS, sign } from "./signing.js";

/**
 * @yougrow/node — send your product's user events to YouGrow lifecycle journeys.
 *
 *   const yg = new YouGrow({ keyId: process.env.YOUGROW_KEY_ID!, secret: process.env.YOUGROW_SECRET! });
 *   yg.identify({ userId: user.id, traits: { email: user.email }, consent: { basis: "soft_opt_in" } });
 *   yg.track({ userId: user.id, event: "user.signed_up" });
 *   await yg.flush();
 *
 * Server-side only (the secret signs every request). Messages are batched (≤100
 * per request) and retried with backoff on network errors, 429 and 5xx. Every
 * message carries a messageId, so a retried or duplicated send is harmless.
 */

export { HEADERS, sign, type Direction } from "./signing.js";

export type ConsentBasis = "consent" | "soft_opt_in" | "corporate_subscriber" | "none";
export type TraitValue = string | number | boolean | null;

export interface YouGrowOptions {
  keyId: string;
  secret: string;
  /** Ingest URL. Defaults to https://yougrow.ai/api/v1/events. */
  endpoint?: string;
  /** Flush automatically once this many messages are queued (max 100). */
  flushAt?: number;
  /** Flush automatically this long after the first queued message. 0 = manual only. */
  flushIntervalMs?: number;
  /** Retries per batch for network errors, 429 and 5xx. */
  maxRetries?: number;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch;
  /** Called when a background flush fails. */
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

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: Array<{ index: number; messageId: string | null; reason: string }>;
}

type Message = Record<string, unknown> & { messageId: string };

const MAX_BATCH = 100;

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
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onError?: (err: Error) => void;
  private queue: Message[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: YouGrowOptions) {
    if (!opts.keyId || !opts.secret) throw new Error("YouGrow: keyId and secret are required");
    this.keyId = opts.keyId;
    this.secret = opts.secret;
    this.endpoint = opts.endpoint ?? "https://yougrow.ai/api/v1/events";
    this.flushAt = Math.min(Math.max(opts.flushAt ?? 20, 1), MAX_BATCH);
    this.flushIntervalMs = opts.flushIntervalMs ?? 5000;
    this.maxRetries = opts.maxRetries ?? 3;
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

  /** Shorthand for the reserved `onboarding.step_completed` event. */
  stepCompleted(userId: string, step: string, timestamp?: Date | string): string {
    return this.track({ userId, event: "onboarding.step_completed", properties: { step }, timestamp });
  }

  /** Send everything queued. Resolves with one result per request. */
  async flush(): Promise<IngestResult[]> {
    this.clearTimer();
    const results: IngestResult[] = [];
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, MAX_BATCH);
      results.push(await this.send(batch));
    }
    return results;
  }

  /** Flush and stop the background timer (call on shutdown). */
  async close(): Promise<IngestResult[]> {
    return this.flush();
  }

  private enqueue(msg: Message): string {
    this.queue.push(msg);
    if (this.queue.length >= this.flushAt) {
      void this.flush().catch((err) => this.onError?.(err as Error));
    } else if (this.flushIntervalMs > 0 && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush().catch((err) => this.onError?.(err as Error));
      }, this.flushIntervalMs);
      this.timer.unref?.();
    }
    return msg.messageId;
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
        });
      } catch (err) {
        if (attempt >= this.maxRetries) throw err;
        await backoff(attempt);
        continue;
      }
      if (res.status === 202 || res.ok) return (await res.json()) as IngestResult;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
        const data = await res.json().catch(() => undefined);
        const code = (data as { error?: string } | undefined)?.error ?? `http_${res.status}`;
        throw new YouGrowError(`YouGrow ingest failed: ${code}`, res.status, data);
      }
      await backoff(attempt, res.headers.get("retry-after"));
    }
  }
}

function iso(t: Date | string | undefined): string {
  if (t === undefined) return new Date().toISOString();
  return typeof t === "string" ? t : t.toISOString();
}

/** Exponential backoff with full jitter; honours Retry-After (seconds). */
function backoff(attempt: number, retryAfter?: string | null): Promise<void> {
  const hinted = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
  const ms = hinted || Math.random() * Math.min(500 * 2 ** attempt, 10_000);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
