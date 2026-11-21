import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { sourceFiles, stripComments } from "@/lib/ontology/storeScan";
import { SettingsRemovalError } from "@/lib/settings/archive";
import type { SettingsItem, SettingsList } from "@/lib/types/settingsVersion";
import { FakeFirestore } from "./testing/fakeFirestore";
import { forTenant, type TenantRepositories } from "./repository";
import { TenantIsolationError, TenantValidationError } from "./errors";
import { commitSettingsChange, readSetting, settingsDocId, settingsVersionId, SETTINGS_HOMES, SETTINGS_VERSIONS, type SettingsChange } from "./settingsLog";
import type { TenantContext } from "./types";

type Field = SettingsItem & { type: string; options?: string[] };
type Fields = SettingsList<Field>;

const A: TenantContext = { tenantId: "ten_A", region: "eu", source: "idtoken", role: "admin", userId: "usr_1" };
const B: TenantContext = { tenantId: "ten_B", region: "eu", source: "idtoken", role: "admin", userId: "usr_2" };
const NOW = "2026-11-20T10:00:00.000Z";
const plan: Field = { key: "fld_plan", label: "Plan", type: "select", options: ["Free", "Pro"] };
const role: Field = { key: "fld_role", label: "Role", type: "text" };

const save = (baseRev: number, items: Field[], over: Partial<SettingsChange<Fields>> = {}): SettingsChange<Fields> => ({
  subject: "fields:person",
  baseRev,
  value: { items },
  by: { type: "member", id: "usr_1" },
  source: "editor",
  nowIso: NOW,
  ...over,
});

const versionsOf = (db: FakeFirestore) => [...(db.cols.get(SETTINGS_VERSIONS)?.values() ?? [])];
const homeOf = (db: FakeFirestore) => db.cols.get(SETTINGS_HOMES["fields:person"]);

describe("commitSettingsChange", () => {
  it("writes the setting and its version together, with who, what and the whole setting", async () => {
    const db = new FakeFirestore();
    const r = await commitSettingsChange(A, save(0, [plan]), db);
    expect(r).toMatchObject({ ok: true, rev: 1 });
    if (!r.ok) throw new Error("expected a save");
    expect(r.version).toMatchObject({
      id: settingsVersionId("ten_A", "fields:person", 1),
      tenantId: "ten_A",
      subject: "fields:person",
      rev: 1,
      state: "live",
      savedAt: NOW,
      by: { type: "member", id: "usr_1" },
      message: null,
      source: "editor",
      restoredFrom: null,
      items: [{ key: "fld_plan", label: "Plan", change: "added", before: null }],
      moreItems: 0,
      snapshot: { items: [plan] },
    });
    expect(versionsOf(db)).toHaveLength(1);
    const stored = await readSetting<Fields>(A, "fields:person", db);
    expect(stored).toEqual({ value: { items: [plan] }, rev: 1, updatedAt: NOW });
    expect(homeOf(db)?.has(settingsDocId("ten_A", "fields:person"))).toBe(true);
  });

  it("returns settings_changed for a stale rev, and a retry of a save that landed writes no second version", async () => {
    const db = new FakeFirestore();
    expect((await commitSettingsChange(A, save(0, [plan]), db)).ok).toBe(true);
    const retry = await commitSettingsChange(A, save(0, [plan]), db);
    expect(retry).toEqual({ ok: false, error: "settings_changed", current: { value: { items: [plan] }, rev: 1, updatedAt: NOW } });
    expect(versionsOf(db)).toHaveLength(1);
    expect(await commitSettingsChange(A, save(5, [plan, role]), db)).toMatchObject({ ok: false, error: "settings_changed" });
    expect(await commitSettingsChange(A, save(1, [plan, role]), db)).toMatchObject({ ok: true, rev: 2 });
    expect(versionsOf(db)).toHaveLength(2);
  });

  it("lets only one of two racing saves from the same rev land", async () => {
    const db = new FakeFirestore();
    let raced: unknown;
    db.onBeforeCommit = async () => {
      raced = await commitSettingsChange(A, save(0, [role], { by: { type: "member", id: "usr_9" } }), db);
    };
    const first = await commitSettingsChange(A, save(0, [plan]), db);
    expect(raced).toMatchObject({ ok: true, rev: 1 });
    expect(first).toMatchObject({ ok: false, error: "settings_changed", current: { rev: 1, value: { items: [role] } } });
    expect(versionsOf(db)).toHaveLength(1);
    expect((await readSetting<Fields>(A, "fields:person", db))?.value.items).toEqual([role]);
  });

  it("writes neither document when the save is refused", async () => {
    const db = new FakeFirestore();
    await commitSettingsChange(A, save(0, [plan, role]), db);
    // An item dropped instead of archived.
    await expect(commitSettingsChange(A, save(1, [plan]), db)).rejects.toBeInstanceOf(SettingsRemovalError);
    // A version over its caps.
    await expect(commitSettingsChange(A, save(1, [plan, role], { message: "m".repeat(201) }), db)).rejects.toThrow(/bad_settings_version:message/);
    const huge: Field = { ...role, options: ["x".repeat(300 * 1024)] };
    await expect(commitSettingsChange(A, save(1, [plan, huge]), db)).rejects.toThrow(/snapshot_too_large/);
    expect(versionsOf(db)).toHaveLength(1);
    expect((await readSetting<Fields>(A, "fields:person", db))?.rev).toBe(1);
  });

  it("refuses an id another brand holds, for the setting or its version", async () => {
    const db = new FakeFirestore();
    await db.collection(SETTINGS_HOMES["fields:person"]).doc(settingsDocId("ten_A", "fields:person")).set({ tenantId: "ten_B", rev: 0, items: [] });
    await expect(commitSettingsChange(A, save(0, [plan]), db)).rejects.toBeInstanceOf(TenantIsolationError);
    expect(await readSetting(A, "fields:person", db)).toBeNull();

    const db2 = new FakeFirestore();
    await db2.collection(SETTINGS_VERSIONS).doc(settingsVersionId("ten_A", "fields:person", 1)).set({ tenantId: "ten_B" });
    await expect(commitSettingsChange(A, save(0, [plan]), db2)).rejects.toBeInstanceOf(TenantIsolationError);
    expect(await readSetting(A, "fields:person", db2)).toBeNull();
  });

  it("lets two brands save the same subject at rev 1", async () => {
    const db = new FakeFirestore();
    expect(await commitSettingsChange(A, save(0, [plan]), db)).toMatchObject({ ok: true, rev: 1 });
    expect(await commitSettingsChange(B, save(0, [role], { by: { type: "member", id: "usr_2" } }), db)).toMatchObject({ ok: true, rev: 1 });
    expect(versionsOf(db)).toHaveLength(2);
    expect((await readSetting<Fields>(A, "fields:person", db))?.value.items).toEqual([plan]);
    expect((await readSetting<Fields>(B, "fields:person", db))?.value.items).toEqual([role]);
    expect(await forTenant(A, db).settingsVersions.count()).toBe(1);
  });

  it("keeps the log's own fields out of the setting, and checks its input", async () => {
    const db = new FakeFirestore();
    const bad = { items: [plan], rev: 9 } as unknown as Fields;
    await expect(commitSettingsChange(A, save(0, [], { value: bad }), db)).rejects.toThrow(/reserved_settings_field:rev/);
    await expect(commitSettingsChange(A, save(-1, [plan]), db)).rejects.toBeInstanceOf(TenantValidationError);
    await expect(commitSettingsChange(A, save(0, [plan], { nowIso: "yesterday" }), db)).rejects.toBeInstanceOf(TenantValidationError);
    await expect(commitSettingsChange(A, save(0, [plan], { by: { type: "member", id: "sam@example.com" } }), db)).rejects.toThrow(/bad_settings_version:by/);
    expect(versionsOf(db)).toHaveLength(0);
  });

  it("takes the caller's items and message when given", async () => {
    const db = new FakeFirestore();
    const r = await commitSettingsChange(
      A,
      save(0, [plan], { message: "  For the sales team  ", items: [{ key: "fld_plan", label: "Plan", change: "added", before: null, after: null }] }),
      db,
    );
    expect(r).toMatchObject({ ok: true, version: { message: "For the sales team", items: [{ key: "fld_plan", after: null }] } });
  });
});

describe("the settings log's store", () => {
  it("is read only through forTenant", () => {
    type Versions = TenantRepositories["settingsVersions"];
    expectTypeOf<Versions>().toHaveProperty("find");
    expectTypeOf<Versions>().toHaveProperty("getById");
    expectTypeOf<Versions>().not.toHaveProperty("create");
    expectTypeOf<Versions>().not.toHaveProperty("update");
    expectTypeOf<Versions>().not.toHaveProperty("delete");
    expectTypeOf<Versions>().not.toHaveProperty("deleteWhere");
    expectTypeOf<Versions>().not.toHaveProperty("upsert");
  });

  it("is named only by its writer, the repository and the registry", () => {
    const allowed = new Set(["src/lib/tenant/settingsLog.ts", "src/lib/tenant/repository.ts", "src/lib/ontology/registry.ts"]);
    const named = sourceFiles("src").filter((file) => {
      const code = stripComments(readFileSync(join(process.cwd(), file), "utf8"));
      return /["'`]settings_versions["'`]|\bSETTINGS_VERSIONS\b/.test(code);
    });
    expect(named.filter((f) => !allowed.has(f))).toEqual([]);
    // Its writer creates versions and never sets, updates or deletes one.
    const writer = stripComments(readFileSync(join(process.cwd(), "src/lib/tenant/settingsLog.ts"), "utf8"));
    expect(writer).not.toMatch(/txn\.(set|update|delete)\(\s*versionRef/);
    expect(writer).not.toMatch(/versionRef\.(set|update|delete)\(/);
  });
});
