import { describe, it, expect, vi, afterEach } from "vitest";
import { YouGrow, YouGrowError } from "../src/index.js";
import { sign } from "../src/signing.js";

const SECRET = "ygs_client_test_secret";

function accepted(init?: RequestInit): Response {
  const batch = (JSON.parse(String(init?.body)) as { batch: unknown[] }).batch;
  return new Response(JSON.stringify({ accepted: batch.length, duplicates: 0, rejected: [] }), { status: 202 });
}

function stubFetch(responses: Array<number | Error>) {
  const calls: Array<{ headers: Record<string, string>; body: string }> = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ headers: init?.headers as Record<string, string>, body: String(init?.body) });
    const next = responses.shift() ?? 202;
    if (next instanceof Error) throw next;
    const batch = (JSON.parse(String(init?.body)) as { batch: unknown[] }).batch;
    return new Response(JSON.stringify({ accepted: batch.length, duplicates: 0, rejected: [] }), {
      status: next,
      headers: next === 429 ? { "retry-after": "0" } : {},
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/** Answers every request after `ms`, recording each batch's size as it completes. */
function slowFetch(ms: number) {
  const completed: number[] = [];
  let started = 0;
  let open = 0;
  let maxOpen = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    started += 1;
    maxOpen = Math.max(maxOpen, (open += 1));
    await new Promise((r) => setTimeout(r, ms));
    open -= 1;
    completed.push((JSON.parse(String(init?.body)) as { batch: unknown[] }).batch.length);
    return accepted(init);
  }) as unknown as typeof fetch;
  return { fetchImpl, completed, started: () => started, maxOpen: () => maxOpen };
}

const client = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  new YouGrow({ keyId: "ygk_test", secret: SECRET, flushIntervalMs: 0, fetch: fetchImpl, ...extra });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("YouGrow client", () => {
  it("signs a batch the server can verify, with unique message ids", async () => {
    const { fetchImpl, calls } = stubFetch([202]);
    const yg = client(fetchImpl);
    const a = yg.identify({ userId: "u1", traits: { email: "a@acme.test" }, consent: { basis: "soft_opt_in" } });
    const b = yg.track({ userId: "u1", event: "user.signed_up", timestamp: new Date("2026-09-21T10:00:00Z") });
    expect(a).not.toBe(b);

    const [result] = await yg.flush();
    expect(result).toEqual({ accepted: 2, duplicates: 0, rejected: [] });
    const { headers, body } = calls[0]!;
    expect(headers["x-yougrow-key-id"]).toBe("ygk_test");
    expect(headers["x-yougrow-signature"]).toBe(sign(SECRET, "events", Number(headers["x-yougrow-timestamp"]), body));
    const batch = (JSON.parse(body) as { batch: Array<Record<string, unknown>> }).batch;
    expect(batch[1]).toMatchObject({ type: "track", timestamp: "2026-09-21T10:00:00.000Z" });
  });

  it("splits more than 100 messages into several requests", async () => {
    const { fetchImpl, calls } = stubFetch([]);
    const yg = client(fetchImpl, { flushAt: 100 });
    for (let i = 0; i < 99; i += 1) yg.track({ userId: `u${i}`, event: "user.signed_up" });
    for (let i = 0; i < 151; i += 1) yg.track({ userId: `v${i}`, event: "user.signed_up" });
    await yg.flush();
    const sizes = calls.map((c) => (JSON.parse(c.body) as { batch: unknown[] }).batch.length);
    expect(sizes.every((n) => n <= 100)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(250);
  });

  it("retries network errors, 429 and 5xx — re-signing each attempt", async () => {
    const { fetchImpl, calls } = stubFetch([new TypeError("fetch failed"), 503, 429, 202]);
    const yg = client(fetchImpl, { maxRetries: 3, maxRetryWaitMs: 20 });
    yg.track({ userId: "u1", event: "user.signed_up" });
    const [r] = await yg.flush();
    expect(r?.accepted).toBe(1);
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((c) => c.body)).size).toBe(1); // same messages every time
  });

  it("does not retry a 401 and says why", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "bad_signature" }), { status: 401 }),
    ) as unknown as typeof fetch;
    const yg = client(fetchImpl);
    yg.track({ userId: "u1", event: "user.signed_up" });
    await expect(yg.flush()).rejects.toMatchObject({ name: "YouGrowError", status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requires credentials", () => {
    expect(() => new YouGrow({ keyId: "", secret: "x" })).toThrow();
    expect(YouGrowError).toBeDefined();
  });

  it("sends to `${origin}/api/v1/events`; an explicit endpoint wins", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      return accepted(init);
    }) as unknown as typeof fetch;
    for (const extra of [
      {},
      { origin: "https://staging.yougrow.test//" },
      { origin: "", endpoint: "" }, // e.g. an empty YOUGROW_ORIGIN: the default
      { origin: "https://staging.yougrow.test", endpoint: "https://proxy.example.com/yougrow/events" },
      { origin: "http://localhost:3002" },
    ]) {
      const yg = client(fetchImpl, extra);
      yg.track({ userId: "u1", event: "user.signed_up" });
      await yg.flush();
    }
    expect(urls).toEqual([
      "https://yougrow.ai/api/v1/events",
      "https://staging.yougrow.test/api/v1/events",
      "https://yougrow.ai/api/v1/events",
      "https://proxy.example.com/yougrow/events",
      "http://localhost:3002/api/v1/events",
    ]);
    expect(() => client(fetchImpl, { origin: "yougrow.ai" })).toThrow(/origin must be https/);
    expect(() => client(fetchImpl, { origin: "http://yougrow.ai" })).toThrow(/origin must be https/);
  });

  it("stepCompleted takes a timestamp (Date or string), or { timestamp, messageId }", async () => {
    const { fetchImpl, calls } = stubFetch([202]);
    const yg = client(fetchImpl);
    yg.stepCompleted("u1", "create_brand");
    yg.stepCompleted("u1", "add_competitors", new Date("2026-09-21T10:00:00Z"));
    yg.stepCompleted("u1", "invite_team", "2026-09-21T11:00:00+01:00");
    const id = yg.stepCompleted("u1", "confirm_competitors", {
      messageId: "u1:step:confirm_competitors",
      timestamp: new Date("2026-09-21T12:00:00Z"),
    });
    expect(id).toBe("u1:step:confirm_competitors");
    expect(yg.stepCompleted("u1", "connect_repo", { messageId: "u1:step:connect_repo" })).toBe("u1:step:connect_repo");
    await yg.flush();

    const batch = (JSON.parse(calls[0]!.body) as { batch: Array<Record<string, unknown>> }).batch;
    const step = { type: "track", userId: "u1", event: "onboarding.step_completed" };
    expect(batch).toMatchObject([
      { ...step, properties: { step: "create_brand" } },
      { ...step, properties: { step: "add_competitors" }, timestamp: "2026-09-21T10:00:00.000Z" },
      { ...step, properties: { step: "invite_team" }, timestamp: "2026-09-21T11:00:00+01:00" },
      { ...step, properties: { step: "confirm_competitors" }, messageId: "u1:step:confirm_competitors", timestamp: "2026-09-21T12:00:00.000Z" },
      { ...step, properties: { step: "connect_repo" }, messageId: "u1:step:connect_repo" },
    ]);
    expect(Date.parse(String(batch[4]!.timestamp))).not.toBeNaN(); // defaults to now
  });
});

describe("flush() and close() wait for sends already in progress", () => {
  it.each(["flush", "close"] as const)("%s() after exactly flushAt messages", async (finish) => {
    const { fetchImpl, completed } = slowFetch(60);
    const yg = client(fetchImpl); // flushAt 20: the 20th message starts a background send
    for (let i = 0; i < 20; i += 1) yg.track({ userId: `u${i}`, event: "onboarding.step_completed", properties: { step: "s" } });
    expect(completed).toEqual([]);
    await expect(yg[finish]()).resolves.toEqual([]); // nothing left for it to send itself…
    expect(completed).toEqual([20]); // …but it returned only once that send had finished
  });

  it("a second flush() waits for the first one's send", async () => {
    const { fetchImpl, completed } = slowFetch(60);
    const yg = client(fetchImpl);
    yg.track({ userId: "u1", event: "user.signed_up" });
    const first = yg.flush();
    await yg.flush(); // e.g. another request handler sharing the client
    expect(completed).toEqual([1]);
    await expect(first).resolves.toHaveLength(1);
  });

  it("sends a burst in the background one request at a time, up to 100 messages each", async () => {
    const { fetchImpl, completed, maxOpen } = slowFetch(20);
    const yg = client(fetchImpl);
    for (let i = 0; i < 250; i += 1) yg.identify({ userId: `u${i}`, traits: { email: `u${i}@example.com` } });
    await vi.waitFor(() => expect(completed).toEqual([20, 100, 100, 30]), { timeout: 2000 });
    expect(maxOpen()).toBe(1);
    await expect(yg.close()).resolves.toEqual([]);
  });

  it("the timer sends in the background too, and close() waits for it", async () => {
    const { fetchImpl, completed, started } = slowFetch(60);
    const yg = client(fetchImpl, { flushIntervalMs: 10 });
    yg.track({ userId: "u1", event: "user.signed_up" });
    await vi.waitFor(() => expect(started()).toBe(1)); // the timer has fired; its send is in flight
    expect(completed).toEqual([]);
    await expect(yg.close()).resolves.toEqual([]);
    expect(completed).toEqual([1]);
  });
});

describe("failures", () => {
  const rejectAll = () =>
    vi.fn(async () => new Response(JSON.stringify({ error: "bad_signature" }), { status: 401 })) as unknown as typeof fetch;

  it("reports a background failure to onError; a later flush() doesn't rethrow it", async () => {
    const onError = vi.fn();
    const yg = client(rejectAll(), { flushAt: 1, onError });
    yg.track({ userId: "u1", event: "user.signed_up" }); // flushAt 1: sent in the background
    await expect(yg.flush()).resolves.toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ name: "YouGrowError", status: 401 });
  });

  it("without onError, logs one console.warn line with no secret, signature or body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init!);
      return new Response(JSON.stringify({ error: "bad_signature" }), { status: 401 });
    }) as unknown as typeof fetch;
    const yg = client(fetchImpl, { flushAt: 1 });
    yg.identify({ userId: "u1", traits: { email: "alex@example.com" } });
    await yg.flush();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toHaveLength(1); // just the line: no error object, no response body
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toBe("[@yougrowai/node] background send failed, 1 message(s) dropped: YouGrow ingest failed: bad_signature");
    const headers = seen[0]!.headers as Record<string, string>;
    for (const secretish of [SECRET, headers["x-yougrow-signature"]!, String(seen[0]!.body), "alex@example.com"]) {
      expect(line).not.toContain(secretish);
    }
  });

  it("a throwing onError doesn't become an unhandled rejection", async () => {
    const yg = client(rejectAll(), {
      flushAt: 1,
      onError: () => {
        throw new Error("logger down");
      },
    });
    yg.track({ userId: "u1", event: "user.signed_up" });
    await expect(yg.close()).resolves.toEqual([]);
  });

  it("aborts a request after timeoutMs, retries it, then throws", async () => {
    const signals: AbortSignal[] = [];
    const hang = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init!.signal!;
          signals.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const yg = client(hang as unknown as typeof fetch, { timeoutMs: 40, maxRetries: 2, maxRetryWaitMs: 1 });
    yg.track({ userId: "u1", event: "user.signed_up" });
    const started = Date.now();
    await expect(yg.flush()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(3 * 40 - 10);
    expect(hang).toHaveBeenCalledTimes(3);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("caps a Retry-After of 60 s at maxRetryWaitMs", async () => {
    const rateLimited = vi.fn(
      async () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "retry-after": "60" } }),
    );
    const yg = client(rateLimited as unknown as typeof fetch, { maxRetries: 2, maxRetryWaitMs: 30 });
    yg.track({ userId: "u1", event: "user.signed_up" });
    const started = Date.now();
    await expect(yg.flush()).rejects.toMatchObject({ name: "YouGrowError", status: 429 });
    const took = Date.now() - started;
    expect(rateLimited).toHaveBeenCalledTimes(3);
    expect(took).toBeGreaterThanOrEqual(2 * 30 - 10); // it did wait between attempts…
    expect(took).toBeLessThan(1000); // …but not the 60 s asked for
  });

  it("waits at most 5 s between retries by default", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const rateLimitedOnce = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "retry-after": "60" } }))
      .mockImplementation(async (_url: string, init?: RequestInit) => accepted(init));
    const yg = client(rateLimitedOnce as unknown as typeof fetch);
    yg.track({ userId: "u1", event: "user.signed_up" });
    const flushed = yg.flush();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(rateLimitedOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rateLimitedOnce).toHaveBeenCalledTimes(2);
    await expect(flushed).resolves.toEqual([{ accepted: 1, duplicates: 0, rejected: [] }]);
  });
});
