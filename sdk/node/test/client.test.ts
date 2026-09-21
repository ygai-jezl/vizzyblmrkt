import { describe, it, expect, vi } from "vitest";
import { YouGrow, YouGrowError } from "../src/index.js";
import { verify } from "../src/signing.js";

const SECRET = "ygs_client_test_secret";

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

const client = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  new YouGrow({ keyId: "ygk_test", secret: SECRET, flushIntervalMs: 0, fetch: fetchImpl, ...extra });

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
    expect(
      verify({
        secrets: [SECRET],
        direction: "events",
        timestamp: headers["x-yougrow-timestamp"],
        signature: headers["x-yougrow-signature"],
        rawBody: body,
      }),
    ).toEqual({ ok: true });
    const batch = (JSON.parse(body) as { batch: Array<Record<string, unknown>> }).batch;
    expect(batch[1]).toMatchObject({ type: "track", timestamp: "2026-09-21T10:00:00.000Z" });
  });

  it("splits more than 100 messages into several requests", async () => {
    const { fetchImpl, calls } = stubFetch([]);
    const yg = client(fetchImpl, { flushAt: 100 });
    for (let i = 0; i < 99; i += 1) yg.track({ userId: `u${i}`, event: "user.signed_up" });
    for (let i = 0; i < 151; i += 1) yg.track({ userId: `v${i}`, event: "user.signed_up" });
    await yg.flush();
    await new Promise((r) => setTimeout(r, 0));
    const sizes = calls.map((c) => (JSON.parse(c.body) as { batch: unknown[] }).batch.length);
    expect(sizes.every((n) => n <= 100)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(250);
  });

  it("retries network errors, 429 and 5xx — re-signing each attempt", async () => {
    const { fetchImpl, calls } = stubFetch([new TypeError("fetch failed"), 503, 429, 202]);
    const yg = client(fetchImpl, { maxRetries: 3 });
    yg.track({ userId: "u1", event: "user.signed_up" });
    const [r] = await yg.flush();
    expect(r?.accepted).toBe(1);
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((c) => c.body)).size).toBe(1); // same messages every time
  }, 20_000);

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
});
