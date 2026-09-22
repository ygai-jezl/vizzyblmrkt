import { describe, it, expect, vi, afterEach } from "vitest";
import vectorsFile from "./vectors.json";
import { contextResponse, createVerifier, type Jwk } from "../src/server.js";

const out = vectorsFile.outbound as {
  issuer: string;
  audience: string;
  nowMs: number;
  jwks: { keys: Jwk[] };
  tokens: { direction: "context" | "webhook"; body: string; token: string }[];
};
const ctxVec = out.tokens.find((t) => t.direction === "context")!;

/** A fake JWKS host that counts fetches. */
function jwksHost(keys: Jwk[], cacheControl = "public, max-age=3600") {
  const state = { fetches: 0, keys, fail: false };
  const fetchImpl = (async (url: string) => {
    state.fetches += 1;
    expect(url).toBe(`${out.issuer}/.well-known/jwks.json`);
    if (state.fail) throw new Error("network");
    return new Response(JSON.stringify({ keys: state.keys }), { headers: { "cache-control": cacheControl } });
  }) as unknown as typeof fetch;
  return { state, fetchImpl };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("server helpers", () => {
  it("verifies YouGrow's bearer token from Fetch-style and Node-style headers", async () => {
    const host = jwksHost(out.jwks.keys);
    const v = createVerifier({ keyId: out.audience, issuer: out.issuer, fetch: host.fetchImpl });
    const auth = `Bearer ${ctxVec.token}`;
    const fetchStyle = await v.verify({ headers: new Headers({ authorization: auth }), rawBody: ctxVec.body, direction: "context", nowMs: out.nowMs });
    expect(fetchStyle.ok).toBe(true);
    const nodeStyle = await v.verify({ headers: { authorization: [auth] }, rawBody: ctxVec.body, direction: "context", nowMs: out.nowMs });
    expect(nodeStyle.ok).toBe(true);
    expect(host.state.fetches).toBe(1); // cached
    const wrongDir = await v.verify({ headers: { authorization: auth }, rawBody: ctxVec.body, direction: "webhook", nowMs: out.nowMs });
    expect(wrongDir).toEqual({ ok: false, reason: "wrong_direction" });
    expect(await v.verify({ headers: {}, rawBody: ctxVec.body, direction: "context", nowMs: out.nowMs })).toEqual({
      ok: false,
      reason: "missing_token",
    });
  });

  it("refetches the keys when a token names a new one, and keeps old keys if a refresh fails", async () => {
    const host = jwksHost([]);
    const v = createVerifier({ keyId: out.audience, issuer: out.issuer, fetch: host.fetchImpl });
    const auth = { authorization: `Bearer ${ctxVec.token}` };
    // First fetch finds no matching key; the immediate refetch is rate-limited.
    expect(await v.verify({ headers: auth, rawBody: ctxVec.body, direction: "context", nowMs: out.nowMs })).toEqual({
      ok: false,
      reason: "unknown_key",
    });
    expect(host.state.fetches).toBe(1);

    // YouGrow publishes the new key; a minute later the verifier picks it up.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    host.state.keys = out.jwks.keys;
    expect((await v.verify({ headers: auth, rawBody: ctxVec.body, direction: "context", nowMs: out.nowMs })).ok).toBe(true);
    expect(host.state.fetches).toBe(2);

    // Keys expire, the refresh fails: the cached keys keep working.
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    host.state.fail = true;
    expect((await v.verify({ headers: auth, rawBody: ctxVec.body, direction: "context", nowMs: out.nowMs })).ok).toBe(true);
    expect(host.state.fetches).toBe(3);
  });

  it("reports unavailable keys rather than accepting anything", async () => {
    const host = jwksHost(out.jwks.keys);
    host.state.fail = true;
    const v = createVerifier({ keyId: out.audience, issuer: out.issuer, fetch: host.fetchImpl });
    expect(await v.verify({ headers: { authorization: `Bearer ${ctxVec.token}` }, rawBody: ctxVec.body, direction: "context", nowMs: out.nowMs })).toEqual({
      ok: false,
      reason: "keys_unavailable",
    });
  });

  it("accepts pinned keys and refuses a non-https issuer", async () => {
    const v = createVerifier({ keyId: out.audience, issuer: out.issuer, jwks: out.jwks });
    expect((await v.verify({ headers: { authorization: `Bearer ${ctxVec.token}` }, rawBody: ctxVec.body, direction: "context", nowMs: out.nowMs })).ok).toBe(true);
    expect(() => createVerifier({ keyId: "k", issuer: "http://yougrow.ai" })).toThrow(/https/);
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
