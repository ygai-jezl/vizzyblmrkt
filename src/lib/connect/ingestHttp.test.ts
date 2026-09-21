import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant/types";
import { createConnection, revokeConnection, rotateConnectionSecret } from "./keys";
import { handleIngestRequest, invalidateConnectionCaches, __resetIngestCaches } from "./ingestHttp";
import { signedHeaders, LIMITS } from "./protocol";
import { productUserDocId } from "./profile";

const ctxA: TenantContext = { tenantId: "ten_A", region: "eu", source: "system" };
const ctxB: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };
const NOW = Date.parse("2026-09-21T12:00:00Z");

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});
beforeEach(() => {
  process.env.LIFECYCLE_INGEST_ENABLED = "true";
  __resetIngestCaches();
  __resetRateLimitState();
});

function request(keyId: string, secret: string, body: unknown, opts: { nowMs?: number } = {}): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("https://yougrow.ai/api/v1/events", {
    method: "POST",
    headers: signedHeaders(keyId, secret, "events", raw, opts.nowMs ?? NOW),
    body: raw,
  });
}

const identify = (messageId: string, userId: string, traits: Record<string, unknown>) => ({
  type: "identify",
  messageId,
  userId,
  timestamp: "2026-09-21T11:00:00Z",
  traits,
});
const track = (messageId: string, userId: string, event: string, properties: Record<string, unknown> = {}) => ({
  type: "track",
  messageId,
  userId,
  timestamp: "2026-09-21T11:05:00Z",
  event,
  properties,
});

async function setup(ctx: TenantContext = ctxA) {
  const db = new FakeFirestore();
  const { connection, secret } = await createConnection(ctx, { name: "vizzybl.ai", kind: "custom" }, db);
  const deps = { db, nowMs: () => NOW };
  return { db, connection, secret, deps };
}

async function body(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("POST /api/v1/events", () => {
  it("accepts a signed batch and builds the product user", async () => {
    const { db, connection, secret, deps } = await setup();
    const res = await handleIngestRequest(
      request(connection.keyId, secret, {
        batch: [
          identify("m1", "u1", { email: "alex@acme.test", first_name: "Alex", plan: "pro" }),
          track("m2", "u1", "user.signed_up"),
          track("m3", "u1", "onboarding.step_completed", { step: "create_brand" }),
        ],
      }),
      deps,
    );

    expect(res.status).toBe(202);
    expect(await body(res)).toEqual({ accepted: 3, duplicates: 0, rejected: [] });
    expect(db.raw("product_users", productUserDocId(connection.id, "u1"))).toMatchObject({
      tenantId: "ten_A",
      email: "alex@acme.test",
      firstName: "Alex",
      traits: { plan: "pro" },
      steps: { create_brand: { doneAt: "2026-09-21T11:05:00.000Z" } },
    });
    expect(db.dump("product_events")).toHaveLength(3);
    expect(db.raw("connection_diagnostics", connection.id)).toMatchObject({
      observedEvents: { "user.signed_up": { count: 1 } },
      observedTraits: { email: { type: "string" }, plan: { type: "string" } },
    });
  });

  it("is idempotent: replaying a batch changes nothing", async () => {
    const { db, connection, secret, deps } = await setup();
    const batch = { batch: [identify("m1", "u1", { email: "alex@acme.test" }), track("m2", "u1", "user.signed_up")] };
    await handleIngestRequest(request(connection.keyId, secret, batch), deps);
    const res = await handleIngestRequest(request(connection.keyId, secret, batch), deps);

    expect(await body(res)).toEqual({ accepted: 0, duplicates: 2, rejected: [] });
    expect(db.dump("product_events")).toHaveLength(2);
    expect(db.raw("product_users", productUserDocId(connection.id, "u1"))).toMatchObject({
      milestones: { "user.signed_up": { count: 1 } },
    });
  });

  it("rejects bad messages individually and keeps the rest", async () => {
    const { db, connection, secret, deps } = await setup();
    const res = await handleIngestRequest(
      request(connection.keyId, secret, {
        batch: [
          identify("m1", "u1", { email: "alex@acme.test" }),
          { type: "track", messageId: "m2", userId: "u1", event: "Bad Name", timestamp: "2026-09-21T11:00:00Z" },
          identify("m3", "u1", { email: "not-an-email" }),
          { ...identify("m4", "u1", { plan: "x" }), timestamp: "2026-09-30T00:00:00Z" },
        ],
      }),
      deps,
    );
    const b = await body(res);
    expect(res.status).toBe(202);
    expect(b.accepted).toBe(1);
    expect(b.rejected).toEqual([
      { index: 1, messageId: "m2", reason: expect.stringContaining("event") },
      { index: 2, messageId: "m3", reason: "invalid_email" },
      { index: 3, messageId: "m4", reason: "timestamp_in_future" },
    ]);
    const diag = db.raw("connection_diagnostics", connection.id) as { recentRejections: unknown[] };
    expect(diag.recentRejections).toHaveLength(3);
  });

  it("refuses a bad signature, writes nothing, and never touches the rate limiter", async () => {
    const { db, connection, deps } = await setup();
    const rateLimit = vi.fn(async () => false);
    const res = await handleIngestRequest(
      request(connection.keyId, "ygs_forged_secret", { batch: [identify("m1", "u1", {})] }),
      { ...deps, rateLimit },
    );
    expect(res.status).toBe(401);
    expect(await body(res)).toEqual({ error: "bad_signature" });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(db.dump("product_events")).toHaveLength(0);
  });

  it("refuses a request signed outside the ±5 minute window", async () => {
    const { connection, secret, deps } = await setup();
    const res = await handleIngestRequest(
      request(connection.keyId, secret, { batch: [identify("m1", "u1", {})] }, { nowMs: NOW - 6 * 60_000 }),
      deps,
    );
    expect(res.status).toBe(401);
    expect(await body(res)).toEqual({ error: "stale_timestamp" });
  });

  it("refuses unknown and revoked keys alike", async () => {
    const { connection, secret, deps, db } = await setup();
    const unknown = await handleIngestRequest(request("ygk_nope", secret, { batch: [] }), deps);
    expect(unknown.status).toBe(401);

    await revokeConnection(ctxA, connection.id, db);
    invalidateConnectionCaches(connection.keyId, "ten_A", connection.id);
    const revoked = await handleIngestRequest(
      request(connection.keyId, secret, { batch: [identify("m1", "u1", {})] }),
      deps,
    );
    expect(revoked.status).toBe(401);
    expect(await body(revoked)).toEqual({ error: "unknown_key" });
  });

  it("returns 503 when ingest is switched off", async () => {
    process.env.LIFECYCLE_INGEST_ENABLED = "false";
    const { connection, secret, deps } = await setup();
    const res = await handleIngestRequest(request(connection.keyId, secret, { batch: [] }), deps);
    expect(res.status).toBe(503);
  });

  it("enforces the body and batch size limits", async () => {
    const { connection, secret, deps } = await setup();
    const huge = JSON.stringify({ batch: [identify("m1", "u1", { note: "x".repeat(400) })], pad: "y".repeat(LIMITS.maxBodyBytes) });
    expect((await handleIngestRequest(request(connection.keyId, secret, huge), deps)).status).toBe(413);

    const many = { batch: Array.from({ length: 101 }, (_, i) => identify(`m${i}`, "u1", {})) };
    const res = await handleIngestRequest(request(connection.keyId, secret, many), deps);
    expect(res.status).toBe(413);
    expect(await body(res)).toMatchObject({ error: "batch_too_large" });
  });

  it("rejects signed but malformed JSON", async () => {
    const { connection, secret, deps } = await setup();
    const res = await handleIngestRequest(request(connection.keyId, secret, "{not json"), deps);
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: "invalid_json" });
  });

  it("rate-limits per key after the signature verifies", async () => {
    const { connection, secret, deps } = await setup();
    const res = await handleIngestRequest(request(connection.keyId, secret, { batch: [identify("m1", "u1", {})] }), {
      ...deps,
      rateLimit: async () => true,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("scopes everything to the key's tenant", async () => {
    const db = new FakeFirestore();
    const a = await createConnection(ctxA, { name: "a", kind: "custom" }, db);
    await createConnection(ctxB, { name: "b", kind: "custom" }, db);

    await handleIngestRequest(request(a.connection.keyId, a.secret, { batch: [identify("m1", "u1", { plan: "x" })] }), {
      db,
      nowMs: () => NOW,
    });

    const users = db.dump("product_users");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ tenantId: "ten_A", connectionId: a.connection.id });
  });

  it("erases a deleted user's history and blocks late events", async () => {
    const { db, connection, secret, deps } = await setup();
    await handleIngestRequest(
      request(connection.keyId, secret, {
        batch: [identify("m1", "u1", { email: "alex@acme.test" }), track("m2", "u1", "user.signed_up")],
      }),
      deps,
    );
    await handleIngestRequest(request(connection.keyId, secret, { batch: [track("m3", "u1", "user.deleted")] }), deps);

    const puId = productUserDocId(connection.id, "u1");
    expect(db.raw("product_users", puId)).toMatchObject({ status: "deleted", email: null });
    expect(db.dump("product_events").filter((e) => e.productUserId === puId)).toHaveLength(0);

    const late = await handleIngestRequest(
      request(connection.keyId, secret, { batch: [identify("m4", "u1", { email: "alex@acme.test" })] }),
      deps,
    );
    expect(await body(late)).toMatchObject({ accepted: 0, rejected: [{ reason: "user_deleted" }] });
  });

  it("accepts both secrets during a rotation overlap", async () => {
    const { db, connection, secret: oldSecret, deps } = await setup();
    const rotated = (await rotateConnectionSecret(ctxA, connection.id, db, NOW))!;
    invalidateConnectionCaches(connection.keyId, "ten_A", connection.id);

    const viaOld = await handleIngestRequest(request(connection.keyId, oldSecret, { batch: [identify("m1", "u1", {})] }), deps);
    const viaNew = await handleIngestRequest(
      request(connection.keyId, rotated.secret, { batch: [identify("m2", "u1", {})] }),
      deps,
    );
    expect(viaOld.status).toBe(202);
    expect(viaNew.status).toBe(202);
  });
});
