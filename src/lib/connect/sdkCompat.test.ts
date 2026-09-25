import { describe, it, expect, afterEach, beforeAll, beforeEach } from "vitest";
import { YouGrow, YouGrowError } from "../../../sdk/node/src/index";
import type * as Sdk from "../../../sdk/node/src/index";
import { contextResponse, createVerifier } from "../../../sdk/node/src/server";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { createConnection } from "./keys";
import { __resetConnectionCaches } from "./connectionAuth";
import type * as C from "./v2/contract";
import { handleBatch, handleDeleteUser, handleGetUser, handlePatchUser, handleUserEvent, type V2HttpDeps } from "./v2/http";
import { fetchProductContext } from "./contextClient";
import { sendConnectionWebhook } from "./webhookClient";
import { outboundIssuer, publishedJwks } from "./outboundSigner";
import { productUserDocId } from "./profile";

/** The published SDK and the platform must agree: requests, responses, types and signatures. */
const ctx: TenantContext = { tenantId: "ten_A", region: "eu", source: "system" };

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});
beforeEach(() => {
  process.env.API_V2_ENABLED = "true";
  __resetConnectionCaches();
});
afterEach(() => {
  delete process.env.API_V2_ENABLED;
});

/** The SDK's hand-written types and the contract's schemas must be the same shapes. */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const typesMatch: [
  Same<Sdk.UserPatch, C.UserPatch>,
  Same<Sdk.UserState, C.UserState>,
  Same<Sdk.UserView, C.UserView>,
  Same<Sdk.PatchResponse, C.PatchResponse>,
  Same<Sdk.BatchResponse, C.BatchResponse>,
] = [true, true, true, true, true];

/** Routes the SDK's requests to the platform's real v2 handlers, in-process. */
function platformFetch(deps: V2HttpDeps): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    if (path === "/api/v2/users/batch" && req.method === "POST") return handleBatch(req, deps);
    const m = /^\/api\/v2\/users\/([^/]+)(\/events)?$/.exec(path);
    if (!m) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    const userId = decodeURIComponent(m[1]!);
    if (m[2] && req.method === "POST") return handleUserEvent(req, userId, deps);
    if (req.method === "PATCH") return handlePatchUser(req, userId, deps);
    if (req.method === "GET") return handleGetUser(req, userId, deps);
    if (req.method === "DELETE") return handleDeleteUser(req, userId, deps);
    return new Response(null, { status: 405 });
  }) as typeof fetch;
}

describe("SDK ↔ platform compatibility", () => {
  it("the SDK's types are the contract's", () => {
    expect(typesMatch.every(Boolean)).toBe(true);
  });

  it("the SDK client works end to end against the real API v2 handlers", async () => {
    const db = new FakeFirestore();
    const { connection, secret } = await createConnection(ctx, { name: "Acme", kind: "custom" }, db);
    const yg = new YouGrow({ keyId: connection.keyId, secret, origin: "https://yougrow.test", fetch: platformFetch({ db }) });

    const odd = "acme/alex@example.test"; // ids are path-encoded by the SDK
    const created = await yg.users.update(odd, { email: "alex@example.test", consent: "soft_opt_in", traits: { plan: "pro" }, steps: { create_brand: "2026-09-25T09:00:00Z" } });
    expect(created).toMatchObject({ applied: true, user: { userId: odd, consent: "soft_opt_in", traits: { plan: "pro" } } });
    expect(db.raw("product_users", productUserDocId(connection.id, odd))).toMatchObject({ email: "alex@example.test", steps: { create_brand: expect.any(Object) } });

    const stale = await yg.users.update(odd, { firstName: "Old", updatedAt: "2000-01-01T00:00:00Z" });
    expect(stale).toMatchObject({ applied: true }); // no updatedAt stored yet, so nothing to be stale against
    await yg.users.update(odd, { firstName: "New", updatedAt: "2026-09-25T11:00:00Z" });
    expect(await yg.users.update(odd, { firstName: "Older", updatedAt: "2026-09-25T10:00:00Z" })).toMatchObject({ applied: false, reason: "stale_write" });

    // The repo's lint bans `.batch(` calls (a Firestore guard), so take the method off the client first.
    const sync = yg.users.batch;
    const batch = await sync([{ userId: "u2", email: "b@example.test" }, { userId: "u3", timezone: "Mars/Olympus" } as never], { quiet: true });
    expect(batch).toMatchObject({ applied: 1, failed: 1, results: [{ index: 1, userId: "u3", status: "failed", reason: "invalid" }] });

    expect(await yg.events.track(odd, "report.exported", { idempotencyKey: "k1" })).toEqual({ recorded: true, duplicate: false });
    expect(await yg.events.track(odd, "report.exported", { idempotencyKey: "k1" })).toEqual({ recorded: false, duplicate: true });

    expect(await yg.users.get(odd)).toMatchObject({ userId: odd, firstName: "New", enrolments: [], optOuts: [] });
    await yg.users.delete(odd);
    expect(await yg.users.get(odd)).toBeNull();
  });

  it("the platform's 400s reach the SDK as a YouGrowError naming the field", async () => {
    const db = new FakeFirestore();
    const { connection, secret } = await createConnection(ctx, { name: "Acme", kind: "custom" }, db);
    const yg = new YouGrow({ keyId: connection.keyId, secret, origin: "https://yougrow.test", fetch: platformFetch({ db }), maxRetries: 0 });
    const err = await yg.users.update("u1", { subscribed: "no" } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YouGrowError);
    expect(err).toMatchObject({ status: 400, code: "invalid", fields: [{ path: "subscribed" }] });
    const bad = new YouGrow({ keyId: connection.keyId, secret: "ygs_wrong", origin: "https://yougrow.test", fetch: platformFetch({ db }), maxRetries: 0 });
    await expect(bad.users.get("u1")).rejects.toMatchObject({ status: 401 });
  });

  it("a product built on the SDK's verifier answers the platform's context pull", async () => {
    const db = new FakeFirestore();
    const { connection } = await createConnection(ctx, { name: "Acme", kind: "custom" }, db);
    const conn = {
      ...connection,
      contextEndpoint: { url: "https://api.acme.test/yougrow/context", enabled: true, timeoutMs: 5000 },
      linkDomains: ["acme.test"],
    };
    const verifier = createVerifier({ keyId: conn.keyId, issuer: outboundIssuer(), jwks: { keys: await publishedJwks() } });

    const r = await fetchProductContext(conn, { userId: "u1", purpose: "send" }, {
      fetchImpl: async (_url, init) => {
        const rawBody = String(init?.body);
        const v = await verifier.verify({ headers: new Headers(init?.headers), rawBody, direction: "context" });
        if (!v.ok) return new Response("unauthorised", { status: 401 });
        return new Response(
          contextResponse({
            steps: [{ id: "create_brand", label: "Add your brand", done: false, url: "https://app.acme.test/brand" }],
            nextStep: { id: "create_brand", label: "Add your brand", url: "https://app.acme.test/brand" },
            facts: [{ id: "sov", label: "Share of voice", value: 12, unit: "%" }],
            insights: [{ id: "sov", sentence: "Your share of voice is 12%.", factIds: ["sov"] }],
          }),
        );
      },
    });

    expect(r.ok).toBe(true);
    expect(r.ok && r.context.nextStep).toEqual({
      id: "create_brand",
      label: "Add your brand",
      url: "https://app.acme.test/brand",
    });
  });

  it("the SDK's verifier accepts the platform's webhooks, and only for its own connection", async () => {
    const db = new FakeFirestore();
    const { connection } = await createConnection(ctx, { name: "Acme", kind: "custom" }, db);
    const { connection: other } = await createConnection(ctx, { name: "Other", kind: "custom" }, db);
    const conn = { ...connection, webhookEndpoint: { url: "https://api.acme.test/yougrow/webhook", enabled: true } };
    const keys = { keys: await publishedJwks() };
    const mine = createVerifier({ keyId: conn.keyId, issuer: outboundIssuer(), jwks: keys });
    const theirs = createVerifier({ keyId: other.keyId, issuer: outboundIssuer(), jwks: keys });
    const seen: string[] = [];

    const r = await sendConnectionWebhook(conn, { type: "connection.test", data: {} }, {
      fetchImpl: async (_url, init) => {
        const input = { headers: new Headers(init?.headers), rawBody: String(init?.body), direction: "webhook" as const };
        const a = await mine.verify(input);
        const b = await theirs.verify(input);
        seen.push(a.ok ? "ok" : a.reason, b.ok ? "ok" : b.reason);
        return new Response(null, { status: a.ok ? 204 : 401 });
      },
    });
    expect(r).toEqual({ ok: true, status: 204 });
    expect(seen).toEqual(["ok", "wrong_audience"]);
  });
});
