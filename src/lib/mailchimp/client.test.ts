import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAudience } from "./client";

// getAudience is the proof a key can read an audience: one GET on that list, Basic auth.
const fetchMock = vi.fn();
const cfg = { apiKey: "made-up-test-key-us21", serverPrefix: "us21", audienceId: "abc123" };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("getAudience", () => {
  it("reads the one list on the key's data centre, with Basic auth", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "abc123" }), { status: 200 }));
    const res = await getAudience(cfg);
    expect(res).toEqual({ ok: true, data: { id: "abc123" } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://us21.api.mailchimp.com/3.0/lists/abc123?fields=id");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("key:made-up-test-key-us21").toString("base64")}`);
    expect(init.body).toBeUndefined();
  });

  it("escapes the audience id in the path", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "x" }), { status: 200 }));
    await getAudience({ ...cfg, audienceId: "../campaigns" });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://us21.api.mailchimp.com/3.0/lists/..%2Fcampaigns?fields=id");
  });

  it("says not ok with the status on a 404", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ title: "Resource Not Found" }), { status: 404 }));
    expect(await getAudience(cfg)).toEqual({ ok: false, reason: "Resource Not Found", status: 404 });
  });

  it("says timeout when Mailchimp doesn't answer", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    expect(await getAudience(cfg)).toEqual({ ok: false, reason: "timeout" });
  });
});
