import { describe, it, expect } from "vitest";
import { contextResponse, verifyRequest } from "../src/server.js";
import { sign } from "../src/signing.js";

describe("server helpers", () => {
  const secret = "ygs_server_test";
  const body = '{"userId":"u1","purpose":"send","requestId":"r1"}';
  const ts = 1_758_455_000;
  const sig = sign(secret, "context", ts, body);

  it("verifies Fetch-style and Node-style headers", () => {
    const fetchHeaders = new Headers({ "x-yougrow-timestamp": String(ts), "x-yougrow-signature": sig });
    expect(verifyRequest({ headers: fetchHeaders, rawBody: body, secret, direction: "context", nowMs: ts * 1000 })).toEqual({
      ok: true,
    });
    const nodeHeaders = { "x-yougrow-timestamp": String(ts), "x-yougrow-signature": [sig] };
    expect(verifyRequest({ headers: nodeHeaders, rawBody: body, secret, direction: "context", nowMs: ts * 1000 })).toEqual({
      ok: true,
    });
    expect(verifyRequest({ headers: nodeHeaders, rawBody: body, secret, direction: "webhook", nowMs: ts * 1000 }).ok).toBe(false);
  });

  it("builds a context body and refuses what YouGrow would reject", () => {
    const json = JSON.parse(
      contextResponse({
        asOf: "2026-09-21T10:00:00Z",
        steps: [{ id: "create_brand", label: "Add your brand", done: false, url: "https://app.acme.test/brand" }],
        nextStep: { id: "create_brand", label: "Add your brand" },
        insights: [{ id: "i1", sentence: "ChatGPT named 3 competitors but not you." }],
      }),
    ) as Record<string, unknown>;
    expect(json).toMatchObject({ asOf: "2026-09-21T10:00:00Z", facts: [], nextStep: { id: "create_brand" } });
    expect(() => contextResponse({ insights: [{ id: "x", sentence: "y".repeat(301) }] })).toThrow(/300/);
    expect(() => contextResponse({ steps: Array.from({ length: 21 }, (_, i) => ({ id: `s${i}`, label: "s", done: false })) })).toThrow();
  });
});
