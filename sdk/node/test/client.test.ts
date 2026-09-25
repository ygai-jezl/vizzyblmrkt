import { describe, it, expect, vi, afterEach } from "vitest";
import { inspect } from "node:util";
import {
  YouGrow,
  YouGrowBatchError,
  YouGrowError,
  type BatchItem,
  type BatchResponse,
  type UserPatch,
  type UserState,
  type UserView,
  type YouGrowOptions,
} from "../src/index.js";

// The repo's lint bans `.batch(` calls (a Firestore guard), so these tests take
// `users.batch` off the client first — which also shows it works unbound.

const KEY_ID = "ygk_client_test";
const SECRET = "ygs_client_test_secret";
const BASIC = `Basic ${Buffer.from(`${KEY_ID}:${SECRET}`).toString("base64")}`;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal | undefined;
}

type Step = (call: Call) => Response | Error | Promise<Response>;

/** A fetch that records every request and answers it with the next step (the last one repeats); an Error is thrown. */
function fakeApi(...steps: Step[]) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body === undefined ? undefined : String(init.body),
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    const answer = await steps[Math.min(calls.length, steps.length) - 1]!(call);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

/** A JSON response, made afresh for each request (a body can only be read once). */
const reply =
  (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  (): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const networkError = () => new TypeError("fetch failed");

const client = (fetchImpl: typeof fetch, extra: Partial<YouGrowOptions> = {}) =>
  new YouGrow({ keyId: KEY_ID, secret: SECRET, fetch: fetchImpl, maxRetryWaitMs: 1, ...extra });

const state = (userId: string, extra: Partial<UserState> = {}): UserState => ({
  userId,
  email: null,
  firstName: null,
  lastName: null,
  timezone: null,
  locale: null,
  signedUpAt: null,
  consent: null,
  subscribed: true,
  excluded: null,
  steps: {},
  facts: {},
  traits: {},
  updatedAt: null,
  ...extra,
});

/** A batch endpoint: `fail` and `stale` user ids come back failed / ignored, the rest applied. */
function batchEndpoint(fail: Set<string>, stale = new Set<string>()): (call: Call) => Response {
  return (call) => {
    const { users } = JSON.parse(call.body!) as { users: BatchItem[] };
    const results: BatchResponse["results"] = [];
    users.forEach((u, index) => {
      if (fail.has(u.userId)) {
        results.push({ index, userId: u.userId, status: "failed", reason: "invalid", fields: [{ path: "email", message: "Invalid email address" }] });
      } else if (stale.has(u.userId)) {
        results.push({ index, userId: u.userId, status: "ignored", reason: "stale_write" });
      }
    });
    const failed = results.filter((r) => r.status === "failed").length;
    return reply(200, { applied: users.length - results.length, ignored: results.length - failed, failed, results })();
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("users.update", () => {
  it("authenticates with HTTP Basic and sends the patch as it is", async () => {
    const patch: UserPatch = {
      email: "alex@example.com",
      firstName: "Alex",
      timezone: "Europe/London",
      signedUpAt: "2026-09-25T10:00:00Z",
      consent: "soft_opt_in",
      steps: { create_brand: null },
      traits: { plan: "pro" },
    };
    const user = state("u1", { email: "alex@example.com", firstName: "Alex" });
    const { fetch, calls } = fakeApi(reply(200, { applied: true, user }));

    await expect(client(fetch).users.update("u1", patch)).resolves.toEqual({ applied: true, user });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call).toMatchObject({ method: "PATCH", url: "https://yougrow.ai/api/v2/users/u1", body: JSON.stringify(patch) });
    expect(call!.headers).toEqual({ authorization: BASIC, accept: "application/json", "content-type": "application/json" });
    expect(Buffer.from(call!.headers.authorization!.slice("Basic ".length), "base64").toString()).toBe("ygk_client_test:ygs_client_test_secret");
  });

  it("URL-encodes the user id", async () => {
    const { fetch, calls } = fakeApi(reply(200, { applied: true, user: state("x") }));
    const yg = client(fetch);
    for (const userId of ["ü/用户 1", "a?b#c", "../batch"]) await yg.users.update(userId, {});
    expect(calls.map((c) => c.url)).toEqual([
      "https://yougrow.ai/api/v2/users/%C3%BC%2F%E7%94%A8%E6%88%B7%201",
      "https://yougrow.ai/api/v2/users/a%3Fb%23c",
      "https://yougrow.ai/api/v2/users/..%2Fbatch",
    ]);
  });

  it("returns a write YouGrow ignored (stale_write, deleted_later) rather than throwing", async () => {
    const stale = { applied: false, reason: "stale_write", storedUpdatedAt: "2026-09-25T11:00:00.000Z", user: state("u1") };
    const deleted = { applied: false, reason: "deleted_later", storedUpdatedAt: null };
    const { fetch } = fakeApi(reply(200, stale), reply(200, deleted));
    const yg = client(fetch);
    await expect(yg.users.update("u1", { firstName: "Old", updatedAt: "2026-09-25T10:00:00Z" })).resolves.toEqual(stale);
    await expect(yg.users.update("u2", { firstName: "Ghost", updatedAt: "2026-09-25T10:00:00Z" })).resolves.toEqual(deleted);
  });

  it("throws a 400 as a YouGrowError with the fields, without retrying", async () => {
    const body = {
      error: "invalid",
      fields: [
        { path: "traits.plan", message: "trait keys start with a letter" },
        { path: "email", message: "Invalid email address" },
      ],
    };
    const { fetch, calls } = fakeApi(reply(400, body));
    const err = await client(fetch)
      .users.update("u1", { email: "not an email" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YouGrowError);
    expect(err).toMatchObject({
      name: "YouGrowError",
      message: "YouGrow API 400 invalid: traits.plan: trait keys start with a letter; email: Invalid email address",
      status: 400,
      code: "invalid",
      fields: body.fields,
      body,
    });
    expect(calls).toHaveLength(1);
  });

  it("throws a 401 or 413 straight away", async () => {
    const { fetch, calls } = fakeApi(reply(401, { error: "unauthorized" }), reply(413, { error: "body_too_large" }));
    const yg = client(fetch);
    await expect(yg.users.update("u1", {})).rejects.toMatchObject({
      name: "YouGrowError",
      message: "YouGrow API 401 unauthorized",
      status: 401,
      code: "unauthorized",
    });
    await expect(yg.users.update("u1", {})).rejects.toMatchObject({ status: 413, code: "body_too_large" });
    expect(calls).toHaveLength(2);
  });

  it("throws when a success isn't JSON (e.g. the wrong origin)", async () => {
    const { fetch } = fakeApi(() => new Response("<!doctype html><title>Acme</title>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(client(fetch).users.update("u1", {})).rejects.toMatchObject({ name: "YouGrowError", status: 200, code: "http_200" });
  });
});

describe("retries and timeouts", () => {
  it("retries network errors, 5xx and 429 — the same request each time — then succeeds", async () => {
    const user = state("u1");
    const { fetch, calls } = fakeApi(
      networkError,
      reply(503, { error: "unavailable" }),
      reply(429, { error: "rate_limited" }, { "retry-after": "0" }),
      reply(200, { applied: true, user }),
    );
    await expect(client(fetch).users.update("u1", { firstName: "Alex" })).resolves.toEqual({ applied: true, user });
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((c) => `${c.method} ${c.url} ${c.body}`)).size).toBe(1);
  });

  it("gives up after maxRetries with the last error", async () => {
    const down = fakeApi(reply(503, { error: "unavailable" }));
    await expect(client(down.fetch).users.update("u1", {})).rejects.toMatchObject({ name: "YouGrowError", status: 503 });
    expect(down.calls).toHaveLength(4); // 1 + 3 retries

    const offline = fakeApi(networkError);
    const err = await client(offline.fetch, { maxRetries: 1 }).users.update("u1", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YouGrowError);
    expect(err).toMatchObject({ status: 0, code: "network_error", retryable: true, message: "YouGrow API network_error: fetch failed" });
    expect((err as Error).cause).toBeInstanceOf(TypeError);
    expect(offline.calls).toHaveLength(2);
  });

  it("says whether an error is worth retrying later", async () => {
    const fail = async (status: number) =>
      (await client(fakeApi(reply(status, { error: "x" })).fetch, { maxRetries: 0 }).users.update("u1", {}).catch((e: unknown) => e)) as YouGrowError;
    for (const status of [429, 500, 503]) expect((await fail(status)).retryable).toBe(true);
    for (const status of [400, 401, 404, 413]) expect((await fail(status)).retryable).toBe(false);
  });

  it("honours Retry-After on a 429, capped at maxRetryWaitMs, then succeeds", async () => {
    const { fetch, calls } = fakeApi(reply(429, { error: "rate_limited" }, { "retry-after": "60" }), reply(200, { applied: true, user: state("u1") }));
    const started = Date.now();
    await expect(client(fetch, { maxRetryWaitMs: 50 }).users.update("u1", {})).resolves.toMatchObject({ applied: true });
    const took = Date.now() - started;
    expect(calls).toHaveLength(2);
    expect(took).toBeGreaterThanOrEqual(45); // it did wait…
    expect(took).toBeLessThan(1000); // …but not the 60 s asked for
  });

  it("waits what Retry-After asks, up to 5 s by default; otherwise jittered exponential backoff", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { fetch, calls } = fakeApi(
      reply(429, { error: "rate_limited" }, { "retry-after": "1" }),
      reply(429, { error: "rate_limited" }, { "retry-after": "60" }),
      reply(503, { error: "unavailable" }),
      reply(200, { applied: true, user: state("u1") }),
    );
    const done = new YouGrow({ keyId: KEY_ID, secret: SECRET, fetch }).users.update("u1", {});
    const after = async (ms: number, expected: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      expect(calls).toHaveLength(expected);
    };
    await after(999, 1);
    await after(1, 2); // Retry-After: 1 → 1 s
    await after(4_999, 2);
    await after(1, 3); // Retry-After: 60 → capped at 5 s
    await after(999, 3);
    await after(1, 4); // no Retry-After: 0.5 × min(500 × 2², 5000) = 1 s
    await expect(done).resolves.toMatchObject({ applied: true });
  });

  it("aborts a request after timeoutMs, retries it, then throws", async () => {
    const { fetch, calls } = fakeApi(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.signal!;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const started = Date.now();
    await expect(client(fetch, { timeoutMs: 40, maxRetries: 2 }).users.update("u1", {})).rejects.toMatchObject({ name: "YouGrowError", status: 0, code: "timeout", retryable: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(3 * 40 - 10);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.signal?.aborted)).toBe(true);
  });
});

describe("users.batch", () => {
  it("sends 250 users as 100 + 100 + 50, one request after another, and merges the sparse results with indexes into your array", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const items: BatchItem[] = Array.from({ length: 250 }, (_, i) => ({ userId: `u${i}`, email: `u${i}@example.com` }));
    const endpoint = batchEndpoint(new Set(["u7", "u107", "u249"]), new Set(["u150"]));
    let open = 0;
    let maxOpen = 0;
    const { fetch, calls } = fakeApi(async (call) => {
      maxOpen = Math.max(maxOpen, (open += 1));
      await new Promise((r) => setTimeout(r, 5));
      open -= 1;
      return endpoint(call);
    });
    const { batch } = client(fetch).users;

    const result = await batch(items);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(Array(3).fill("POST https://yougrow.ai/api/v2/users/batch"));
    const sent = calls.map((c) => (JSON.parse(c.body!) as { users: BatchItem[] }).users);
    expect(sent.map((users) => users.length)).toEqual([100, 100, 50]);
    expect(sent.flat()).toEqual(items); // each item once, in order, as given
    expect(maxOpen).toBe(1);

    const fields = [{ path: "email", message: "Invalid email address" }];
    expect(result).toEqual({
      applied: 246,
      ignored: 1,
      failed: 3,
      results: [
        { index: 7, userId: "u7", status: "failed", reason: "invalid", fields },
        { index: 107, userId: "u107", status: "failed", reason: "invalid", fields },
        { index: 150, userId: "u150", status: "ignored", reason: "stale_write" },
        { index: 249, userId: "u249", status: "failed", reason: "invalid", fields },
      ],
    });
    // One line for the whole batch, however many requests it took.
    expect(warn.mock.calls).toEqual([["[@yougrowai/node] users.batch: 3 of 250 users failed (u7: invalid, u107: invalid, u249: invalid)"]]);
  });

  it("logs failures in one console.warn line — ids and reasons, never the data — unless quiet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const items = Array.from({ length: 6 }, (_, i) => ({ userId: `u${i}`, email: `person${i}@example.com`, firstName: "Alex" }));
    const { fetch } = fakeApi(batchEndpoint(new Set(["u0", "u1", "u2", "u4"])));
    const { batch } = client(fetch).users;

    await expect(batch(items)).resolves.toMatchObject({ applied: 2, failed: 4 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual(["[@yougrowai/node] users.batch: 4 of 6 users failed (u0: invalid, u1: invalid, u2: invalid, +1 more)"]);
    const line = String(warn.mock.calls[0]![0]);
    for (const secretish of [SECRET, BASIC, "@example.com", "Alex"]) expect(line).not.toContain(secretish);

    await expect(batch(items, { quiet: true })).resolves.toMatchObject({ failed: 4 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("with throwOnItemError, sends every item and then throws a YouGrowBatchError carrying the result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const items = Array.from({ length: 150 }, (_, i) => ({ userId: `u${i}` }));
    const { fetch, calls } = fakeApi(batchEndpoint(new Set(["u3"])));
    const { batch } = client(fetch).users;

    const err = await batch(items, { throwOnItemError: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YouGrowBatchError);
    expect(err).toMatchObject({
      name: "YouGrowBatchError",
      message: "YouGrow users.batch: 1 of 150 users failed (u3: invalid)",
      result: { applied: 149, ignored: 0, failed: 1, results: [{ index: 3, userId: "u3", status: "failed", reason: "invalid" }] },
    });
    expect(calls).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();

    const clean = fakeApi(batchEndpoint(new Set()));
    const { batch: cleanBatch } = client(clean.fetch).users;
    await expect(cleanBatch(items.slice(0, 2), { throwOnItemError: true })).resolves.toEqual({ applied: 2, ignored: 0, failed: 0, results: [] });
  });

  it("keeps every request under 512 KB, and fails an item too big for any request on its own", async () => {
    const note = (kb: number) => ({ note: "x".repeat(kb * 1024) });
    const items: BatchItem[] = [
      { userId: "a", traits: note(200) },
      { userId: "b", traits: note(200) },
      { userId: "c", traits: note(200) },
      { userId: "huge", traits: note(600) },
      { userId: "d" },
    ];
    const { fetch, calls } = fakeApi(batchEndpoint(new Set()));
    const { batch } = client(fetch).users;

    await expect(batch(items, { quiet: true })).resolves.toEqual({
      applied: 4,
      ignored: 0,
      failed: 1,
      results: [{ index: 3, userId: "huge", status: "failed", reason: "body_too_large" }],
    });
    expect(calls.map((c) => (JSON.parse(c.body!) as { users: BatchItem[] }).users.map((u) => u.userId))).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(calls.every((c) => Buffer.byteLength(c.body!) <= 512 * 1024)).toBe(true);
  });

  it("sends nothing for an empty array", async () => {
    const { fetch, calls } = fakeApi(reply(500, {}));
    const { batch } = client(fetch).users;
    await expect(batch([])).resolves.toEqual({ applied: 0, ignored: 0, failed: 0, results: [] });
    expect(calls).toHaveLength(0);
  });

  it("stops at a request that fails, and rejects", async () => {
    const { fetch, calls } = fakeApi(batchEndpoint(new Set()), reply(401, { error: "unauthorized" }));
    const { batch } = client(fetch).users;
    const items = Array.from({ length: 300 }, (_, i) => ({ userId: `u${i}` }));
    await expect(batch(items)).rejects.toMatchObject({ name: "YouGrowError", status: 401 });
    expect(calls).toHaveLength(2);
  });
});

describe("users.get, users.delete and events.track", () => {
  it("gets a user, null for one YouGrow doesn't know, and throws on any other 404", async () => {
    const view: UserView = {
      ...state("u1", { email: "alex@example.com" }),
      enrolments: [{ journeyId: "j1", status: "active", mode: "live", enrolledAt: "2026-09-25T10:00:00.000Z" }],
      optOuts: [{ scope: "category", category: "onboarding", at: "2026-09-25T11:00:00.000Z" }],
    };
    const { fetch, calls } = fakeApi(
      reply(200, view),
      reply(404, { error: "not_found" }),
      () => new Response("<!doctype html><title>Not found</title>", { status: 404, headers: { "content-type": "text/html" } }),
    );
    const yg = client(fetch);
    await expect(yg.users.get("u1")).resolves.toEqual(view);
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://yougrow.ai/api/v2/users/u1", body: undefined });
    expect(calls[0]!.headers).toEqual({ authorization: BASIC, accept: "application/json" });
    await expect(yg.users.get("u2")).resolves.toBeNull();
    await expect(yg.users.get("u3")).rejects.toMatchObject({ name: "YouGrowError", status: 404, code: "http_404" });
  });

  it("reads the connection behind the key with me()", async () => {
    const me = { connection: { id: "pcn_1", name: "Acme", environment: "production", status: "active" }, keyId: KEY_ID, rotating: false };
    const { fetch, calls } = fakeApi(reply(200, me));
    expect(await client(fetch).me()).toEqual(me);
    expect(calls[0]).toMatchObject({ url: "https://yougrow.ai/api/v2/me", method: "GET" });
    expect(calls[0]!.headers.authorization).toBe(BASIC);
  });

  it("deletes a user (204), as often as you like", async () => {
    const { fetch, calls } = fakeApi(() => new Response(null, { status: 204 }));
    const yg = client(fetch);
    await expect(yg.users.delete("u1")).resolves.toBeUndefined();
    await expect(yg.users.delete("u1")).resolves.toBeUndefined();
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["DELETE", "https://yougrow.ai/api/v2/users/u1", undefined],
      ["DELETE", "https://yougrow.ai/api/v2/users/u1", undefined],
    ]);
    expect(calls[0]!.headers).toEqual({ authorization: BASIC, accept: "application/json" });
  });

  it("tracks an event and returns what YouGrow recorded", async () => {
    const { fetch, calls } = fakeApi(
      reply(200, { recorded: true, duplicate: false }),
      reply(400, { error: "invalid", fields: [{ path: "event", message: "reserved — send it as state (signedUpAt, steps, subscribed) or DELETE the user" }] }),
    );
    const yg = client(fetch);
    const options = { properties: { format: "pdf" }, occurredAt: "2026-09-25T10:00:00Z", idempotencyKey: "u1:report.exported:r1" };
    await expect(yg.events.track("u1", "report.exported", options)).resolves.toEqual({ recorded: true, duplicate: false });
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://yougrow.ai/api/v2/users/u1/events" });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ event: "report.exported", ...options });

    await expect(yg.events.track("u1", "user.signed_up")).rejects.toThrow(/^YouGrow API 400 invalid: event: reserved/);
  });

  it("sends a random idempotencyKey when you don't — the same one on every retry", async () => {
    const { fetch, calls } = fakeApi(networkError, reply(200, { recorded: true, duplicate: false }));
    const yg = client(fetch);
    await yg.events.track("u1", "report.exported");
    await yg.events.track("u1", "report.exported");
    const [first, retry, next] = calls.map((c) => JSON.parse(c.body!) as { event: string; idempotencyKey: string });
    expect(first).toEqual({ event: "report.exported", idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(retry).toEqual(first);
    expect(next!.idempotencyKey).not.toBe(first!.idempotencyKey);
  });
});

describe("the client", () => {
  it("sends to `${origin}/api/v2/…`, https or localhost only", async () => {
    const { fetch, calls } = fakeApi(reply(200, { applied: true, user: state("u1") }), reply(200, { recorded: true, duplicate: false }));
    await client(fetch, { origin: "https://staging.yougrow.test//" }).events.track("u1", "report.exported");
    for (const origin of [undefined, "", "https://staging.yougrow.test/", "http://localhost:3002", "http://127.0.0.1:3002"]) {
      await client(fetch, { origin }).users.update("u1", {});
    }
    expect(calls.map((c) => c.url)).toEqual([
      "https://staging.yougrow.test/api/v2/users/u1/events",
      "https://yougrow.ai/api/v2/users/u1",
      "https://yougrow.ai/api/v2/users/u1", // e.g. an empty YOUGROW_ORIGIN: the default
      "https://staging.yougrow.test/api/v2/users/u1",
      "http://localhost:3002/api/v2/users/u1",
      "http://127.0.0.1:3002/api/v2/users/u1",
    ]);
    expect(() => client(fetch, { origin: "yougrow.ai" })).toThrow(/origin must be https/);
    expect(() => client(fetch, { origin: "http://yougrow.ai" })).toThrow(/origin must be https/);
  });

  it("refuses a user id the API can't take, before sending anything", async () => {
    const { fetch, calls } = fakeApi(reply(200, { applied: true, user: state("x") }));
    const yg = client(fetch);
    for (const userId of ["", "batch", "x".repeat(257), ".", "..", 42 as unknown as string]) {
      await expect(yg.users.update(userId, {})).rejects.toThrow(TypeError);
      await expect(yg.users.get(userId)).rejects.toThrow(TypeError);
      await expect(yg.users.delete(userId)).rejects.toThrow(TypeError);
      await expect(yg.events.track(userId, "report.exported")).rejects.toThrow(TypeError);
    }
    await expect(yg.users.update("batch", {})).rejects.toThrow(`YouGrow: userId can't be "batch"`);
    await expect(yg.users.update("x".repeat(257), {})).rejects.toThrow("YouGrow: userId is over 256 characters");
    const { batch } = yg.users;
    await expect(batch({ userId: "u1" } as unknown as BatchItem[])).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);

    await yg.users.update("x".repeat(256), {});
    expect(calls).toHaveLength(1);
  });

  it("requires credentials, and never shows them when logged", () => {
    expect(() => new YouGrow({ keyId: "", secret: "x" })).toThrow(/keyId and secret are required/);
    const yg = new YouGrow({ keyId: KEY_ID, secret: SECRET });
    for (const shown of [inspect(yg, { depth: 5, showHidden: true }), JSON.stringify(yg)]) {
      expect(shown).not.toContain(SECRET);
      expect(shown).not.toContain(BASIC.slice("Basic ".length));
    }
  });
});
