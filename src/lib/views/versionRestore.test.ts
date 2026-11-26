import { describe, expect, it } from "vitest";
import type { SettingsVersion } from "@/lib/types/settingsVersion";
import type { SavedView } from "@/lib/types/savedView";
import { emptyView, type ViewDefinition } from "./types";
import { planTeamViewRestore, restoredViews, teamViewRestoreMessage } from "./versionRestore";

const T = (day: number) => `2026-11-${String(day).padStart(2, "0")}T10:00:00.000Z`;
const LATELY: ViewDefinition = { ...emptyView(), filters: [{ on: "last_active", op: "in_last", value: 30 }] };
const view = (key: string, label: string, extra: Partial<SavedView> = {}): SavedView => ({
  key,
  label,
  definition: emptyView(),
  version: 1,
  createdAt: T(1),
  createdBy: "usr_maya",
  changedAt: T(1),
  changedBy: "usr_maya",
  archivedAt: null,
  archivedBy: null,
  ...extra,
});
/** A version naming `keys`, with `snapshot` as its whole list. */
const version = (snapshot: SavedView[], keys: string[]): Pick<SettingsVersion, "items" | "snapshot"> => ({
  snapshot: { items: snapshot as unknown as SettingsVersion["snapshot"]["items"] },
  items: keys.map((key) => ({ key, label: snapshot.find((v) => v.key === key)?.label ?? key, change: "changed", before: null, after: { ...snapshot.find((v) => v.key === key) } })),
});
const A = "viw_aaaaaaaaaaaa";
const B = "viw_bbbbbbbbbbbb";
const C = "viw_cccccccccccc";
const opts = { by: "usr_tom", nowIso: T(20) };

describe("planTeamViewRestore", () => {
  it("changes only the views the version names, each with a new version, and keeps every other view as it is", () => {
    const now = [view(A, "Lately", { definition: emptyView(), version: 4 }), view(B, "Repots", { version: 2 }), view(C, "Gold", { archivedAt: T(5), archivedBy: "usr_maya" })];
    const then = version([view(A, "Active lately", { definition: LATELY, version: 2 }), view(B, "Old repots"), view(C, "Gold")], [A, C]);
    const r = planTeamViewRestore(now, then, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.items.map((v) => [v.key, v.label, v.version, v.archivedAt ?? null])).toEqual([
      [A, "Active lately", 5, null],
      [B, "Repots", 2, null],
      [C, "Gold", 2, null],
    ]);
    expect(r.plan.items[0]).toMatchObject({ definition: LATELY, changedAt: T(20), changedBy: "usr_tom", createdBy: "usr_maya" });
    expect(r.plan.changed.map((c) => c.next.key)).toEqual([A]);
    expect(r.plan.back.map((v) => v.key)).toEqual([C]);
    expect(r.plan.items[2]).toMatchObject({ archivedBy: null, replacedBy: null });
    expect(teamViewRestoreMessage(r.plan, 7)).toBe("Restored 2 team views as they were in version 7");
  });

  it("archives a view the version had archived, and leaves one already as it was alone", () => {
    const now = [view(A, "Lately"), view(B, "Repots", { archivedAt: T(3), archivedBy: "usr_maya" })];
    const r = planTeamViewRestore(now, version([view(A, "Lately", { archivedAt: T(2), archivedBy: "usr_maya" }), view(B, "Repots", { archivedAt: T(2) })], [A, B]), opts);
    if (!r.ok) throw new Error(r.error);
    expect(r.plan.archived.map((v) => v.key)).toEqual([A]);
    expect(r.plan.items[0]).toMatchObject({ archivedAt: T(20), archivedBy: "usr_tom", version: 2 });
    // Already archived: kept as it is, with when and who archived it.
    expect(r.plan.same.map((v) => v.key)).toEqual([B]);
    expect(r.plan.items[1]).toBe(now[1]);
    expect(restoredViews(r.plan).map((v) => v.key)).toEqual([A]);
    expect(teamViewRestoreMessage(r.plan, 3)).toBe("Restored ‘Lately’ as it was in version 3");
  });

  it("names the caps a restore would break, and refuses a version naming nothing or a view that doesn't fit", () => {
    const inUse = Array.from({ length: 50 }, (_, i) => view(`viw_use${String(i).padStart(9, "0")}`, `View ${i}`));
    const r = planTeamViewRestore([...inUse, view(A, "Lately", { archivedAt: T(3) })], version([view(A, "Lately")], [A]), opts);
    expect(r.ok && r.plan.problems).toEqual(["too_many_in_use"]);
    expect(planTeamViewRestore([view(A, "Lately")], version([view(A, "Lately")], []), opts)).toEqual({ ok: false, error: "nothing_to_restore" });
    const typed = view(A, "Domain", { definition: { ...emptyView(), filters: [{ on: "email_domain", op: "contains", value: "example.com" }] } as ViewDefinition });
    expect(planTeamViewRestore([view(A, "Lately")], version([typed], [A]), opts)).toEqual({ ok: false, error: "view_old_shape", label: "Domain" });
  });
});
