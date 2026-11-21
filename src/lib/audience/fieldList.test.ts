import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant, settingsDocId } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { listSettingsVersions } from "@/lib/settings/history";
import { FIELD_LIMITS, type RecordField } from "@/lib/types/recordField";
import { applyFieldListChange, readFieldList, restoreFieldListVersion, saveFieldListChange, type FieldListChange } from "./fieldList";

const ctx: TenantContext = { tenantId: "ten_A", region: "eu", source: "idtoken", role: "admin", userId: "u_admin" };
const other: TenantContext = { ...ctx, tenantId: "ten_B" };
const by = { type: "member", id: "u_admin" } as const;
const T1 = "2026-11-21T10:00:00.000Z";
const T2 = "2026-11-21T11:00:00.000Z";

/** Ids in order, so tests can name them. */
function ids(prefix: "fld" | "opt") {
  let n = 0;
  return () => `${prefix}_${String((n += 1)).padStart(prefix === "fld" ? 12 : 8, "0")}`;
}

async function save(db: FakeFirestore, change: FieldListChange, opts: { baseRev?: number; c?: TenantContext; nowIso?: string; fld?: () => string; opt?: () => string } = {}) {
  const c = opts.c ?? ctx;
  const baseRev = opts.baseRev ?? (await readFieldList(c, "person", db)).rev;
  return saveFieldListChange(c, "person", { baseRev, change, by, nowIso: opts.nowIso ?? T1, newFieldId: opts.fld, newOptionId: opts.opt }, db);
}

describe("the field list", () => {
  it("adds a field as a new version, with who made it by user id", async () => {
    const db = new FakeFirestore();
    const r = await save(db, { op: "add", label: " Plan ", type: "select", options: ["Free", "Pro", "Pro"] }, { fld: ids("fld"), opt: ids("opt") });
    expect(r).toMatchObject({ ok: true, message: "Added ‘Plan’", list: { rev: 1 } });
    const list = await readFieldList(ctx, "person", db);
    expect(list.items).toEqual([
      {
        key: "fld_000000000001",
        label: "Plan",
        type: "select",
        object: "person",
        options: [
          { id: "opt_00000001", label: "Free" },
          { id: "opt_00000002", label: "Pro" },
        ],
        archivedAt: null,
        archivedBy: null,
        replacedBy: null,
        createdAt: T1,
        createdBy: "u_admin",
      },
    ]);
    const { versions } = await listSettingsVersions(ctx, "fields:person", {}, db);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ rev: 1, message: "Added ‘Plan’", by, items: [{ key: "fld_000000000001", change: "added" }] });
    // Read through forTenant, never written there.
    expect(await forTenant(ctx, db).recordFieldLists.getById(settingsDocId(ctx.tenantId, "fields:person"))).toMatchObject({ rev: 1, subject: "fields:person" });
  });

  it("archives a field, never deletes it, and restores it", async () => {
    const db = new FakeFirestore();
    await save(db, { op: "add", label: "Old segment", type: "text" }, { fld: () => "fld_000000000001" });
    const archived = await save(db, { op: "archive", key: "fld_000000000001" }, { nowIso: T2 });
    expect(archived).toMatchObject({ ok: true, message: "Archived ‘Old segment’" });
    let list = await readFieldList(ctx, "person", db);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ archivedAt: T2, archivedBy: "u_admin" });
    await save(db, { op: "restore", key: "fld_000000000001" });
    list = await readFieldList(ctx, "person", db);
    expect(list.items[0]).toMatchObject({ archivedAt: null, archivedBy: null });
    expect((await listSettingsVersions(ctx, "fields:person", {}, db)).versions.map((v) => v.items[0]?.change)).toEqual(["restored", "archived", "added"]);
  });

  it("changes a type by making a new field and archiving the old one", async () => {
    const db = new FakeFirestore();
    const fld = ids("fld");
    await save(db, { op: "add", label: "Seats", type: "text" }, { fld });
    await save(db, { op: "add", label: "Role", type: "text" }, { fld });
    const r = await save(db, { op: "change_type", key: "fld_000000000001", type: "number" }, { fld, nowIso: T2 });
    expect(r).toMatchObject({ ok: true, message: "Changed ‘Seats’ to number" });
    const list = await readFieldList(ctx, "person", db);
    expect(list.items.map((f) => [f.key, f.type, f.archivedAt ?? null, f.replacedBy ?? null])).toEqual([
      ["fld_000000000003", "number", null, null],
      ["fld_000000000001", "text", T2, "fld_000000000003"],
      ["fld_000000000002", "text", null, null],
    ]);
    // The same type is not a change.
    expect(await save(db, { op: "change_type", key: "fld_000000000003", type: "number" })).toEqual({ ok: false, error: "invalid_field" });
  });

  it("refuses a stale rev with the list as it is now", async () => {
    const db = new FakeFirestore();
    await save(db, { op: "add", label: "Plan", type: "text" });
    const r = await save(db, { op: "add", label: "Role", type: "text" }, { baseRev: 0 });
    expect(r).toMatchObject({ ok: false, error: "fields_changed", list: { rev: 1 } });
    expect((await readFieldList(ctx, "person", db)).items.map((f) => f.label)).toEqual(["Plan"]);
  });

  it("answers field_list_full past a cap", async () => {
    const items: RecordField[] = Array.from({ length: FIELD_LIMITS.liveFields }, (_, i) => ({
      key: `fld_${String(i).padStart(12, "0")}`,
      label: `F${i}`,
      type: "text",
      object: "person",
      createdAt: T1,
      createdBy: null,
    }));
    expect(applyFieldListChange("person", items, { op: "add", label: "One more", type: "text" }, { nowIso: T1, userId: "u_admin" })).toEqual({
      ok: false,
      error: "field_list_full",
    });
  });

  it("keeps options archived, never removed, and refuses bad changes", () => {
    const opts = { nowIso: T1, userId: "u_admin", newFieldId: ids("fld"), newOptionId: ids("opt") };
    const added = applyFieldListChange("person", [], { op: "add", label: "Status", type: "status", options: ["Trial", "Paying"] }, opts);
    if (!added.ok) throw new Error("add failed");
    const archived = applyFieldListChange("person", added.items, { op: "archive_option", key: "fld_000000000001", optionId: "opt_00000001" }, opts);
    expect(archived.ok && archived.items[0]!.options).toEqual([
      { id: "opt_00000001", label: "Trial", archivedAt: T1 },
      { id: "opt_00000002", label: "Paying" },
    ]);
    expect(applyFieldListChange("person", added.items, { op: "rename", key: "fld_nope00000000", label: "X" }, opts)).toEqual({ ok: false, error: "field_not_found" });
    expect(applyFieldListChange("person", added.items, { op: "archive_option", key: "fld_000000000001", optionId: "opt_99999999" }, opts)).toEqual({ ok: false, error: "option_not_found" });
    expect(applyFieldListChange("person", [], { op: "add", label: "", type: "text" }, opts)).toEqual({ ok: false, error: "invalid_field" });
    expect(applyFieldListChange("person", [], { op: "add", label: "Price", type: "currency" }, opts)).toEqual({ ok: false, error: "invalid_field" });
    expect(applyFieldListChange("person", [], { op: "add", label: "Price", type: "currency", currency: "gbp" }, opts)).toMatchObject({ ok: true });
    expect(applyFieldListChange("person", added.items, { op: "reorder", keys: [] }, opts)).toEqual({ ok: false, error: "invalid_field" });
    expect(applyFieldListChange("person", [], { op: "add", label: "X", type: "nope" as never }, opts)).toEqual({ ok: false, error: "invalid_field" });
  });

  it("restores an earlier version through the settings log, archiving what it didn't have", async () => {
    const db = new FakeFirestore();
    const fld = ids("fld");
    await save(db, { op: "add", label: "Plan", type: "text" }, { fld });
    await save(db, { op: "rename", key: "fld_000000000001", label: "Pricing plan" });
    await save(db, { op: "add", label: "Role", type: "text" }, { fld });
    const r = await restoreFieldListVersion(ctx, "person", { rev: 1, baseRev: 3, by, nowIso: T2 }, db);
    expect(r).toMatchObject({ ok: true, message: "Restored version 1", list: { rev: 4 } });
    const list = await readFieldList(ctx, "person", db);
    expect(list.items.map((f) => [f.label, f.archivedAt ?? null])).toEqual([
      ["Plan", null],
      ["Role", T2],
    ]);
    const [latest] = (await listSettingsVersions(ctx, "fields:person", {}, db)).versions;
    expect(latest).toMatchObject({ source: "restore", restoredFrom: 1 });
    expect(await restoreFieldListVersion(ctx, "person", { rev: 1, baseRev: 1, by }, db)).toMatchObject({ ok: false, error: "fields_changed" });
    expect(await restoreFieldListVersion(ctx, "person", { rev: 99, baseRev: 4, by }, db)).toEqual({ ok: false, error: "field_not_found" });
  });

  it("keeps two brands' lists, and People and Companies, apart", async () => {
    const db = new FakeFirestore();
    await save(db, { op: "add", label: "Plan", type: "text" });
    await save(db, { op: "add", label: "Tier", type: "text" }, { c: other });
    await saveFieldListChange(ctx, "company", { baseRev: 0, change: { op: "add", label: "Region", type: "text" }, by, nowIso: T1 }, db);
    expect((await readFieldList(ctx, "person", db)).items.map((f) => f.label)).toEqual(["Plan"]);
    expect((await readFieldList(other, "person", db)).items.map((f) => f.label)).toEqual(["Tier"]);
    expect((await readFieldList(ctx, "company", db)).items.map((f) => [f.label, f.object])).toEqual([["Region", "company"]]);
    expect(settingsDocId("ten_A", "fields:person")).not.toBe(settingsDocId("ten_B", "fields:person"));
  });

  it("writes no version when nothing changed", async () => {
    const db = new FakeFirestore();
    await save(db, { op: "add", label: "Plan", type: "text" }, { fld: () => "fld_000000000001" });
    const r = await save(db, { op: "rename", key: "fld_000000000001", label: "Plan" });
    expect(r).toMatchObject({ ok: true, list: { rev: 1 } });
    expect((await listSettingsVersions(ctx, "fields:person", {}, db)).versions).toHaveLength(1);
  });
});
