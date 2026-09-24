import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant, getConnectionKey } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { __resetIngestCaches } from "./ingestHttp";
import { productUserDocId } from "./profile";
import {
  createProductConnection,
  eraseConnectionUser,
  fireSandbox,
  getConnectionDetail,
  listConnectionEvents,
  listConnectionUsers,
  listConnections,
  patchConnection,
  putSandboxUsers,
  revokeProductConnection,
  rotateProductConnectionSecret,
  testContext,
  testWebhook,
} from "./adminApi";

const ctxA: TenantContext = { tenantId: "ten_A", region: "eu", source: "idtoken", role: "admin", email: "jez@yougrow.test", userId: "usr_1" };
const ctxB: TenantContext = { tenantId: "ten_B", region: "us", source: "idtoken", role: "admin", email: "b@other.test" };
const origin = "https://yougrow.test";

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});
beforeEach(() => {
  process.env.LIFECYCLE_INGEST_ENABLED = "true";
  __resetIngestCaches();
});

type Created = { connection: { id: string; keyId: string; [k: string]: unknown }; secret: string };

async function create(db: FakeFirestore, kind: "custom" | "sandbox", ctx = ctxA) {
  const r = await createProductConnection(ctx, { name: `${kind} one`, kind }, { origin, db });
  expect(r.status).toBe(201);
  return r.body as Created;
}

const fire = (db: FakeFirestore, id: string, action: Record<string, unknown>) =>
  fireSandbox(ctxA, id, { userId: "sandbox_alex", action }, { origin, db });

describe("connections admin API", () => {
  it("creates a sandbox wired to its reference endpoints, with you as the test user", async () => {
    const db = new FakeFirestore();
    const { connection, secret } = await create(db, "sandbox");
    expect(secret).toMatch(/^ygs_/);
    expect(connection).toMatchObject({
      kind: "sandbox",
      contextEndpoint: { url: `${origin}/api/sandbox/context/${connection.id}`, enabled: true },
      webhookEndpoint: { url: `${origin}/api/sandbox/webhook/${connection.id}`, enabled: true },
      linkDomains: ["example.com"],
      sandbox: { users: [{ userId: "sandbox_alex", email: "jez@yougrow.test" }] },
    });
    expect(connection).not.toHaveProperty("secretEnc");
  });

  it("records a custom product's environment, which can be changed later", async () => {
    const db = new FakeFirestore();
    const r = await createProductConnection(ctxA, { name: "App", kind: "custom", environment: "staging" }, { origin, db });
    const { connection } = r.body as { connection: { id: string; environment: string | null } };
    expect(connection.environment).toBe("staging");
    const p = await patchConnection(ctxA, connection.id, { environment: "production" }, db);
    expect(p.status).toBe(200);
    expect((await forTenant(ctxA, db).productConnections.getById(connection.id))?.environment).toBe("production");
    expect((await patchConnection(ctxA, connection.id, { environment: "qa" }, db)).status).toBe(400);
  });

  it("saves an invite sign-up link only on an allowed link domain", async () => {
    const db = new FakeFirestore();
    const r = await createProductConnection(ctxA, { name: "App", kind: "custom", environment: "production" }, { origin, db });
    const { connection } = r.body as { connection: { id: string } };
    const denied = await patchConnection(ctxA, connection.id, { signupUrl: "https://app.fernlight.test/signup" }, db);
    expect(denied).toMatchObject({ status: 400, body: { error: "signup_url_domain_not_allowed", detail: "fernlight.test" } });
    expect((await patchConnection(ctxA, connection.id, { signupUrl: "http://app.fernlight.test/x" }, db)).status).toBe(400);
    const saved = await patchConnection(
      ctxA,
      connection.id,
      { linkDomains: ["fernlight.test"], signupUrl: "https://app.fernlight.test/signup" },
      db,
    );
    expect(saved.status).toBe(200);
    expect((await forTenant(ctxA, db).productConnections.getById(connection.id))?.signupUrl).toBe(
      "https://app.fernlight.test/signup",
    );
    expect((await patchConnection(ctxA, connection.id, { signupUrl: null }, db)).status).toBe(200);
    expect((await forTenant(ctxA, db).productConnections.getById(connection.id))?.signupUrl).toBeNull();
  });

  it("sandboxes have no environment", async () => {
    const db = new FakeFirestore();
    const r = await createProductConnection(ctxA, { name: "Sandbox", kind: "sandbox", environment: "production" }, { origin, db });
    expect((r.body as { connection: { environment: string | null } }).connection.environment).toBeNull();
  });

  it("never lists sealed secrets", async () => {
    const db = new FakeFirestore();
    await create(db, "custom");
    const r = await listConnections(ctxA, db);
    const listed = (r.body as { connections: Record<string, unknown>[] }).connections;
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("secretEnc");
    expect(listed[0]).not.toHaveProperty("prevSecretEnc");
  });

  it("validates endpoint URLs and normalises link domains", async () => {
    const db = new FakeFirestore();
    const { connection } = await create(db, "custom");
    for (const url of ["http://api.acme.test/c", "https://localhost/c", "https://api.acme.test:8443/c"]) {
      const r = await patchConnection(ctxA, connection.id, { contextEndpoint: { url, enabled: true } }, db);
      expect(r.status).toBe(400);
    }
    const good = await patchConnection(
      ctxA,
      connection.id,
      {
        contextEndpoint: { url: "https://api.acme.test/yougrow/context", enabled: true },
        linkDomains: ["https://App.Acme.co.uk/", "acme.co.uk"],
      },
      db,
    );
    expect(good.status).toBe(200);
    expect(good.body).toMatchObject({
      connection: { contextEndpoint: { timeoutMs: 5000 }, linkDomains: ["acme.co.uk"] },
    });
    expect((await patchConnection(ctxA, connection.id, { secretEnc: null }, db)).status).toBe(400);
  });

  it("keeps a sandbox's endpoints fixed", async () => {
    const db = new FakeFirestore();
    const { connection } = await create(db, "sandbox");
    const r = await patchConnection(
      ctxA,
      connection.id,
      { contextEndpoint: { url: "https://api.acme.test/c", enabled: true } },
      db,
    );
    expect(r).toMatchObject({ status: 400, body: { error: "sandbox_endpoints_fixed" } });
  });

  it("rotates (secret shown once) and revokes (routing gone, then 409)", async () => {
    const db = new FakeFirestore();
    const { connection, secret } = await create(db, "custom");
    const rotated = await rotateProductConnectionSecret(ctxA, connection.id, db);
    expect(rotated.status).toBe(200);
    expect((rotated.body as { secret: string }).secret).not.toBe(secret);

    expect((await revokeProductConnection(ctxA, connection.id, db)).status).toBe(200);
    expect(await getConnectionKey(connection.keyId, db)).toBeNull();
    expect((await rotateProductConnectionSecret(ctxA, connection.id, db)).status).toBe(409);
    expect((await patchConnection(ctxA, connection.id, { name: "x" }, db)).status).toBe(409);
  });

  it("hides one tenant's connections from another", async () => {
    const db = new FakeFirestore();
    const { connection } = await create(db, "custom");
    expect((await getConnectionDetail(ctxB, connection.id, db)).status).toBe(404);
    expect((await patchConnection(ctxB, connection.id, { name: "x" }, db)).status).toBe(404);
    expect((await revokeProductConnection(ctxB, connection.id, db)).status).toBe(404);
  });
});

describe("the sandbox end to end", () => {
  it("fires events through real ingest, then lists events and users", async () => {
    const db = new FakeFirestore();
    const { connection } = await create(db, "sandbox");

    const r = await fire(db, connection.id, { kind: "signed_up" });
    expect(r).toMatchObject({ status: 200, body: { accepted: 2, rejected: [] } });

    const events = await listConnectionEvents(ctxA, connection.id, { db });
    expect((events.body as { events: unknown[] }).events).toHaveLength(2);
    const users = await listConnectionUsers(ctxA, connection.id, { db });
    expect((users.body as { users: Array<Record<string, unknown>> }).users[0]).toMatchObject({
      externalUserId: "sandbox_alex",
      email: "jez@yougrow.test",
      consent: { basis: "consent" },
    });
  });

  it("ticks a fired step on the test user and on the product user", async () => {
    const db = new FakeFirestore();
    const { connection } = await create(db, "sandbox");
    await fire(db, connection.id, { kind: "step", step: "run_audit" });

    const conn = (await forTenant(ctxA, db).productConnections.getById(connection.id))!;
    expect(conn.sandbox?.users[0]?.steps).toEqual({ run_audit: true });
    expect(db.raw("product_users", productUserDocId(connection.id, "sandbox_alex"))).toMatchObject({
      steps: { run_audit: { doneAt: expect.any(String) } },
    });
  });

  it("tests the context endpoint and records health", async () => {
    const db = new FakeFirestore();
    const { connection } = await create(db, "sandbox");
    const r = await testContext(ctxA, connection.id, { userId: "sandbox_alex" }, { db });
    expect(r.body).toMatchObject({ ok: true, context: { nextStep: { id: "create_brand" } } });
    const conn = (await forTenant(ctxA, db).productConnections.getById(connection.id))!;
    expect(conn.health).toMatchObject({ consecutiveContextFailures: 0, lastContextOkAt: expect.any(String) });
  });

  it("delivers a signed test webhook into the sandbox inbox", async () => {
    const db = new FakeFirestore();
    const { connection } = await create(db, "sandbox");
    const r = await testWebhook(ctxA, connection.id, db);
    expect(r.body).toEqual({ ok: true, status: 200 });
    const conn = (await forTenant(ctxA, db).productConnections.getById(connection.id))!;
    expect(conn.sandbox?.webhookInbox[0]).toMatchObject({ type: "connection.test" });
  });

  it("limits sandbox recipients to your own address or a verified domain", async () => {
    const db = new FakeFirestore();
    const { connection } = await create(db, "sandbox");
    const user = (email: string, userId = "u") => ({ userId, email });

    expect((await putSandboxUsers(ctxA, connection.id, { users: [user("someone@gmail.com")] }, db)).status).toBe(400);
    expect((await putSandboxUsers(ctxA, connection.id, { users: [user("JEZ@yougrow.test")] }, db)).status).toBe(200);

    db.seed("tenants", "ten_A", {
      tenantName: "A",
      rootDomain: "acme.test",
      status: "active",
      region: "eu",
      allowedOrigins: [],
      billingTier: "pro",
      ownerId: "usr_1",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
      emailSenderConfig: {
        domains: [{ domain: "mail.acme.test", status: "verified", addedAt: "2026-09-01T00:00:00Z" }],
      },
    });
    const ok = await putSandboxUsers(
      ctxA,
      connection.id,
      { users: [user("tester@acme.test", "a"), user("jez@yougrow.test", "b")] },
      db,
    );
    expect(ok.status).toBe(200);
    const dup = await putSandboxUsers(ctxA, connection.id, { users: [user("jez@yougrow.test"), user("jez@yougrow.test")] }, db);
    expect(dup).toMatchObject({ status: 400, body: { error: "duplicate_user_id" } });
  });

  it("erases a user: tombstone, history gone; unknown ids are 404", async () => {
    const db = new FakeFirestore();
    const { connection } = await create(db, "sandbox");
    await fire(db, connection.id, { kind: "signed_up" });
    const puId = productUserDocId(connection.id, "sandbox_alex");

    expect((await eraseConnectionUser(ctxA, connection.id, puId, db)).status).toBe(200);
    expect(db.raw("product_users", puId)).toMatchObject({ status: "deleted", email: null });
    expect(db.dump("product_events")).toHaveLength(0);
    expect((await eraseConnectionUser(ctxA, "pcn_other", puId, db)).status).toBe(404);
    expect((await eraseConnectionUser(ctxB, connection.id, puId, db)).status).toBe(404);
  });
});
