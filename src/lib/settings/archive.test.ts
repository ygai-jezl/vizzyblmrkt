import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { SettingsItem } from "@/lib/types/settingsVersion";
import {
  archiveItem,
  assertNoRemoval,
  changeType,
  describeItemChanges,
  isArchived,
  itemChangeText,
  restoreItem,
  sameItem,
  SettingsRemovalError,
} from "./archive";

type Field = SettingsItem & { type: string; options?: string[] };
const NOW = "2026-11-20T10:00:00.000Z";
const LATER = "2026-11-21T10:00:00.000Z";
const plan: Field = { key: "fld_plan", label: "Plan", type: "select", options: ["Free", "Pro"] };
const role: Field = { key: "fld_role", label: "Role", type: "text" };

describe("archive, never delete", () => {
  it("refuses a save that drops an item, naming its key", () => {
    expect(() => assertNoRemoval([plan, role], [plan])).toThrow(SettingsRemovalError);
    try {
      assertNoRemoval([plan, role], [plan]);
    } catch (err) {
      expect((err as SettingsRemovalError).keys).toEqual(["fld_role"]);
    }
    expect(() => assertNoRemoval([plan], [plan, role])).not.toThrow();
    expect(() => assertNoRemoval([plan, role], archiveItem([plan, role], "fld_role", NOW))).not.toThrow();
  });

  it("archives and restores an item, keeping it in the list", () => {
    const archived = archiveItem([plan, role], "fld_role", NOW);
    expect(archived).toHaveLength(2);
    expect(isArchived(archived[1]!)).toBe(true);
    expect(archived[1]!.archivedAt).toBe(NOW);
    // Archiving twice keeps the first time.
    expect(archiveItem(archived, "fld_role", LATER)[1]!.archivedAt).toBe(NOW);
    const back = restoreItem(archived, "fld_role");
    expect(isArchived(back[1]!)).toBe(false);
    expect(back[1]).toMatchObject({ key: "fld_role", label: "Role", type: "text" });
  });

  it("changes a type by adding a new item and archiving the old one with replacedBy", () => {
    const next = changeType([plan, role], "fld_role", { key: "fld_role_2", label: "Role", type: "select", options: ["Founder"] }, NOW);
    expect(next.map((f) => f.key)).toEqual(["fld_plan", "fld_role", "fld_role_2"]);
    expect(next[1]).toMatchObject({ type: "text", archivedAt: NOW, replacedBy: "fld_role_2" });
    expect(next[2]).toMatchObject({ type: "select", archivedAt: null });
    expect(() => assertNoRemoval([plan, role], next)).not.toThrow();
    expect(() => changeType([plan, role], "fld_role", { ...role }, NOW)).toThrow(/settings_item_exists/);
    expect(() => changeType([plan, role], "fld_gone", { key: "fld_new", label: "New", type: "text" }, NOW)).toThrow(/settings_item_not_found/);
  });

  it("describes what changed, item by item", () => {
    const after: Field[] = [
      { ...plan, options: ["Free", "Pro", "Team"] },
      { ...role, archivedAt: NOW },
      { key: "fld_size", label: "Company size", type: "number" },
    ];
    expect(describeItemChanges([plan, role], after).map((i) => [i.key, i.change])).toEqual([
      ["fld_plan", "changed"],
      ["fld_role", "archived"],
      ["fld_size", "added"],
    ]);
    expect(describeItemChanges(after, restoreItem(after, "fld_role")).map((i) => i.change)).toEqual(["restored"]);
    expect(describeItemChanges([plan], [{ options: ["Free", "Pro"], type: "select", label: "Plan", key: "fld_plan" }])).toEqual([]);
    const added = describeItemChanges([], [plan])[0]!;
    expect(added).toMatchObject({ before: null, after: { key: "fld_plan", options: ["Free", "Pro"] } });
  });

  it("compares items whatever order their keys were written in", () => {
    expect(sameItem({ key: "a", label: "A", archivedAt: undefined }, { label: "A", key: "a" })).toBe(true);
    expect(sameItem({ key: "a", label: "A" }, { key: "a", label: "B" })).toBe(false);
  });

  it("words each change plainly, in house style", () => {
    for (const change of ["added", "changed", "archived", "restored"] as const) {
      const text = itemChangeText({ change, label: "Plan" });
      expect(text).toMatch(/^[A-Z][a-z]+ ‘Plan’$/);
      expect(dashesIn(text)).toEqual([]);
      expect(aiTellsIn(text)).toEqual([]);
    }
  });
});
