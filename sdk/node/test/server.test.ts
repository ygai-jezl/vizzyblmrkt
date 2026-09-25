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

  it("takes YouGrow's origin, with issuer as an alias, and refuses the two disagreeing", async () => {
    const auth = { authorization: `Bearer ${ctxVec.token}` };
    const host = jwksHost(out.jwks.keys); // asserts the keys come from `${origin}/.well-known/jwks.json`
    const v = createVerifier({ keyId: out.audience, origin: `${out.issuer}/`, fetch: host.fetchImpl });
    expect((await v.verify({ headers: auth, rawBody: ctxVec.body, direction: "context", nowMs: out.nowMs })).ok).toBe(true);
    expect(host.state.fetches).toBe(1);

    // The same value under both names is fine; an empty origin (unset env var) means the default.
    const same = createVerifier({ keyId: out.audience, origin: out.issuer, issuer: `${out.issuer}/`, jwks: out.jwks });
    expect((await same.verify({ headers: auth, rawBody: ctxVec.body, direction: "context", nowMs: out.nowMs })).ok).toBe(true);
    const unset = createVerifier({ keyId: out.audience, origin: "", jwks: out.jwks });
    expect((await unset.verify({ headers: auth, rawBody: ctxVec.body, direction: "context", nowMs: out.nowMs })).ok).toBe(true);

    // Tokens must carry the configured origin as iss.
    const staging = createVerifier({ keyId: out.audience, origin: "https://staging.yougrow.test", jwks: out.jwks });
    expect(await staging.verify({ headers: auth, rawBody: ctxVec.body, direction: "context", nowMs: out.nowMs })).toEqual({
      ok: false,
      reason: "wrong_issuer",
    });

    expect(() => createVerifier({ keyId: "k", origin: "https://yougrow.ai", issuer: "https://staging.yougrow.test" })).toThrow(
      /origin and issuer differ/,
    );
    expect(() => createVerifier({ keyId: "k", origin: "http://yougrow.ai" })).toThrow(/https/);
  });

  it("verifies a Buffer or Uint8Array body the same as a string", async () => {
    const v = createVerifier({ keyId: out.audience, origin: out.issuer, jwks: out.jwks });
    for (const t of out.tokens) {
      const headers = { authorization: `Bearer ${t.token}` };
      const asBuffer = await v.verify({ headers, rawBody: Buffer.from(t.body, "utf8"), direction: t.direction, nowMs: out.nowMs });
      expect(asBuffer.ok).toBe(true);
      const asBytes = await v.verify({ headers, rawBody: new TextEncoder().encode(t.body), direction: t.direction, nowMs: out.nowMs });
      expect(asBytes.ok).toBe(true);
    }
    const headers = { authorization: `Bearer ${ctxVec.token}` };
    expect(await v.verify({ headers, rawBody: Buffer.from(`${ctxVec.body} `), direction: "context", nowMs: out.nowMs })).toEqual({
      ok: false,
      reason: "body_mismatch",
    });
    // A parsed body is a mistake worth a clear error, not a silent mismatch.
    await expect(
      v.verify({ headers, rawBody: JSON.parse(ctxVec.body) as unknown as string, direction: "context", nowMs: out.nowMs }),
    ).rejects.toThrow(/raw request body/);
  });

  it("finds the token in a plain header object in any case (e.g. API Gateway REST events)", async () => {
    const v = createVerifier({ keyId: out.audience, origin: out.issuer, jwks: out.jwks });
    const verify = (headers: Record<string, string | string[] | undefined>) =>
      v.verify({ headers, rawBody: ctxVec.body, direction: "context", nowMs: out.nowMs });
    expect((await verify({ Authorization: `Bearer ${ctxVec.token}` })).ok).toBe(true);
    expect((await verify({ "Content-Type": "application/json", AUTHORIZATION: [`Bearer ${ctxVec.token}`] })).ok).toBe(true);
    expect((await verify({ authorization: undefined, Authorization: `Bearer ${ctxVec.token}` })).ok).toBe(true);
    expect(await verify({ "X-Authorization": `Bearer ${ctxVec.token}` })).toEqual({ ok: false, reason: "missing_token" });
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
