import { describe, it, expect } from "vitest";
import { postToLinkedIn } from "./client";

/** A fake fetch returning queued responses (with headers), recording requests. */
function fakeFetch(
  responses: Array<
    { ok: boolean; status?: number; body?: unknown; headers?: Record<string, string> } | Error
  >,
) {
  const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];
  let i = 0;
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = responses[i++];
    if (r instanceof Error) throw r;
    const headers = r!.headers ?? {};
    return {
      ok: r!.ok,
      status: r!.status ?? (r!.ok ? 201 : 400),
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      json: async () => r!.body ?? {},
      text: async () => JSON.stringify(r!.body ?? {}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const author = "urn:li:person:ABC";

describe("postToLinkedIn", () => {
  it("refuses without a token, author, or text", async () => {
    expect(await postToLinkedIn({ authorUrn: author, text: "hi", accessToken: "" })).toEqual({
      ok: false,
      reason: "not_connected",
    });
    expect(await postToLinkedIn({ authorUrn: "", text: "hi", accessToken: "t" })).toEqual({
      ok: false,
      reason: "no_author",
    });
    expect(await postToLinkedIn({ authorUrn: author, text: "  ", accessToken: "t" })).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("posts a single post and returns the URN (from x-restli-id) + feed url", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 201, headers: { "x-restli-id": "urn:li:share:99" } }]);
    const r = await postToLinkedIn({ authorUrn: author, text: "Hello LinkedIn", accessToken: "tok" }, { fetch: fn });
    expect(r).toEqual({
      ok: true,
      remoteId: "urn:li:share:99",
      url: "https://www.linkedin.com/feed/update/urn:li:share:99",
    });
    // Correct author, commentary, version header, and public visibility.
    expect(calls[0]!.body).toMatchObject({ author, commentary: "Hello LinkedIn", visibility: "PUBLIC", lifecycleState: "PUBLISHED" });
    expect((calls[0]!.init.headers as Record<string, string>)["linkedin-version"]).toBeTruthy();
    expect((calls[0]!.init.headers as Record<string, string>)["x-restli-protocol-version"]).toBe("2.0.0");
  });

  it("falls back to a body id when the header is absent", async () => {
    const { fn } = fakeFetch([{ ok: true, status: 201, body: { id: "urn:li:share:7" } }]);
    const r = await postToLinkedIn({ authorUrn: author, text: "x", accessToken: "t" }, { fetch: fn });
    expect(r).toMatchObject({ ok: true, remoteId: "urn:li:share:7" });
  });

  it("returns created_unconfirmed on a 2xx with no id (don't blind-retry)", async () => {
    const { fn } = fakeFetch([{ ok: true, status: 201 }]);
    expect(await postToLinkedIn({ authorUrn: author, text: "x", accessToken: "t" }, { fetch: fn })).toEqual({
      ok: false,
      reason: "created_unconfirmed",
    });
  });

  it("reports li_api_<status> with the error detail", async () => {
    const { fn } = fakeFetch([{ ok: false, status: 422, body: { message: "Duplicate post" } }]);
    expect(await postToLinkedIn({ authorUrn: author, text: "x", accessToken: "t" }, { fetch: fn })).toEqual({
      ok: false,
      reason: "li_api_422:Duplicate post",
    });
  });

  it("aborts on the wall-time budget → ambiguous 'timeout'", async () => {
    const hangingFetch = ((_url: string, init: RequestInit) =>
      new Promise((_res, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;
    const r = await postToLinkedIn({ authorUrn: author, text: "x", accessToken: "t" }, { fetch: hangingFetch, timeoutMs: 5 });
    expect(r).toEqual({ ok: false, reason: "timeout" });
  });

  it("never leaks the access token in a reason or url", async () => {
    const token = "AA.bb-cc secret";
    const scenarios = [
      await postToLinkedIn({ authorUrn: author, text: "x", accessToken: token }, { fetch: fakeFetch([{ ok: false, status: 401, body: {} }]).fn }),
      await postToLinkedIn({ authorUrn: author, text: "x", accessToken: token }, { fetch: fakeFetch([{ ok: true, status: 201, headers: { "x-restli-id": "urn:li:share:1" } }]).fn }),
      await postToLinkedIn({ authorUrn: author, text: "x", accessToken: token }, { fetch: fakeFetch([new Error("net")]).fn }),
    ];
    for (const r of scenarios) {
      const s = JSON.stringify(r);
      expect(s).not.toContain("secret");
      expect(s).not.toContain(token);
    }
  });
});
