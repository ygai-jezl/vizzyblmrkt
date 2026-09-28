import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import type { z } from "zod";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { ConnectionCatalogSchema } from "@/lib/types/productConnection";
import { __resetConnectionCaches } from "./connectionAuth";
import { createProductConnection, getCatalogHistory, getConnectionDetail, patchConnection, restoreCatalogVersion } from "./adminApi";
import { HISTORY_KEEP } from "./catalogHistory";

const ctx: TenantContext = { tenantId: "ten_A", region: "eu", source: "idtoken", role: "admin", email: "jez@yougrow.test", userId: "usr_1" };
const origin = "https://yougrow.test";

const cat = (c: z.input<typeof ConnectionCatalogSchema>) => ConnectionCatalogSchema.parse(c);
const C0 = cat({
  onboardingSteps: [
    { id: "create_brand", label: "Add your brand", order: 0 },
    { id: "run_audit", label: "Run an audit", order: 1 },
  ],
});

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});
beforeEach(() => {
  __resetConnectionCaches();
  process.env.CATALOG_HISTORY_ENABLED = "true";
});
afterEach(() => {
  delete process.env.CATALOG_HISTORY_ENABLED;
});

/** A product whose catalog is C0 (version 1: the first save). */
async function world() {
  const db = new FakeFirestore();
  const r = await createProductConnection(ctx, { name: "App", kind: "custom" }, { origin, db });
  const id = (r.body as { connection: { id: string } }).connection.id;
  expect((await patchConnection(ctx, id, { catalog: C0, catalogRev: 0 }, db)).status).toBe(200);
  return { db, id };
}

type Versions = { versions: Array<{ rev: number; source: string; savedBy: string | null; restoredFrom: number | null; changes: string[] }> };

describe("catalog history", () => {
  it("keeps each saved version, with what changed and who saved it, plus the catalog from before history", async () => {
    const { db, id } = await world();
    const next = cat({ ...C0, onboardingSteps: [...C0.onboardingSteps, { id: "invite_team", label: "Invite your team", order: 2 }] });
    await patchConnection(ctx, id, { catalog: next, catalogRev: 1 }, db);
    const r = await getCatalogHistory(ctx, id, db);
    expect(r.status).toBe(200);
    expect((r.body as Versions).versions).toEqual([
      { rev: 2, savedAt: expect.any(String), source: "editor", savedBy: "jez@yougrow.test", restoredFrom: null, changes: ["Added step ‘Invite your team’"] },
      { rev: 1, savedAt: expect.any(String), source: "editor", savedBy: "jez@yougrow.test", restoredFrom: null, changes: ["Added step ‘Add your brand’", "Added step ‘Run an audit’"] },
      { rev: 0, savedAt: expect.any(String), source: "before_history", savedBy: null, restoredFrom: null, changes: [] },
    ]);
  });

  it("restores an earlier version as a new one, so nothing is lost", async () => {
    const { db, id } = await world();
    const renamed = cat({ ...C0, onboardingSteps: [{ ...C0.onboardingSteps[0]!, label: "Add a brand" }, C0.onboardingSteps[1]!] });
    await patchConnection(ctx, id, { catalog: renamed, catalogRev: 1 }, db);

    const r = await restoreCatalogVersion(ctx, id, 1, { catalogRev: 2 }, db);
    expect(r).toMatchObject({ status: 200, body: { connection: { catalogRev: 3, catalog: C0 } } });
    const [latest] = ((await getCatalogHistory(ctx, id, db)).body as Versions).versions;
    expect(latest).toMatchObject({ rev: 3, source: "restore", restoredFrom: 1, changes: ["Renamed step ‘Add a brand’ to ‘Add your brand’"] });
  });

  it("refuses a restore from an out-of-date page, or of a version it doesn't keep", async () => {
    const { db, id } = await world();
    expect(await restoreCatalogVersion(ctx, id, 0, { catalogRev: 0 }, db)).toMatchObject({ status: 409, body: { error: "catalog_changed", catalogRev: 1 } });
    expect(await restoreCatalogVersion(ctx, id, 7, { catalogRev: 1 }, db)).toMatchObject({ status: 404, body: { error: "version_not_found" } });
    expect(await restoreCatalogVersion(ctx, id, 0, {}, db)).toMatchObject({ status: 400 });
  });

  it(`keeps the last ${HISTORY_KEEP} versions`, async () => {
    const { db, id } = await world();
    for (let rev = 1; rev <= 24; rev += 1) {
      const c = cat({ glossary: [{ term: `Term ${rev}`, definition: "" }] });
      expect((await patchConnection(ctx, id, { catalog: c, catalogRev: rev }, db)).status).toBe(200);
    }
    const { versions } = (await getCatalogHistory(ctx, id, db)).body as Versions;
    expect(versions.map((v) => v.rev)).toEqual(Array.from({ length: HISTORY_KEEP }, (_, i) => 25 - i));
    expect(await forTenant(ctx, db).catalogRevisions.count([["connectionId", "==", id]])).toBe(HISTORY_KEEP);
  });

  it("records versions with the flag off, but doesn't show or restore them", async () => {
    delete process.env.CATALOG_HISTORY_ENABLED;
    const { db, id } = await world();
    expect(await getCatalogHistory(ctx, id, db)).toMatchObject({ status: 404 });
    expect(await restoreCatalogVersion(ctx, id, 0, { catalogRev: 1 }, db)).toMatchObject({ status: 404 });
    expect(await forTenant(ctx, db).catalogRevisions.count([["connectionId", "==", id]])).toBe(2);
    expect((await getConnectionDetail(ctx, id, db)).body).toMatchObject({ features: { catalogHistory: false } });
    process.env.CATALOG_HISTORY_ENABLED = "true";
    expect((await getConnectionDetail(ctx, id, db)).body).toMatchObject({ features: { catalogHistory: true } });
  });

  it("is another account's to see only", async () => {
    const { db, id } = await world();
    const other: TenantContext = { ...ctx, tenantId: "ten_B", email: "b@other.test" };
    expect(await getCatalogHistory(other, id, db)).toMatchObject({ status: 404 });
    expect(await restoreCatalogVersion(other, id, 0, { catalogRev: 1 }, db)).toMatchObject({ status: 404 });
  });
});
