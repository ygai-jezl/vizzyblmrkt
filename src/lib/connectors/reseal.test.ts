import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDataConnection, type NewDataConnection, type TenantContext } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { reportLines, resealBrand } from "./reseal";
import { currentVaultKeyId, openConnectorSecret, sealConnectorSecret, type SealedSecret } from "./vault";

const KEY_OLD = "reseal-test-old-root-0123456789abcdef01234567";
const KEY_NEW = "reseal-test-new-root-fedcba9876543210fedcba98";
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };
const B: TenantContext = { tenantId: "ten_b", region: "us", source: "system" };
const T0 = "2026-11-21T10:00:00.000Z";
const ID1 = "dcn_aaaaaaaaaaaaaaaaaaaa";
const ID2 = "dcn_bbbbbbbbbbbbbbbbbbbb";
const ID3 = "dcn_cccccccccccccccccccc";
const TOKEN1 = "made-up-token-one-000000000000000";
const TOKEN2 = "made-up-token-two-000000000000000";

const conn = (id: string, secrets: Record<string, SealedSecret>): NewDataConnection => ({
  id,
  connectorId: "cloudflare",
  method: "token_fields",
  label: "Cloudflare",
  account: "0123456789abcdef0123456789abcdef",
  ownerUid: "usr_admin",
  grants: [],
  secrets,
  health: { state: "ok", lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null },
  pausedAt: null,
  pausedBy: null,
  status: "connected",
  createdAt: T0,
  updatedAt: T0,
  disconnectedAt: null,
});

let db: FakeFirestore;
let oldKeyId: string;

beforeEach(async () => {
  db = new FakeFirestore();
  vi.stubEnv("CONNECTORS_VAULT_KEY", KEY_OLD);
  vi.stubEnv("CONNECTORS_VAULT_KEY_PREVIOUS", "");
  oldKeyId = currentVaultKeyId()!;
  await createDataConnection(A, conn(ID1, { token: sealConnectorSecret("ten_a", ID1, "token", TOKEN1) }), [], db);
  await createDataConnection(A, conn(ID2, { token: sealConnectorSecret("ten_a", ID2, "token", TOKEN2) }), [], db);
  await createDataConnection(B, conn(ID3, { token: sealConnectorSecret("ten_b", ID3, "token", TOKEN1) }), [], db);
  // Rotate: the old root moves to _PREVIOUS.
  vi.stubEnv("CONNECTORS_VAULT_KEY", KEY_NEW);
  vi.stubEnv("CONNECTORS_VAULT_KEY_PREVIOUS", KEY_OLD);
});
afterEach(() => vi.unstubAllEnvs());

const secretOf = (id: string) => (db.raw("data_connections", id)!.secrets as Record<string, SealedSecret>).token!;

describe("resealBrand", () => {
  it("counts by key id in a dry run, writes nothing and prints no secret", async () => {
    const before = JSON.stringify(db.dump("data_connections"));
    const r = await resealBrand(A, { apply: false, db });
    expect(r).toEqual({ tenantId: "ten_a", connections: 2, secrets: 2, byKeyId: { [oldKeyId]: 2 }, offCurrent: 2, resealed: 0, unopenable: [] });
    expect(JSON.stringify(db.dump("data_connections"))).toBe(before);
    const lines = reportLines(r, false).join("\n");
    expect(lines).toContain(`2 on ${oldKeyId} (previous)`);
    for (const secret of [TOKEN1, TOKEN2, KEY_OLD, KEY_NEW]) expect(lines + JSON.stringify(r)).not.toContain(secret);
  });

  it("with apply, leaves no secret on the old key and every token still opens", async () => {
    const r = await resealBrand(A, { apply: true, db });
    expect(r.resealed).toBe(2);
    expect(r.unopenable).toEqual([]);
    for (const [id, token] of [[ID1, TOKEN1], [ID2, TOKEN2]] as const) {
      expect(secretOf(id).encKeyId).toBe(currentVaultKeyId());
      expect(openConnectorSecret("ten_a", id, "token", secretOf(id))).toBe(token);
    }
    const again = await resealBrand(A, { apply: false, db });
    expect(again.offCurrent).toBe(0);
    expect(again.byKeyId).toEqual({ [currentVaultKeyId()!]: 2 });
    // Another brand's connection is left for its own run.
    expect(secretOf(ID3).encKeyId).toBe(oldKeyId);
  });

  it("reports a secret that won't open and never replaces it", async () => {
    const wrongBrand = sealConnectorSecret("ten_b", ID2, "token", TOKEN2);
    db.seed("data_connections", ID2, { ...db.raw("data_connections", ID2)!, secrets: { token: wrongBrand } });
    const dry = await resealBrand(A, { apply: false, db });
    expect(dry.unopenable).toEqual([]); // sealed under the new key already: nothing to move
    vi.stubEnv("CONNECTORS_VAULT_KEY_PREVIOUS", "");
    const r = await resealBrand(A, { apply: true, db });
    expect(r.unopenable).toEqual([{ connectionId: ID1, slot: "token", why: "unknown_key" }]);
    expect(r.resealed).toBe(0);
    expect(secretOf(ID1).encKeyId).toBe(oldKeyId);
    expect(reportLines(r, true).join("\n")).toContain(`${ID1} token won't open (unknown_key); left as it is`);
  });

  it("refuses to apply with no current key", async () => {
    vi.stubEnv("CONNECTORS_VAULT_KEY", "");
    await expect(resealBrand(A, { apply: true, db })).rejects.toThrow("connectors_vault_key_unconfigured");
  });
});
