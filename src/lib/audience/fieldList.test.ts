import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant, settingsDocId } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { listSettingsVersions } from "@/lib/settings/history";
import { FIELD_LIMITS, type RecordField } from "@/lib/types/recordField";
import { applyFieldListChange, readFieldList, restoreFieldListVersion, saveFieldEraseMark, saveFieldListChange, type FieldListChange } from "./fieldList";

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
    expect(list.items.map((f) => [f.label, f.archivedAt ?? null, f.archivedBy ?? null])).toEqual([
      ["Plan", null, null],
      ["Role", T2, "u_admin"],
    ]);
    const [latest] = (await listSettingsVersions(ctx, "fields:person", {}, db)).versions;
    expect(latest).toMatchObject({ source: "restore", restoredFrom: 1 });
    expect(await restoreFieldListVersion(ctx, "person", { rev: 1, baseRev: 1, by }, db)).toMatchObject({ ok: false, error: "fields_changed" });
    expect(await restoreFieldListVersion(ctx, "person", { rev: 99, baseRev: 4, by }, db)).toEqual({ ok: false, error: "field_not_found" });
  });

  it("stamps the fields a restore archives with now, never an older version's archive date", async () => {
    const db = new FakeFirestore();
    const T0 = "2026-10-01T10:00:00.000Z";
    await save(db, { op: "add", label: "Plan", type: "text" }, { fld: () => "fld_000000000001", nowIso: T0 }); // v1
    await save(db, { op: "archive", key: "fld_000000000001" }, { nowIso: T0 }); // v2: archived on T0
    await save(db, { op: "restore", key: "fld_000000000001" }, { nowIso: T1 }); // v3: live again
    // Back to v2: archived again, from now, so its 30 days start now.
    expect(await restoreFieldListVersion(ctx, "person", { rev: 2, baseRev: 3, by, nowIso: T2 }, db)).toMatchObject({ ok: true, list: { rev: 4 } });
    expect((await readFieldList(ctx, "person", db)).items[0]).toMatchObject({ archivedAt: T2, archivedBy: "u_admin" });
    // Back to v2 once more while it is archived: it keeps when it was archived, never the older date.
    const T3 = "2026-11-22T10:00:00.000Z";
    expect(await restoreFieldListVersion(ctx, "person", { rev: 2, baseRev: 4, by: { type: "member", id: "u_other" }, nowIso: T3 }, db)).toMatchObject({ ok: true });
    expect((await readFieldList(ctx, "person", db)).items[0]).toMatchObject({ archivedAt: T2, archivedBy: "u_admin" });
  });

  it("keeps an erase through a restore and Bring back: a field being erased stays archived, an erased one comes back marked", async () => {
    const db = new FakeFirestore();
    const opt = ids("opt");
    await save(db, { op: "add", label: "Tier", type: "select", options: ["Gold", "Silver"] }, { fld: () => "fld_000000000001", opt }); // v1
    await save(db, { op: "archive", key: "fld_000000000001" }, { nowIso: T1 }); // v2
    const T3 = "2026-11-22T10:00:00.000Z";
    expect(await saveFieldEraseMark(ctx, "person", { key: "fld_000000000001", step: "start", by: "u_owner", nowIso: T2 }, db)).toMatchObject({ ok: true, message: "Started erasing the values of ‘Tier’", list: { rev: 3 } });
    expect((await listSettingsVersions(ctx, "fields:person", {}, db)).versions[0]).toMatchObject({ source: "erase", by: { type: "member", id: "u_owner" } });
    // While it runs, Bring back is refused and a restore of v1 keeps it archived and marked.
    expect(await save(db, { op: "restore", key: "fld_000000000001" })).toMatchObject({ ok: false, error: "field_erasing" });
    await restoreFieldListVersion(ctx, "person", { rev: 1, baseRev: 3, by, nowIso: T3 }, db);
    expect((await readFieldList(ctx, "person", db)).items[0]).toMatchObject({ archivedAt: T1, erasingSince: T2 });
    // Done: the options stay, the mark goes, and a restore or Bring back keeps erasedAt.
    expect(await saveFieldEraseMark(ctx, "person", { key: "fld_000000000001", step: "done", by: "u_owner", nowIso: T3 }, db)).toMatchObject({ ok: true, message: "Erased the values of ‘Tier’" });
    let tier = (await readFieldList(ctx, "person", db)).items[0]!;
    expect(tier).toMatchObject({ archivedAt: T1, erasedAt: T3, erasedBy: "u_owner" });
    expect(tier).not.toHaveProperty("erasingSince");
    expect(tier.options!.map((o) => o.label)).toEqual(["Gold", "Silver"]);
    const rev = (await readFieldList(ctx, "person", db)).rev;
    await restoreFieldListVersion(ctx, "person", { rev: 1, baseRev: rev, by, nowIso: "2026-11-23T10:00:00.000Z" }, db);
    tier = (await readFieldList(ctx, "person", db)).items[0]!;
    expect(tier).toMatchObject({ archivedAt: null, erasedAt: T3, erasedBy: "u_owner" });
    await save(db, { op: "archive", key: "fld_000000000001" }, { nowIso: "2026-11-24T10:00:00.000Z" });
    await save(db, { op: "restore", key: "fld_000000000001" }, { nowIso: "2026-11-25T10:00:00.000Z" });
    expect((await readFieldList(ctx, "person", db)).items[0]).toMatchObject({ archivedAt: null, erasedAt: T3 });
    // Starting needs an archived field.
    expect(await saveFieldEraseMark(ctx, "person", { key: "fld_000000000001", step: "start", by: "u_owner", nowIso: T3 }, db)).toMatchObject({ ok: false, error: "invalid_field" });
  });

  it("archives an option added after the version it restores, never dropping it", async () => {
    const db = new FakeFirestore();
    const opt = ids("opt");
    await save(db, { op: "add", label: "Plan", type: "select", options: ["Free"] }, { fld: () => "fld_000000000001", opt });
    await save(db, { op: "add_option", key: "fld_000000000001", label: "Pro" }, { opt });
    const r = await restoreFieldListVersion(ctx, "person", { rev: 1, baseRev: 2, by, nowIso: T2 }, db);
    expect(r).toMatchObject({ ok: true, list: { rev: 3 } });
    expect((await readFieldList(ctx, "person", db)).items[0]!.options).toEqual([
      { id: "opt_00000001", label: "Free" },
      { id: "opt_00000002", label: "Pro", archivedAt: T2 },
    ]);
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

  it("asks for nothing more than it did: a field is added without the Vizzy mark unless it is asked for", async () => {
    const db = new FakeFirestore();
    await save(db, { op: "add", label: "Job Title", type: "text" }, { fld: () => "fld_000000000001" });
    expect((await readFieldList(ctx, "person", db)).items[0]).not.toHaveProperty("vizzyReads");
  });

  it("lets Vizzy read a People text field and stops it again, each a version of its own", async () => {
    const db = new FakeFirestore();
    await save(db, { op: "add", label: "Job Title", type: "text" }, { fld: () => "fld_000000000001" });
    const on = await save(db, { op: "vizzy_reads", key: "fld_000000000001", on: true }, { nowIso: T2 });
    expect(on).toMatchObject({ ok: true, message: "Let Vizzy read ‘Job Title’", list: { rev: 2 } });
    expect((await readFieldList(ctx, "person", db)).items[0]).toMatchObject({ vizzyReads: true });
    // Asking again changes nothing and writes no version.
    expect(await save(db, { op: "vizzy_reads", key: "fld_000000000001", on: true })).toMatchObject({ ok: true, list: { rev: 2 } });
    const off = await save(db, { op: "vizzy_reads", key: "fld_000000000001", on: false });
    expect(off).toMatchObject({ ok: true, message: "Stopped Vizzy reading ‘Job Title’", list: { rev: 3 } });
    expect((await readFieldList(ctx, "person", db)).items[0]).not.toHaveProperty("vizzyReads");
    const { versions } = await listSettingsVersions(ctx, "fields:person", {}, db);
    expect(versions.map((v) => [v.rev, v.message, v.source, v.items[0]?.change])).toEqual([
      [3, "Stopped Vizzy reading ‘Job Title’", "editor", "changed"],
      [2, "Let Vizzy read ‘Job Title’", "editor", "changed"],
      [1, "Added ‘Job Title’", "editor", "added"],
    ]);
  });

  it("adds a text field Vizzy can read, and refuses the mark anywhere else", () => {
    const opts = { nowIso: T1, userId: "u_admin", newFieldId: ids("fld"), newOptionId: ids("opt") };
    const added = applyFieldListChange("person", [], { op: "add", label: "Job Title", type: "text", vizzyReads: true }, opts);
    expect(added).toMatchObject({ ok: true, message: "Added ‘Job Title’ and let Vizzy read it" });
    expect(added.ok && added.items[0]).toMatchObject({ type: "text", vizzyReads: true });
    const unticked = applyFieldListChange("person", [], { op: "add", label: "Notes", type: "text", vizzyReads: false }, opts);
    expect(unticked.ok && unticked.items[0]).not.toHaveProperty("vizzyReads");
    expect(applyFieldListChange("person", [], { op: "add", label: "Work email", type: "email", vizzyReads: true }, opts)).toEqual({ ok: false, error: "invalid_field" });
    expect(applyFieldListChange("company", [], { op: "add", label: "Sector", type: "text", vizzyReads: true }, opts)).toEqual({ ok: false, error: "invalid_field" });
  });

  it("refuses the Vizzy mark on a field that isn't there, is archived, isn't text or is a company's", () => {
    const opts = { nowIso: T1, userId: "u_admin", newFieldId: ids("fld"), newOptionId: ids("opt") };
    let items: RecordField[] = [];
    for (const change of [
      { op: "add", label: "Job Title", type: "text" },
      { op: "add", label: "Work email", type: "email" },
      { op: "add", label: "Old title", type: "text" },
      { op: "archive", key: "fld_000000000003" },
    ] as FieldListChange[]) {
      const r = applyFieldListChange("person", items, change, opts);
      if (!r.ok) throw new Error(r.error);
      items = r.items;
    }
    const vizzy = (key: string, on = true) => applyFieldListChange("person", items, { op: "vizzy_reads", key, on }, opts);
    expect(vizzy("fld_999999999999")).toEqual({ ok: false, error: "field_not_found" });
    expect(vizzy("fld_000000000002")).toEqual({ ok: false, error: "invalid_field" });
    expect(vizzy("fld_000000000003")).toEqual({ ok: false, error: "invalid_field" });
    expect(vizzy("fld_000000000003", false)).toEqual({ ok: false, error: "invalid_field" });
    expect(vizzy("fld_000000000001")).toMatchObject({ ok: true });
    const company = applyFieldListChange("company", [], { op: "add", label: "Sector", type: "text" }, { ...opts, newFieldId: () => "fld_00000000000c" });
    if (!company.ok) throw new Error(company.error);
    expect(applyFieldListChange("company", company.items, { op: "vizzy_reads", key: "fld_00000000000c", on: true }, opts)).toEqual({ ok: false, error: "invalid_field" });
  });

  it("never turns Vizzy reading on with Bring back", async () => {
    const db = new FakeFirestore();
    await save(db, { op: "add", label: "Job Title", type: "text", vizzyReads: true }, { fld: () => "fld_000000000001" });
    await save(db, { op: "archive", key: "fld_000000000001" });
    // Archived, it keeps the mark, and Vizzy reads nothing of it.
    expect((await readFieldList(ctx, "person", db)).items[0]).toMatchObject({ archivedAt: T1, vizzyReads: true });
    expect(await save(db, { op: "restore", key: "fld_000000000001" })).toMatchObject({ ok: true, message: "Restored ‘Job Title’" });
    const back = (await readFieldList(ctx, "person", db)).items[0]!;
    expect(back).toMatchObject({ archivedAt: null });
    expect(back).not.toHaveProperty("vizzyReads");
  });

  it("never turns Vizzy reading on with a restore: an older version can turn it off, never on", async () => {
    const db = new FakeFirestore();
    await save(db, { op: "add", label: "Job Title", type: "text", vizzyReads: true }, { fld: () => "fld_000000000001" }); // v1: reading
    await save(db, { op: "vizzy_reads", key: "fld_000000000001", on: false }); // v2: not reading
    await save(db, { op: "add", label: "Team", type: "text" }, { fld: () => "fld_000000000002" }); // v3
    await save(db, { op: "vizzy_reads", key: "fld_000000000002", on: true }); // v4: Team read

    // Back to v1: Job Title stays unread, though v1 had it read; Team, which v1 didn't have, is archived and keeps its mark.
    const r = await restoreFieldListVersion(ctx, "person", { rev: 1, baseRev: 4, by, nowIso: T2 }, db);
    expect(r).toMatchObject({ ok: true, list: { rev: 5 } });
    let items = (await readFieldList(ctx, "person", db)).items;
    expect(items[0]).not.toHaveProperty("vizzyReads");
    expect(items[1]).toMatchObject({ label: "Team", archivedAt: T2, vizzyReads: true });

    // Back to v4: Team comes back from the archive without the mark.
    const again = await restoreFieldListVersion(ctx, "person", { rev: 4, baseRev: 5, by, nowIso: T2 }, db);
    expect(again).toMatchObject({ ok: true, list: { rev: 6 } });
    items = (await readFieldList(ctx, "person", db)).items;
    expect(items[1]).toMatchObject({ label: "Team", archivedAt: null });
    expect(items[1]).not.toHaveProperty("vizzyReads");

    // Back to v2, while Job Title is read: an older version turns it off.
    await save(db, { op: "vizzy_reads", key: "fld_000000000001", on: true }); // v7
    const off = await restoreFieldListVersion(ctx, "person", { rev: 2, baseRev: 7, by, nowIso: T2 }, db);
    expect(off).toMatchObject({ ok: true });
    expect((await readFieldList(ctx, "person", db)).items[0]).not.toHaveProperty("vizzyReads");
  });

  it("writes no version when nothing changed", async () => {
    const db = new FakeFirestore();
    await save(db, { op: "add", label: "Plan", type: "text" }, { fld: () => "fld_000000000001" });
    const r = await save(db, { op: "rename", key: "fld_000000000001", label: "Plan" });
    expect(r).toMatchObject({ ok: true, list: { rev: 1 } });
    expect((await listSettingsVersions(ctx, "fields:person", {}, db)).versions).toHaveLength(1);
  });
});
