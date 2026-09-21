import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import { createConnection } from "./keys";
import { fetchProductContext, isAllowedLink } from "./contextClient";
import { __resetIngestCaches } from "./ingestHttp";
import { createProductConnection, fireSandbox } from "./adminApi";
import { HEADER_SIGNATURE, HEADER_TIMESTAMP, verifySignature } from "./protocol";

const ctx: TenantContext = { tenantId: "ten_A", region: "eu", source: "idtoken", email: "jez@yougrow.test", role: "admin" };
const NOW = Date.parse("2026-09-21T12:00:00Z");

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});
beforeEach(() => {
  process.env.LIFECYCLE_INGEST_ENABLED = "true";
  __resetIngestCaches();
});

async function sandbox(db: FakeFirestore): Promise<ProductConnection> {
  const r = await createProductConnection(ctx, { name: "Sandbox", kind: "sandbox" }, { origin: "https://yougrow.test", db });
  const id = (r.body as { connection: { id: string } }).connection.id;
  return (await forTenant(ctx, db).productConnections.getById(id))!;
}

/** A custom connection whose context endpoint is served by `respond`. */
async function custom(db: FakeFirestore, patch: Partial<ProductConnection> = {}) {
  const { connection, secret } = await createConnection(ctx, { name: "Acme", kind: "custom" }, db);
  const conn: ProductConnection = {
    ...connection,
    contextEndpoint: { url: "https://api.acme.test/yougrow/context", enabled: true, timeoutMs: 5000 },
    linkDomains: ["acme.test"],
    ...patch,
  };
  return { conn, secret };
}

const goodContext = {
  asOf: "2026-09-21T11:59:00Z",
  steps: [
    { id: "create_brand", label: "Add your brand", done: true, url: "https://app.acme.test/brand" },
    { id: "run_audit", label: "Run an audit", done: false, url: "https://evil.example/phish" },
  ],
  nextStep: { id: "run_audit", label: "Run an audit", url: "https://evil.example/phish" },
  facts: [{ id: "sov", label: "Share of voice", value: 12, unit: "%" }],
  insights: [{ id: "i1", sentence: "Your share of voice is 12%.", factIds: ["sov"] }],
};

describe("fetchProductContext — sandbox (in-process, signed)", () => {
  it("returns the test user's checklist, facts and insights", async () => {
    const db = new FakeFirestore();
    const conn = await sandbox(db);
    const r = await fetchProductContext(conn, { userId: "sandbox_alex", purpose: "test" }, { db, nowMs: NOW });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.context.steps.map((s) => [s.id, s.done])).toEqual([
      ["create_brand", false],
      ["run_audit", false],
      ["monitor_prompts", false],
    ]);
    expect(r.context.nextStep).toMatchObject({ id: "create_brand", url: "https://app.example.com/brand/new" });
    expect(r.context.insights).toHaveLength(2);
    expect(r.warnings).toEqual([]);
  });

  it("reflects a step the sandbox fired through real ingest", async () => {
    const db = new FakeFirestore();
    const conn = await sandbox(db);
    const fired = await fireSandbox(
      ctx,
      conn.id,
      { userId: "sandbox_alex", action: { kind: "step", step: "create_brand" } },
      { origin: "https://yougrow.test", db },
    );
    expect(fired.status).toBe(200);

    const fresh = (await forTenant(ctx, db).productConnections.getById(conn.id))!;
    const r = await fetchProductContext(fresh, { userId: "sandbox_alex", purpose: "test" }, { db, nowMs: NOW });
    expect(r.ok && r.context.nextStep?.id).toBe("run_audit");
  });

  it("answers unknown_user as an http error", async () => {
    const db = new FakeFirestore();
    const conn = await sandbox(db);
    const r = await fetchProductContext(conn, { userId: "nobody", purpose: "test" }, { db, nowMs: NOW });
    expect(r).toMatchObject({ ok: false, error: "http_404" });
  });
});

describe("fetchProductContext — a real product (SSRF-safe transport)", () => {
  it("signs the request, validates the reply and drops links off the allowed domains", async () => {
    const db = new FakeFirestore();
    const { conn, secret } = await custom(db);
    let signatureOk = false;
    const r = await fetchProductContext(
      conn,
      { userId: "u1", purpose: "send" },
      {
        nowMs: NOW,
        fetchImpl: async (_url, init) => {
          const headers = new Headers(init?.headers);
          signatureOk =
            verifySignature({
              secrets: [secret],
              direction: "context",
              timestamp: headers.get(HEADER_TIMESTAMP),
              signature: headers.get(HEADER_SIGNATURE),
              rawBody: String(init?.body),
              nowMs: NOW,
            }).ok === true;
          return new Response(JSON.stringify(goodContext), { status: 200 });
        },
      },
    );

    expect(signatureOk).toBe(true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.context.steps[0]!.url).toBe("https://app.acme.test/brand");
    expect(r.context.steps[1]!.url).toBeNull();
    expect(r.context.nextStep?.url).toBeNull();
    expect(r.warnings).toEqual(["link_dropped:run_audit", "link_dropped:next:run_audit"]);
  });

  it("refuses internal or non-443 URLs before any request", async () => {
    const db = new FakeFirestore();
    for (const url of ["http://api.acme.test/ctx", "https://localhost/ctx", "https://api.acme.test:8443/ctx", "https://10.0.0.5/ctx"]) {
      const { conn } = await custom(db, { contextEndpoint: { url, enabled: true, timeoutMs: 5000 } });
      let called = false;
      const r = await fetchProductContext(conn, { userId: "u1", purpose: "send" }, {
        fetchImpl: async () => {
          called = true;
          return new Response("{}");
        },
      });
      expect(r).toMatchObject({ ok: false, error: "blocked_url" });
      expect(called).toBe(false);
    }
  });

  it("classifies transport and payload failures", async () => {
    const db = new FakeFirestore();
    const { conn } = await custom(db);
    const run = (impl: () => Promise<Response>) =>
      fetchProductContext(conn, { userId: "u1", purpose: "send" }, { fetchImpl: impl });

    expect(await run(async () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })))).toMatchObject({
      error: "timeout",
    });
    expect(await run(async () => Promise.reject(new Error("too_many_redirects")))).toMatchObject({ error: "blocked_url" });
    expect(await run(async () => new Response("nope", { status: 500 }))).toMatchObject({ error: "http_500" });
    expect(await run(async () => new Response("x".repeat(70_000)))).toMatchObject({ error: "too_large" });
    expect(await run(async () => new Response("{not json"))).toMatchObject({ error: "bad_json" });
    expect(await run(async () => new Response(JSON.stringify({ steps: "nope" })))).toMatchObject({ error: "bad_schema" });
  });

  it("does nothing when the endpoint is missing or disabled", async () => {
    const db = new FakeFirestore();
    const { conn } = await custom(db, { contextEndpoint: null });
    expect(await fetchProductContext(conn, { userId: "u1", purpose: "send" })).toMatchObject({ error: "not_configured" });
    const { conn: off } = await custom(db, {
      contextEndpoint: { url: "https://api.acme.test/ctx", enabled: false, timeoutMs: 5000 },
    });
    expect(await fetchProductContext(off, { userId: "u1", purpose: "send" })).toMatchObject({ error: "not_configured" });
  });
});

describe("isAllowedLink", () => {
  it("allows https links on an allowed registrable domain only", () => {
    expect(isAllowedLink("https://app.acme.co.uk/x", ["acme.co.uk"])).toBe(true);
    expect(isAllowedLink("https://acme.co.uk.evil.com/x", ["acme.co.uk"])).toBe(false);
    expect(isAllowedLink("http://app.acme.co.uk/x", ["acme.co.uk"])).toBe(false);
    expect(isAllowedLink("javascript:alert(1)", ["acme.co.uk"])).toBe(false);
  });
});
