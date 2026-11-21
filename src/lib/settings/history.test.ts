import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { commitSettingsChange, readSetting } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { SettingsItem, SettingsList } from "@/lib/types/settingsVersion";
import { archiveItem, changeType } from "./archive";
import { byLabel, FORMER_TEAM_MEMBER, getSettingsVersion, listSettingsVersions, planRestore, restoreSettingsVersion } from "./history";

type Field = SettingsItem & { type: string; options?: string[] };
const ctx: TenantContext = { tenantId: "ten_A", region: "eu", source: "idtoken", role: "admin", userId: "usr_1" };
const NOW = "2026-11-20T10:00:00.000Z";
const LATER = "2026-11-21T10:00:00.000Z";
const by = { type: "member", id: "usr_1" } as const;
const plan: Field = { key: "fld_plan", label: "Plan", type: "select", options: ["Free", "Pro"] };
const role: Field = { key: "fld_role", label: "Role", type: "text" };

async function saveAll(db: FakeFirestore, lists: Field[][]) {
  for (const [i, items] of lists.entries()) {
    const r = await commitSettingsChange<SettingsList<Field>>(ctx, { subject: "fields:person", baseRev: i, value: { items }, by, source: "editor", nowIso: NOW }, db);
    expect(r.ok).toBe(true);
  }
}

describe("the settings history", () => {
  it("keeps every version and lists them newest first, a page at a time", async () => {
    const db = new FakeFirestore();
    const lists: Field[][] = [];
    let items: Field[] = [];
    for (let n = 1; n <= 150; n += 1) {
      items = [...items, { key: `fld_${n}`, label: `Field ${n}`, type: "text" }];
      lists.push(items);
    }
    await saveAll(db, lists);
    const seen: number[] = [];
    let cursor: number | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof listSettingsVersions>> = await listSettingsVersions(ctx, "fields:person", { cursor, limit: 40 }, db);
      seen.push(...page.versions.map((v) => v.rev));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(4);
    expect(seen).toEqual(Array.from({ length: 150 }, (_, i) => 150 - i));
    // Another subject and another brand list nothing.
    expect((await listSettingsVersions(ctx, "fields:company", {}, db)).versions).toEqual([]);
    expect((await listSettingsVersions({ ...ctx, tenantId: "ten_B" }, "fields:person", {}, db)).versions).toEqual([]);
  });

  it("gets one version by its rev", async () => {
    const db = new FakeFirestore();
    await saveAll(db, [[plan], [plan, role]]);
    expect(await getSettingsVersion(ctx, "fields:person", 1, db)).toMatchObject({ rev: 1, snapshot: { items: [plan] } });
    expect(await getSettingsVersion(ctx, "fields:person", 2, db)).toMatchObject({ rev: 2, items: [{ key: "fld_role", change: "added" }] });
    expect(await getSettingsVersion(ctx, "fields:person", 3, db)).toBeNull();
    expect(await getSettingsVersion(ctx, "fields:person", 0, db)).toBeNull();
    expect(await getSettingsVersion(ctx, "fields:company", 1, db)).toBeNull();
    expect(await getSettingsVersion({ ...ctx, tenantId: "ten_B" }, "fields:person", 1, db)).toBeNull();
  });

  it("restores an earlier version as a new one, archiving what it didn't have", async () => {
    const db = new FakeFirestore();
    const renamed: Field = { ...plan, label: "Pricing plan" };
    await saveAll(db, [[plan], [renamed, role]]);
    const r = await restoreSettingsVersion(ctx, { subject: "fields:person", rev: 1, baseRev: 2, by, nowIso: LATER }, db);
    expect(r).toMatchObject({
      ok: true,
      rev: 3,
      version: {
        source: "restore",
        restoredFrom: 1,
        items: [
          { key: "fld_plan", change: "changed", label: "Plan" },
          { key: "fld_role", change: "archived" },
        ],
      },
    });
    const stored = await readSetting<SettingsList<Field>>(ctx, "fields:person", db);
    expect(stored?.rev).toBe(3);
    expect(stored?.value.items).toEqual([plan, { ...role, archivedAt: LATER }]);
    // The version it replaced is still there.
    expect((await listSettingsVersions(ctx, "fields:person", {}, db)).versions.map((v) => v.rev)).toEqual([3, 2, 1]);
  });

  it("refuses a restore from an out of date page, or of a version it doesn't have", async () => {
    const db = new FakeFirestore();
    await saveAll(db, [[plan], [plan, role]]);
    expect(await restoreSettingsVersion(ctx, { subject: "fields:person", rev: 1, baseRev: 1, by }, db)).toMatchObject({ ok: false, error: "settings_changed", current: { rev: 2 } });
    expect(await restoreSettingsVersion(ctx, { subject: "fields:person", rev: 9, baseRev: 2, by }, db)).toEqual({ ok: false, error: "version_not_found" });
    expect((await listSettingsVersions(ctx, "fields:person", {}, db)).versions).toHaveLength(2);
  });
});

describe("planRestore", () => {
  it("says what comes back, what is archived, what changes and what stays", () => {
    const size: Field = { key: "fld_size", label: "Company size", type: "number" };
    const current = [{ ...plan, options: ["Free", "Pro", "Team"] }, ...archiveItem([role], "fld_role", NOW), size];
    const target = [plan, role];
    const p = planRestore(current, target, LATER);
    expect(p.back.map((f) => f.key)).toEqual(["fld_role"]);
    expect(p.archived.map((f) => f.key)).toEqual(["fld_size"]);
    expect(p.changed.map((f) => f.key)).toEqual(["fld_plan"]);
    expect(p.unchanged).toEqual([]);
    expect(p.items).toEqual([plan, role, { ...size, archivedAt: LATER }]);
    expect(planRestore(target, target, LATER)).toMatchObject({ back: [], archived: [], changed: [], unchanged: target });
  });

  it("brings back the older version's options as they were, and archives an option added since", () => {
    type Opt = { id: string; label: string; archivedAt?: string | null };
    type Picked = SettingsItem & { options: Opt[] };
    const then: Picked = { key: "fld_tier", label: "Tier", options: [{ id: "opt_free", label: "Free" }, { id: "opt_old", label: "Old", archivedAt: NOW }] };
    const now: Picked = {
      key: "fld_tier",
      label: "Tier",
      options: [
        { id: "opt_free", label: "Free plan" },
        { id: "opt_old", label: "Old", archivedAt: null },
        { id: "opt_pro", label: "Pro" },
        { id: "opt_gone", label: "Gone", archivedAt: NOW },
      ],
    };
    const p = planRestore([now], [then], LATER);
    expect(p.items[0]!.options).toEqual([
      { id: "opt_free", label: "Free" },
      { id: "opt_old", label: "Old", archivedAt: NOW },
      { id: "opt_pro", label: "Pro", archivedAt: LATER },
      { id: "opt_gone", label: "Gone", archivedAt: NOW },
    ]);
    expect(p.changed.map((f) => f.key)).toEqual(["fld_tier"]);
    // Options added to a field that had none yet are kept too.
    expect(planRestore([now], [{ ...then, options: [] }], LATER).items[0]!.options.map((o) => o.id)).toEqual(["opt_free", "opt_old", "opt_pro", "opt_gone"]);
  });

  it("brings back a field whose type was changed, and archives its replacement", () => {
    const changed = changeType([plan, role], "fld_role", { key: "fld_role_2", label: "Role", type: "select" }, NOW);
    const p = planRestore(changed, [plan, role], LATER);
    expect(p.back.map((f) => f.key)).toEqual(["fld_role"]);
    expect(p.archived.map((f) => f.key)).toEqual(["fld_role_2"]);
    expect(p.items.map((f) => f.key)).toEqual(["fld_plan", "fld_role", "fld_role_2"]);
  });
});

describe("byLabel", () => {
  it("names a team member from the names looked up, and anyone who left as a former team member", () => {
    const names = { usr_1: "Sam Rivera" };
    expect(byLabel({ type: "member", id: "usr_1" }, names)).toBe("Sam Rivera");
    expect(byLabel({ type: "member", id: "usr_gone" }, names)).toBe(FORMER_TEAM_MEMBER);
    expect(byLabel({ type: "member", id: null }, names)).toBe(FORMER_TEAM_MEMBER);
    expect(byLabel({ type: "agent", id: "aa_0123456789abcdef0123456789abcdef01234567" }, names)).toBe("Vizzy");
    expect(byLabel({ type: "system", id: null }, names)).toBe("YouGrow");
  });
});
