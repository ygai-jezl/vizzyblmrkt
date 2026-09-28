import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { z } from "zod";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { ConnectionCatalogSchema, type ConnectionCatalog } from "@/lib/types/productConnection";
import { __resetConnectionCaches } from "./connectionAuth";
import { createProductConnection, getConnectionDetail, patchConnection } from "./adminApi";
import { rebaseCatalog } from "./catalogChanges";

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
});

/** A product whose catalog is C0 (version 1: the first save). */
async function world() {
  const db = new FakeFirestore();
  const r = await createProductConnection(ctx, { name: "App", kind: "custom" }, { origin, db });
  const id = (r.body as { connection: { id: string } }).connection.id;
  expect((await patchConnection(ctx, id, { catalog: C0, catalogRev: 0 }, db)).status).toBe(200);
  return { db, id };
}

const stored = async (db: FakeFirestore, id: string) => (await forTenant(ctx, db).productConnections.getById(id))!;

describe("saving the catalog", () => {
  it("bumps its version, which the page gets back", async () => {
    const { db, id } = await world();
    expect((await stored(db, id)).catalogRev).toBe(1);
    const detail = await getConnectionDetail(ctx, id, db);
    expect(detail.body).toMatchObject({ connection: { catalogRev: 1 } });
  });

  it("refuses a save from an older copy, and hands back the current catalog", async () => {
    // Two tabs open on version 1. Tab A adds two steps and renames one.
    const { db, id } = await world();
    const tabA = cat({
      onboardingSteps: [
        { id: "create_brand", label: "Add a brand", order: 0 },
        { id: "run_audit", label: "Run an audit", order: 1 },
        { id: "invite_team", label: "Invite your team", order: 2 },
        { id: "connect_ga", label: "Connect Analytics", order: 3 },
      ],
    });
    expect((await patchConnection(ctx, id, { catalog: tabA, catalogRev: 1 }, db)).status).toBe(200);

    // Tab B, still on version 1, saves a small change of its own: refused, and nothing is lost.
    const tabB = cat({ ...C0, glossary: [{ term: "GEO", definition: "Getting found in AI answers" }] });
    const refused = await patchConnection(ctx, id, { catalog: tabB, catalogRev: 1 }, db);
    expect(refused).toMatchObject({ status: 409, body: { error: "catalog_changed", catalogRev: 2, catalog: tabA } });
    expect((await stored(db, id)).catalog).toEqual(tabA);

    // Tab B carries its edit over onto the latest and saves: both survive.
    const latest = (refused.body as { catalog: ConnectionCatalog }).catalog;
    const { catalog } = rebaseCatalog(C0, tabB, latest);
    expect((await patchConnection(ctx, id, { catalog, catalogRev: 2 }, db)).status).toBe(200);
    const after = await stored(db, id);
    expect(after.catalogRev).toBe(3);
    expect(after.catalog.onboardingSteps.map((s) => s.label)).toEqual(["Add a brand", "Run an audit", "Invite your team", "Connect Analytics"]);
    expect(after.catalog.glossary.map((g) => g.term)).toEqual(["GEO"]);
  });

  it("refuses a save that doesn't say which version it was edited from (a page from before this check)", async () => {
    const { db, id } = await world();
    expect(await patchConnection(ctx, id, { catalog: cat({}) }, db)).toMatchObject({ status: 409, body: { error: "catalog_page_outdated" } });
    expect((await stored(db, id)).catalog).toEqual(C0);
  });

  it("catches a save that lands between reading the version and writing", async () => {
    const { db, id } = await world();
    db.onBeforeCommit = async () => {
      await forTenant(ctx, db).productConnections.update(id, { catalog: cat({}), catalogRev: 2 });
    };
    const r = await patchConnection(ctx, id, { catalog: cat({ glossary: [{ term: "GEO", definition: "" }] }), catalogRev: 1 }, db);
    expect(r).toMatchObject({ status: 409, body: { error: "catalog_changed", catalogRev: 2 } });
  });

  it("leaves the version alone when only settings change", async () => {
    const { db, id } = await world();
    expect((await patchConnection(ctx, id, { name: "App (staging)" }, db)).status).toBe(200);
    expect(await stored(db, id)).toMatchObject({ name: "App (staging)", catalogRev: 1, catalog: C0 });
  });
});
