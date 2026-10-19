import { describe, it, expect } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { sealTenantMailchimpKey } from "./control";

const BLOB = { ct: "Y3Q=", iv: "aXY=", tag: "dGFn" };

function seeded(mailchimpConfig?: Record<string, unknown>): FakeFirestore {
  const db = new FakeFirestore();
  db.seed("tenants", "ten_A", {
    tenantName: "Example Co",
    rootDomain: "example.com",
    status: "active",
    region: "us",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...(mailchimpConfig ? { mailchimpConfig } : {}),
  });
  return db;
}

describe("sealTenantMailchimpKey", () => {
  it("swaps the plain key for the sealed one and keeps the rest of the config", async () => {
    const db = seeded({ requiresOwnApiKey: true, apiKey: " tk-us1 ", audienceId: "aud_1" });
    const seen: string[] = [];
    const did = await sealTenantMailchimpKey("ten_A", (k) => (seen.push(k), BLOB), db);

    expect(did).toBe(true);
    expect(seen).toEqual(["tk-us1"]);
    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.mailchimpConfig).toEqual({
      requiresOwnApiKey: true,
      apiKeyEnc: BLOB,
      audienceId: "aud_1",
    });
    expect(raw.updatedAt).not.toBe("2026-09-01T00:00:00.000Z");
  });

  it("leaves a sealed key, no key and no config alone", async () => {
    const never = () => {
      throw new Error("should not seal");
    };
    for (const cfg of [
      { requiresOwnApiKey: false, apiKeyEnc: BLOB },
      { requiresOwnApiKey: false, apiKey: "   " },
      undefined,
    ]) {
      const db = seeded(cfg);
      expect(await sealTenantMailchimpKey("ten_A", never, db)).toBe(false);
      expect(db.raw("tenants", "ten_A")!.updatedAt).toBe("2026-09-01T00:00:00.000Z");
    }
  });

  it("writes nothing when sealing throws", async () => {
    const db = seeded({ requiresOwnApiKey: false, apiKey: "tk-us1" });
    await expect(
      sealTenantMailchimpKey(
        "ten_A",
        () => {
          throw new Error("round_trip_mismatch");
        },
        db,
      ),
    ).rejects.toThrow("round_trip_mismatch");
    expect(db.raw("tenants", "ten_A")!.mailchimpConfig).toEqual({
      requiresOwnApiKey: false,
      apiKey: "tk-us1",
    });
  });
});
