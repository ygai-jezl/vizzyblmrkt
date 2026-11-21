import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import type { z } from "zod";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { ConnectionCatalogSchema } from "@/lib/types/productConnection";
import { __resetConnectionCaches } from "./connectionAuth";
import { createProductConnection, getCatalogHistory, getConnectionDetail, patchConnection, restoreCatalogVersion } from "./adminApi";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import type { UserLookup } from "@/lib/team/names";
import { CATALOG_HISTORY_PAGE, listCatalogRevisions } from "./catalogHistory";

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

/** Firebase Auth, as the tests know it: two made-up people. */
const lookup: UserLookup = async (uids) =>
  [
    { uid: "usr_1", displayName: "Sam Rivera", email: "sam@example.com" },
    { uid: "usr_2", displayName: null, email: "priya@example.com" },
  ].filter((u) => uids.includes(u.uid));

/** A product whose catalog is C0 (version 1: the first save), and usr_1 on the brand's team. */
async function world() {
  const db = new FakeFirestore();
  await forTenant(ctx, db).members.create("ten_A_usr_1", { userId: "usr_1", role: "admin", joinedAt: "2026-11-01T00:00:00.000Z" });
  const r = await createProductConnection(ctx, { name: "App", kind: "custom" }, { origin, db });
  const id = (r.body as { connection: { id: string } }).connection.id;
  expect((await patchConnection(ctx, id, { catalog: C0, catalogRev: 0 }, db)).status).toBe(200);
  return { db, id };
}

type Versions = {
  versions: Array<{ rev: number; source: string; savedBy: string | null; restoredFrom: number | null; changes: string[] }>;
  nextCursor: number | null;
};

describe("catalog history", () => {
  it("keeps each saved version, with what changed and who saved it, plus the catalog from before history", async () => {
    const { db, id } = await world();
    const next = cat({ ...C0, onboardingSteps: [...C0.onboardingSteps, { id: "invite_team", label: "Invite your team", order: 2 }] });
    await patchConnection(ctx, id, { catalog: next, catalogRev: 1 }, db);
    const r = await getCatalogHistory(ctx, id, db, { lookup });
    expect(r.status).toBe(200);
    expect((r.body as Versions).versions).toEqual([
      { rev: 2, savedAt: expect.any(String), source: "editor", savedBy: "Sam Rivera", restoredFrom: null, changes: ["Added step ‘Invite your team’"] },
      { rev: 1, savedAt: expect.any(String), source: "editor", savedBy: "Sam Rivera", restoredFrom: null, changes: ["Added step ‘Add your brand’", "Added step ‘Run an audit’"] },
      { rev: 0, savedAt: expect.any(String), source: "before_history", savedBy: null, restoredFrom: null, changes: [] },
    ]);
  });

  it("keeps who saved it as a user id, never an address, and names them only while they are on the team", async () => {
    const { db, id } = await world();
    const { versions } = await listCatalogRevisions(ctx, id, {}, db);
    expect(versions.map((v) => v.savedBy)).toEqual(["usr_1", null]);
    expect(JSON.stringify(versions)).not.toContain("@");
    // Once they leave the team, the history calls them a former team member.
    await forTenant(ctx, db).members.delete("ten_A_usr_1");
    const left = (await getCatalogHistory(ctx, id, db, { lookup })).body as Versions;
    expect(left.versions[0]!.savedBy).toBe("Former team member");
    // A member whose name isn't set shows by their sign-in address, looked up now.
    const priya: TenantContext = { ...ctx, userId: "usr_2", email: "priya@example.com" };
    await forTenant(ctx, db).members.create("ten_A_usr_2", { userId: "usr_2", role: "admin", joinedAt: "2026-11-01T00:00:00.000Z" });
    await patchConnection(priya, id, { catalog: cat({ glossary: [{ term: "Seat", definition: "" }] }), catalogRev: 1 }, db);
    expect(((await getCatalogHistory(ctx, id, db, { lookup })).body as Versions).versions[0]!.savedBy).toBe("priya@example.com");
  });

  it("shows an address saved before user ids as it is, until the scrub replaces it", async () => {
    const { db, id } = await world();
    await forTenant(ctx, db).catalogRevisions.update(`${id}_r000001`, { savedBy: "sam@example.com" });
    const { versions } = (await getCatalogHistory(ctx, id, db, { lookup })).body as Versions;
    expect(versions[0]!.savedBy).toBe("sam@example.com");
  });

  it("restores an earlier version as a new one, so nothing is lost", async () => {
    const { db, id } = await world();
    const renamed = cat({ ...C0, onboardingSteps: [{ ...C0.onboardingSteps[0]!, label: "Add a brand" }, C0.onboardingSteps[1]!] });
    await patchConnection(ctx, id, { catalog: renamed, catalogRev: 1 }, db);

    const r = await restoreCatalogVersion(ctx, id, 1, { catalogRev: 2 }, db);
    expect(r).toMatchObject({ status: 200, body: { connection: { catalogRev: 3, catalog: C0 } } });
    const [latest] = ((await getCatalogHistory(ctx, id, db, { lookup })).body as Versions).versions;
    expect(latest).toMatchObject({ rev: 3, source: "restore", restoredFrom: 1, changes: ["Renamed step ‘Add a brand’ to ‘Add your brand’"] });
  });

  it("refuses a restore from an out-of-date page, or of a version it doesn't keep", async () => {
    const { db, id } = await world();
    expect(await restoreCatalogVersion(ctx, id, 0, { catalogRev: 0 }, db)).toMatchObject({ status: 409, body: { error: "catalog_changed", catalogRev: 1 } });
    expect(await restoreCatalogVersion(ctx, id, 7, { catalogRev: 1 }, db)).toMatchObject({ status: 404, body: { error: "version_not_found" } });
    expect(await restoreCatalogVersion(ctx, id, 0, {}, db)).toMatchObject({ status: 400 });
  });

  it("keeps every version, listed newest first a page at a time", async () => {
    const { db, id } = await world();
    for (let rev = 1; rev <= 24; rev += 1) {
      const c = cat({ glossary: [{ term: `Term ${rev}`, definition: "" }] });
      expect((await patchConnection(ctx, id, { catalog: c, catalogRev: rev }, db)).status).toBe(200);
    }
    expect(await forTenant(ctx, db).catalogRevisions.count([["connectionId", "==", id]])).toBe(26);
    const first = (await getCatalogHistory(ctx, id, db, { lookup })).body as Versions;
    expect(first.versions.map((v) => v.rev)).toEqual(Array.from({ length: CATALOG_HISTORY_PAGE }, (_, i) => 25 - i));
    expect(first.nextCursor).toBe(25 - CATALOG_HISTORY_PAGE + 1);
    const second = (await getCatalogHistory(ctx, id, db, { lookup, cursor: first.nextCursor })).body as Versions;
    expect(second.versions.map((v) => v.rev)).toEqual([5, 4, 3, 2, 1, 0]);
    expect(second.nextCursor).toBeNull();
  });

  it("falls back to the old query while the index by rev is still building", async () => {
    const { db, id } = await world();
    await patchConnection(ctx, id, { catalog: cat({ glossary: [{ term: "Seat", definition: "" }] }), catalogRev: 1 }, db);
    // Firestore refuses an ordered query until its index is ready.
    const building = failingFirestore(db, { ordered: ["catalog_revisions"] });
    const all = await listCatalogRevisions(ctx, id, {}, building);
    expect(all.versions.map((v) => v.rev)).toEqual([2, 1, 0]);
    const page = await listCatalogRevisions(ctx, id, { cursor: 2, limit: 1 }, building);
    expect(page).toMatchObject({ versions: [{ rev: 1 }], nextCursor: 1 });
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
