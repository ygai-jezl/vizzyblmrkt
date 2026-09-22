import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { YouGrow } from "../../../sdk/node/src/index";
import { contextResponse, createVerifier } from "../../../sdk/node/src/server";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { createConnection } from "./keys";
import { handleIngestRequest, __resetIngestCaches } from "./ingestHttp";
import { fetchProductContext } from "./contextClient";
import { sendConnectionWebhook } from "./webhookClient";
import { outboundIssuer, publishedJwks } from "./outboundSigner";
import { productUserDocId } from "./profile";

/** The published SDK and the platform must agree byte-for-byte. */
const ctx: TenantContext = { tenantId: "ten_A", region: "eu", source: "system" };

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});
beforeEach(() => {
  process.env.LIFECYCLE_INGEST_ENABLED = "true";
  __resetIngestCaches();
});

describe("SDK ↔ platform compatibility", () => {
  it("the SDK client's batches are accepted by the real ingest handler", async () => {
    const db = new FakeFirestore();
    const { connection, secret } = await createConnection(ctx, { name: "Acme", kind: "custom" }, db);
    const yg = new YouGrow({
      keyId: connection.keyId,
      secret,
      endpoint: "https://yougrow.test/api/v1/events",
      flushIntervalMs: 0,
      fetch: ((url: string, init?: RequestInit) =>
        handleIngestRequest(new Request(url, init), { db })) as unknown as typeof fetch,
    });

    yg.identify({ userId: "u1", traits: { email: "alex@acme.test", plan: "pro" }, consent: { basis: "soft_opt_in" } });
    yg.track({ userId: "u1", event: "user.signed_up" });
    yg.stepCompleted("u1", "create_brand");
    const [result] = await yg.flush();

    expect(result).toEqual({ accepted: 3, duplicates: 0, rejected: [] });
    expect(db.raw("product_users", productUserDocId(connection.id, "u1"))).toMatchObject({
      email: "alex@acme.test",
      consent: { basis: "soft_opt_in" },
      steps: { create_brand: expect.any(Object) },
    });
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
