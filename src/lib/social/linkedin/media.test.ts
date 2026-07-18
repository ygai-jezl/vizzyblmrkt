import { describe, it, expect } from "vitest";
import { uploadLinkedInImage } from "./media";

/** A fake fetch returning queued responses, recording each request. */
function fakeFetch(
  responses: Array<{ ok: boolean; status?: number; body?: unknown } | Error>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
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

const owner = "urn:li:organization:123";
const bytes = new Uint8Array([1, 2, 3, 4]);

describe("uploadLinkedInImage", () => {
  it("refuses without a token, owner, or bytes", async () => {
    expect(await uploadLinkedInImage({ ownerUrn: owner, bytes, accessToken: "" })).toEqual({
      ok: false,
      reason: "not_connected",
    });
    expect(await uploadLinkedInImage({ ownerUrn: "", bytes, accessToken: "t" })).toEqual({
      ok: false,
      reason: "no_owner",
    });
    expect(
      await uploadLinkedInImage({ ownerUrn: owner, bytes: new Uint8Array(0), accessToken: "t" }),
    ).toEqual({ ok: false, reason: "empty" });
  });

  it("initializes then PUTs the bytes and returns the image URN", async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200, body: { value: { uploadUrl: "https://up.example/abc", image: "urn:li:image:XYZ" } } },
      { ok: true, status: 201 },
    ]);
    const r = await uploadLinkedInImage({ ownerUrn: owner, bytes, accessToken: "tok" }, { fetch: fn });
    expect(r).toEqual({ ok: true, imageUrn: "urn:li:image:XYZ" });
    // Step 1: initializeUpload with the owner; Step 2: PUT to the returned url with the bytes.
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ initializeUploadRequest: { owner } });
    expect(calls[1]!.url).toBe("https://up.example/abc");
    expect(calls[1]!.init.method).toBe("PUT");
    expect(calls[1]!.init.body).toBe(bytes);
  });

  it("reports li_img_init_<status> when initializeUpload fails (no PUT attempted)", async () => {
    const { fn, calls } = fakeFetch([{ ok: false, status: 403, body: { message: "denied" } }]);
    expect(await uploadLinkedInImage({ ownerUrn: owner, bytes, accessToken: "t" }, { fetch: fn })).toEqual({
      ok: false,
      reason: "li_img_init_403",
    });
    expect(calls).toHaveLength(1); // did not proceed to the PUT
  });

  it("returns no_upload_url when init omits the url/urn", async () => {
    const { fn } = fakeFetch([{ ok: true, status: 200, body: { value: {} } }]);
    expect(await uploadLinkedInImage({ ownerUrn: owner, bytes, accessToken: "t" }, { fetch: fn })).toEqual({
      ok: false,
      reason: "no_upload_url",
    });
  });

  it("reports li_img_upload_<status> when the PUT fails", async () => {
    const { fn } = fakeFetch([
      { ok: true, status: 200, body: { value: { uploadUrl: "https://up.example/x", image: "urn:li:image:1" } } },
      { ok: false, status: 500 },
    ]);
    expect(await uploadLinkedInImage({ ownerUrn: owner, bytes, accessToken: "t" }, { fetch: fn })).toEqual({
      ok: false,
      reason: "li_img_upload_500",
    });
  });

  it("aborts on the wall-time budget → 'timeout'", async () => {
    const hangingFetch = ((_url: string, init: RequestInit) =>
      new Promise((_res, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;
    const r = await uploadLinkedInImage(
      { ownerUrn: owner, bytes, accessToken: "t" },
      { fetch: hangingFetch, timeoutMs: 5 },
    );
    expect(r).toEqual({ ok: false, reason: "timeout" });
  });

  it("never leaks the access token in a reason", async () => {
    const token = "AA.bb-cc secret";
    const r = await uploadLinkedInImage(
      { ownerUrn: owner, bytes, accessToken: token },
      { fetch: fakeFetch([{ ok: false, status: 401 }]).fn },
    );
    const s = JSON.stringify(r);
    expect(s).not.toContain("secret");
    expect(s).not.toContain(token);
  });
});
