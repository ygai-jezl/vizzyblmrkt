import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { enrolmentDocId } from "@/lib/lifecycle/enrol";
import { ctx as lifecycleCtx, publishOnboarding, seedWorld, T0 } from "@/lib/lifecycle/testing/fixtures";
import { createConnection, revokeConnection, rotateConnectionSecret } from "../keys";
import { __resetConnectionCaches, invalidateConnectionCaches } from "../connectionAuth";
import { productUserDocId } from "../profile";
import { SANDBOX_CATALOG } from "../sandbox";
import { handleBatch, handleDeleteUser, handleGetUser, handlePatchUser, handleUserEvent, type V2HttpDeps } from "./http";

const ctxA: TenantContext = { tenantId: "ten_A", region: "eu", source: "system" };
const ctxB: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };
const NOW = Date.parse("2026-09-25T12:00:00Z");

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});
beforeEach(() => {
  process.env.API_V2_ENABLED = "true";
  __resetConnectionCaches();
  __resetRateLimitState();
});
afterEach(() => {
  delete process.env.API_V2_ENABLED;
  delete process.env.LIFECYCLE_ENABLED;
});

type Auth = { keyId: string; secret: string };

function request(method: string, auth: Auth | null, body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = `Basic ${Buffer.from(`${auth.keyId}:${auth.secret}`).toString("base64")}`;
  return new Request("https://yougrow.test/api/v2/users/x", {
    method,
    headers,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function setup(ctx: TenantContext = ctxA, db = new FakeFirestore()) {
  const { connection, secret } = await createConnection(ctx, { name: "Acme", kind: "custom" }, db);
  const auth = { keyId: connection.keyId, secret };
  let now = NOW;
  const deps: V2HttpDeps = { db, nowMs: () => now };
  const patch = (userId: string, body: unknown) => handlePatchUser(request("PATCH", auth, body), userId, deps);
  const get = (userId: string) => handleGetUser(request("GET", auth), userId, deps);
  const del = (userId: string) => handleDeleteUser(request("DELETE", auth), userId, deps);
  return { db, connection, secret, auth, deps, patch, get, del, setNow: (ms: number) => (now = ms) };
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("API v2 auth and gate", () => {
  it("is off (404) until API_V2_ENABLED is on", async () => {
    const w = await setup();
    delete process.env.API_V2_ENABLED;
    expect((await w.patch("u_1", { email: "a@example.com" })).status).toBe(404);
  });

  it("needs Basic auth with the right key id and secret", async () => {
    const w = await setup();
    const noAuth = await handlePatchUser(request("PATCH", null, {}), "u_1", w.deps);
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("www-authenticate")).toContain("Basic");
    expect((await handlePatchUser(request("PATCH", { keyId: w.auth.keyId, secret: "ygs_wrong" }, {}), "u_1", w.deps)).status).toBe(401);
    expect((await handlePatchUser(request("PATCH", { keyId: "ygk_nope", secret: w.secret }, {}), "u_1", w.deps)).status).toBe(401);
  });

  it("stops accepting a revoked key, and accepts the previous secret for a day after a rotation", async () => {
    const w = await setup();
    const rotated = await rotateConnectionSecret(ctxA, w.connection.id, w.db, NOW);
    invalidateConnectionCaches(w.connection.keyId, ctxA.tenantId, w.connection.id);
    expect((await w.patch("u_1", { firstName: "Old secret" })).status).toBe(200);
    const fresh = await handlePatchUser(request("PATCH", { keyId: w.auth.keyId, secret: rotated!.secret }, { firstName: "New" }), "u_1", w.deps);
    expect(fresh.status).toBe(200);
    await revokeConnection(ctxA, w.connection.id, w.db);
    invalidateConnectionCaches(w.connection.keyId, ctxA.tenantId, w.connection.id);
    expect((await w.patch("u_1", { firstName: "x" })).status).toBe(401);
  });

  it("rate-limits per key after auth, with Retry-After", async () => {
    const w = await setup();
    const res = await handlePatchUser(request("PATCH", w.auth, { firstName: "A" }), "u_1", { ...w.deps, rateLimit: async () => true });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("refuses bodies over 512 KB", async () => {
    const w = await setup();
    const res = await w.patch("u_1", JSON.stringify({ traits: { big: "x".repeat(600 * 1024) } }));
    expect(res.status).toBe(413);
  });
});

describe("PATCH /api/v2/users/{userId}", () => {
  it("creates and merges the user's state; GET returns it", async () => {
    const w = await setup();
    const created = await w.patch("u_1", { email: "alex@example.com", firstName: "Alex", traits: { plan: "pro", role: "admin" }, consent: "consent" });
    expect(created.status).toBe(200);
    expect(await json(created)).toMatchObject({ applied: true, user: { userId: "u_1", email: "alex@example.com", subscribed: true } });
    await w.patch("u_1", { traits: { role: "editor" }, facts: { sov: 12 }, subscribed: false });
    const got = await json(await w.get("u_1"));
    expect(got).toMatchObject({ userId: "u_1", firstName: "Alex", traits: { plan: "pro", role: "editor" }, facts: { sov: 12 }, subscribed: false, enrolments: [], optOuts: [] });
  });

  it("answers 400 naming the fields that are wrong", async () => {
    const w = await setup();
    const res = await w.patch("u_1", { subscribed: "false", nope: 1 });
    expect(res.status).toBe(400);
    const b = await json(res);
    expect(b.error).toBe("invalid");
    expect(JSON.stringify(b.fields)).toContain("subscribed");
    expect(JSON.stringify(b.fields)).toContain("nope");
    expect((await w.patch("batch", { firstName: "x" })).status).toBe(400); // reserved id
    expect((await w.patch("u_1", "{not json")).status).toBe(400);
  });

  it("skips a stale write with a 200 that says so", async () => {
    const w = await setup();
    await w.patch("u_1", { firstName: "New", updatedAt: "2026-09-25T11:00:00Z" });
    const res = await w.patch("u_1", { firstName: "Old", updatedAt: "2026-09-25T10:00:00Z" });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ applied: false, reason: "stale_write", storedUpdatedAt: "2026-09-25T11:00:00.000Z", user: { firstName: "New" } });
  });

  it("is tenant-scoped by the key: another tenant's key can't see the user", async () => {
    const db = new FakeFirestore();
    const a = await setup(ctxA, db);
    const b = await setup(ctxB, db);
    await a.patch("u_1", { email: "alex@example.com" });
    expect((await b.get("u_1")).status).toBe(404);
  });
});

describe("DELETE /api/v2/users/{userId}", () => {
  it("erases the user (204, repeatable) and leaves a tombstone without the user id", async () => {
    const w = await setup();
    await w.patch("u_1", { email: "alex@example.com", traits: { plan: "pro" } });
    expect((await w.del("u_1")).status).toBe(204);
    expect((await w.get("u_1")).status).toBe(404);
    expect((await w.del("u_1")).status).toBe(204);
    const tomb = await forTenant(ctxA, w.db).productUsers.getById(productUserDocId(w.connection.id, "u_1"));
    expect(tomb).toMatchObject({ status: "deleted", externalUserId: "", email: null });
    const events = await forTenant(ctxA, w.db).productEvents.find({ where: [["productUserId", "==", tomb!.id]], limit: 10 });
    expect(events).toHaveLength(0);
  });

  it("ignores a late write older than the deletion, and starts a fresh person on a newer one", async () => {
    const w = await setup();
    await w.patch("u_1", { email: "alex@example.com" });
    await w.del("u_1");
    const late = await w.patch("u_1", { firstName: "Ghost", updatedAt: "2026-09-25T11:00:00Z" });
    expect(await json(late)).toEqual({ applied: false, reason: "deleted_later", storedUpdatedAt: null });
    w.setNow(NOW + 3600_000);
    const fresh = await w.patch("u_1", { email: "back@example.com", updatedAt: "2026-09-25T12:30:00Z" });
    expect(await json(fresh)).toMatchObject({ applied: true, user: { email: "back@example.com", traits: {} } });
  });

  it("records a tombstone for a user it never saw", async () => {
    const w = await setup();
    expect((await w.del("u_never")).status).toBe(204);
    const late = await w.patch("u_never", { firstName: "Late", updatedAt: "2026-09-25T11:00:00Z" });
    expect(await json(late)).toMatchObject({ applied: false, reason: "deleted_later" });
  });
});

describe("POST /api/v2/users/batch", () => {
  it("applies item by item and reports only the ignored and failed ones", async () => {
    const w = await setup();
    await w.patch("u_2", { firstName: "New", updatedAt: "2026-09-25T11:00:00Z" });
    const res = await handleBatch(
      request("POST", w.auth, {
        users: [
          { userId: "u_1", email: "one@example.com" },
          { userId: "u_2", firstName: "Old", updatedAt: "2026-09-25T10:00:00Z" },
          { userId: "u_3", timezone: "Mars/Olympus" },
          { email: "no-id@example.com" },
        ],
      }),
      w.deps,
    );
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b).toMatchObject({ applied: 1, ignored: 1, failed: 2 });
    expect(b.results).toMatchObject([
      { index: 1, userId: "u_2", status: "ignored", reason: "stale_write" },
      { index: 2, userId: "u_3", status: "failed", reason: "invalid" },
      { index: 3, userId: null, status: "failed", reason: "invalid" },
    ]);
    expect((await w.get("u_1")).status).toBe(200);
  });

  it("refuses a malformed batch, or more than 100 users, as a whole", async () => {
    const w = await setup();
    const tooMany = { users: Array.from({ length: 101 }, (_, i) => ({ userId: `u_${i}` })) };
    expect((await handleBatch(request("POST", w.auth, tooMany), w.deps)).status).toBe(400);
    expect((await handleBatch(request("POST", w.auth, { people: [] }), w.deps)).status).toBe(400);
  });
});

describe("POST /api/v2/users/{userId}/events", () => {
  it("records a milestone once per idempotency key, for a user YouGrow holds", async () => {
    const w = await setup();
    const send = (body: unknown) => handleUserEvent(request("POST", w.auth, body), "u_1", w.deps);
    expect((await send({ event: "report.exported" })).status).toBe(404);
    await w.patch("u_1", { email: "alex@example.com" });
    expect(await json(await send({ event: "report.exported", idempotencyKey: "k1" }))).toEqual({ recorded: true, duplicate: false });
    expect(await json(await send({ event: "report.exported", idempotencyKey: "k1" }))).toEqual({ recorded: false, duplicate: true });
    expect((await send({ event: "user.signed_up" })).status).toBe(400);
  });
});

describe("sign-up enrolment through the API", () => {
  it("enrols on the write that carries signedUpAt, and a retry doesn't enrol twice", async () => {
    process.env.LIFECYCLE_ENABLED = "true";
    const db = new FakeFirestore();
    seedWorld(db);
    const { connection, secret } = await createConnection(lifecycleCtx, { name: "Acme", kind: "custom", catalog: SANDBOX_CATALOG }, db);
    const { journey } = await publishOnboarding(db, { mode: "live", connectionId: connection.id });
    const auth = { keyId: connection.keyId, secret };
    const deps: V2HttpDeps = { db, nowMs: () => T0 + 60_000 };
    const body = { email: "alex@example.com", signedUpAt: new Date(T0).toISOString(), consent: "consent" };
    expect((await handlePatchUser(request("PATCH", auth, body), "alex", deps)).status).toBe(200);
    expect((await handlePatchUser(request("PATCH", auth, body), "alex", deps)).status).toBe(200);
    const id = enrolmentDocId(journey.id, productUserDocId(connection.id, "alex"));
    expect(await forTenant(lifecycleCtx, db).lifecycleEnrolments.getById(id)).toMatchObject({ status: "active", anchorAt: new Date(T0).toISOString() });
    const view = await json(await handleGetUser(request("GET", auth), "alex", deps));
    expect(view.enrolments).toMatchObject([{ journeyId: journey.id, status: "active", mode: "live" }]);
  });
});
