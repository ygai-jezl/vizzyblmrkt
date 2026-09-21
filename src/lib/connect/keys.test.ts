import { describe, it, expect, beforeAll } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant, getConnectionKey } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import {
  createConnection,
  connectionSecrets,
  currentSecret,
  rotateConnectionSecret,
  revokeConnection,
  ROTATION_OVERLAP_MS,
} from "./keys";

const ctxA: TenantContext = { tenantId: "ten_A", region: "eu", source: "system" };
const ctxB: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});

describe("connection credentials", () => {
  it("creates the regional record + control-plane routing, returning the secret once", async () => {
    const db = new FakeFirestore();
    const { connection, secret } = await createConnection(
      ctxA,
      { name: "vizzybl.ai", kind: "custom", createdBy: "usr_1" },
      db,
    );

    expect(connection.id).toMatch(/^pcn_[a-z2-7]{20}$/);
    expect(connection.keyId).toMatch(/^ygk_[a-z2-7]{24}$/);
    expect(secret).toMatch(/^ygs_[A-Za-z0-9_-]{43}$/);
    expect(connection.secretPrefix).toBe(secret.slice(0, 10));
    // Never at rest in plaintext.
    expect(JSON.stringify(db.raw("product_connections", connection.id))).not.toContain(secret);
    expect(await getConnectionKey(connection.keyId, db)).toMatchObject({
      tenantId: "ten_A",
      region: "eu",
      connectionId: connection.id,
    });
    expect(connectionSecrets(connection)).toEqual([secret]);
  });

  it("binds the sealed secret to its tenant + connection (a copied blob won't open)", async () => {
    const db = new FakeFirestore();
    const { connection } = await createConnection(ctxA, { name: "a", kind: "custom" }, db);
    const moved = { ...connection, id: "pcn_someotherconnection0" };
    expect(() => connectionSecrets(moved)).toThrow();
    const reHomed = { ...connection, tenantId: "ten_B" };
    expect(() => currentSecret(reHomed)).toThrow();
  });

  it("keeps the previous secret valid during the rotation overlap only", async () => {
    const db = new FakeFirestore();
    const { connection, secret: oldSecret } = await createConnection(
      ctxA,
      { name: "a", kind: "custom" },
      db,
    );
    const now = Date.now();
    const rotated = await rotateConnectionSecret(ctxA, connection.id, db, now);
    expect(rotated).not.toBeNull();
    const fresh = (await forTenant(ctxA, db).productConnections.getById(connection.id))!;

    expect(connectionSecrets(fresh, now + 1000)).toEqual([rotated!.secret, oldSecret]);
    expect(connectionSecrets(fresh, now + ROTATION_OVERLAP_MS + 1)).toEqual([rotated!.secret]);
    expect(fresh.keyId).toBe(connection.keyId); // the key id never changes
  });

  it("revokes: routing removed, secrets destroyed, record kept for audit", async () => {
    const db = new FakeFirestore();
    const { connection } = await createConnection(ctxA, { name: "a", kind: "custom" }, db);

    expect(await revokeConnection(ctxA, connection.id, db)).toBe(true);

    expect(await getConnectionKey(connection.keyId, db)).toBeNull();
    const after = (await forTenant(ctxA, db).productConnections.getById(connection.id))!;
    expect(after).toMatchObject({ status: "revoked", secretEnc: null, prevSecretEnc: null });
    expect(connectionSecrets(after)).toEqual([]);
    expect(await rotateConnectionSecret(ctxA, connection.id, db)).toBeNull();
  });

  it("never lets another tenant revoke or rotate a connection", async () => {
    const db = new FakeFirestore();
    const { connection } = await createConnection(ctxA, { name: "a", kind: "custom" }, db);

    expect(await revokeConnection(ctxB, connection.id, db)).toBe(false);
    expect(await rotateConnectionSecret(ctxB, connection.id, db)).toBeNull();
    expect(await getConnectionKey(connection.keyId, db)).not.toBeNull();
  });

  it("gives a sandbox connection its sandbox block", async () => {
    const db = new FakeFirestore();
    const { connection } = await createConnection(ctxA, { name: "s", kind: "sandbox" }, db);
    expect(connection.sandbox).toEqual({ users: [], webhookInbox: [] });
  });
});
