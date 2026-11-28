import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { countTenants, getTenantPageRow, listTenantPage, tenantPageRow } from "./registry";

/** A page of brands for the loops lane (learning loops step 4): id order, a cursor, and only the fields it needs. */

function seeded(): FakeFirestore {
  const db = new FakeFirestore();
  for (const id of ["ten_c", "ten_a", "ten_b"]) {
    db.seed("tenants", id, {
      tenantName: `Brand ${id}`,
      rootDomain: `${id}.example.com`,
      status: id === "ten_b" ? "suspended" : "active",
      region: id === "ten_a" ? "eu" : "us",
      allowedOrigins: [],
      ownerId: "usr_owner",
      organisationId: "org_lumen",
      grantedFeatures: ["edit_vizzy"],
      brandVoice: { summary: "Warm" },
      brandKit: { learnedImageStyle: "Warm light.", learnedImageStyleUpdatedAt: "2026-12-01T09:00:00.000Z", logoUrl: "https://cdn.example.com/logo.png" },
      imageStyle: { defaultStyleId: "natural_photo", learned: { natural_photo: { directive: "Overhead daylight.", sampleCount: 3, updatedAt: "2026-12-02T09:00:00.000Z" } } },
    });
  }
  return db;
}

describe("listTenantPage", () => {
  it("pages through brands in id order from a cursor, with only the fields the lane needs", async () => {
    const db = seeded();
    const first = await listTenantPage(null, 2, db);
    expect(first.map((r) => r.id)).toEqual(["ten_a", "ten_b"]);
    expect(first[0]).toEqual({
      id: "ten_a",
      region: "eu",
      status: "active",
      organisationId: "org_lumen",
      orgPlan: null,
      grantedFeatures: ["edit_vizzy"],
      learnedImageStyle: "Warm light.",
      learnedImageStyleUpdatedAt: "2026-12-01T09:00:00.000Z",
      styleLooks: { natural_photo: { directive: "Overhead daylight.", updatedAt: "2026-12-02T09:00:00.000Z" } },
    });
    expect(first[1]?.status).toBe("suspended");
    expect((await listTenantPage("ten_b", 2, db)).map((r) => r.id)).toEqual(["ten_c"]);
    expect(await listTenantPage("ten_c", 2, db)).toEqual([]);
    expect(await countTenants(db)).toBe(3);
    expect((await getTenantPageRow("ten_c", db))?.learnedImageStyle).toBe("Warm light.");
    expect(await getTenantPageRow("ten_missing", db)).toBeNull();
  });

  it("leaves out a brand with no readable region", () => {
    expect(tenantPageRow("ten_x", { region: "mars" })).toBeNull();
  });
});
