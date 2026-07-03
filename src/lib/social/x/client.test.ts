import { describe, it, expect } from "vitest";
import { publishToX } from "./client";

/** A fake fetch that returns queued responses and records the requests it saw. */
function fakeFetch(
  responses: Array<{ ok: boolean; status?: number; body?: unknown } | Error>,
) {
  const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];
  let i = 0;
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const r = responses[i++];
    if (r instanceof Error) throw r;
    return {
      ok: r!.ok,
      status: r!.status ?? (r!.ok ? 200 : 400),
      json: async () => r!.body ?? {},
      text: async () => JSON.stringify(r!.body ?? {}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("publishToX", () => {
  it("refuses when there is no token or no content", async () => {
    expect(await publishToX({ parts: ["hi"], accessToken: "" })).toEqual({
      ok: false,
      reason: "not_connected",
    });
    expect(await publishToX({ parts: ["  ", ""], accessToken: "t" })).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("posts a single tweet and returns its id + url", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, body: { data: { id: "111" } } }]);
    const r = await publishToX({ parts: ["Just one tweet."], accessToken: "tok" }, { fetch: fn });
    expect(r).toEqual({ ok: true, remoteId: "111", url: "https://x.com/i/web/status/111" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.headers).toMatchObject({ authorization: "Bearer tok" });
    expect(calls[0]!.body).toEqual({ text: "Just one tweet." });
  });

  it("chains a thread via reply.in_reply_to_tweet_id and returns the first id", async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, body: { data: { id: "1" } } },
      { ok: true, body: { data: { id: "2" } } },
      { ok: true, body: { data: { id: "3" } } },
    ]);
    const r = await publishToX({ parts: ["a", "b", "c"], accessToken: "tok" }, { fetch: fn });
    expect(r).toMatchObject({ ok: true, remoteId: "1" });
    expect(calls[0]!.body).toEqual({ text: "a" }); // root, no reply
    expect(calls[1]!.body).toEqual({ text: "b", reply: { in_reply_to_tweet_id: "1" } });
    expect(calls[2]!.body).toEqual({ text: "c", reply: { in_reply_to_tweet_id: "2" } });
  });

  it("reports an X API error with the status code", async () => {
    const { fn } = fakeFetch([{ ok: false, status: 403, body: { title: "Forbidden" } }]);
    expect(await publishToX({ parts: ["x"], accessToken: "tok" }, { fetch: fn })).toEqual({
      ok: false,
      reason: "x_api_403:Forbidden",
    });
  });

  it("captures X's error detail (e.g. a 402 access-tier refusal) into the reason", async () => {
    const { fn } = fakeFetch([
      { ok: false, status: 402, body: { detail: "When authenticating requests you must use a paid access level." } },
    ]);
    const r = await publishToX({ parts: ["x"], accessToken: "tok" }, { fetch: fn });
    expect(r).toEqual({
      ok: false,
      reason: "x_api_402:When authenticating requests you must use a paid access level.",
    });
  });

  it("omits the detail suffix when the error body carries no message", async () => {
    const { fn } = fakeFetch([{ ok: false, status: 500, body: {} }]);
    expect(await publishToX({ parts: ["x"], accessToken: "tok" }, { fetch: fn })).toEqual({
      ok: false,
      reason: "x_api_500",
    });
  });

  it("aborts on the wall-time budget and returns an ambiguous 'timeout' reason", async () => {
    // A fetch that only settles when the abort signal fires (a hung request).
    const hangingFetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;
    const r = await publishToX(
      { parts: ["x"], accessToken: "tok" },
      { fetch: hangingFetch, timeoutMs: 5 },
    );
    expect(r).toEqual({ ok: false, reason: "timeout" });
  });

  it("flags a PARTIAL failure mid-thread (so the caller won't blindly re-post)", async () => {
    const { fn } = fakeFetch([
      { ok: true, body: { data: { id: "1" } } },
      { ok: false, status: 429, body: {} }, // second tweet rate-limited
    ]);
    const r = await publishToX({ parts: ["a", "b"], accessToken: "tok" }, { fetch: fn });
    expect(r).toEqual({ ok: false, reason: "x_api_429_partial" });
  });

  it("treats a 2xx with no readable id as created_unconfirmed (don't blindly retry)", async () => {
    const noId = fakeFetch([{ ok: true, body: { data: {} } }]);
    expect(await publishToX({ parts: ["x"], accessToken: "t" }, { fetch: noId.fn })).toEqual({
      ok: false,
      reason: "created_unconfirmed",
    });
    // A 200 whose body stream rejects also = likely-created → created_unconfirmed.
    const badBody = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("stream error");
      },
      text: async () => "",
    })) as unknown as typeof fetch;
    expect(await publishToX({ parts: ["x"], accessToken: "t" }, { fetch: badBody })).toEqual({
      ok: false,
      reason: "created_unconfirmed",
    });
  });

  it("marks mid-thread failures as partial (id-less, error, and network)", async () => {
    const noId = fakeFetch([
      { ok: true, body: { data: { id: "1" } } },
      { ok: true, body: { data: {} } },
    ]);
    expect(await publishToX({ parts: ["a", "b"], accessToken: "t" }, { fetch: noId.fn })).toEqual({
      ok: false,
      reason: "created_unconfirmed_partial",
    });
    const net = fakeFetch([{ ok: true, body: { data: { id: "1" } } }, new Error("drop")]);
    expect(await publishToX({ parts: ["a", "b"], accessToken: "t" }, { fetch: net.fn })).toEqual({
      ok: false,
      reason: "network_error_partial",
    });
  });

  it("first-tweet network failure is NOT partial (safe to retry)", async () => {
    const net = fakeFetch([new Error("boom")]);
    expect(await publishToX({ parts: ["a", "b"], accessToken: "t" }, { fetch: net.fn })).toEqual({
      ok: false,
      reason: "network_error",
    });
  });

  it("never leaks the access token in a reason or url (even with special chars)", async () => {
    const token = "AA.bb-cc_dd/ee+ff?gg secret";
    const scenarios: Array<Awaited<ReturnType<typeof publishToX>>> = [
      await publishToX({ parts: ["x"], accessToken: token }, { fetch: fakeFetch([{ ok: false, status: 401, body: {} }]).fn }),
      await publishToX({ parts: ["x"], accessToken: token }, { fetch: fakeFetch([{ ok: true, body: { data: { id: "9" } } }]).fn }),
      await publishToX({ parts: ["x"], accessToken: token }, { fetch: fakeFetch([new Error("net")]).fn }),
    ];
    for (const r of scenarios) {
      const serialized = JSON.stringify(r);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain("secret");
    }
  });
});
