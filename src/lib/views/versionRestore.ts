import type { SettingsVersion } from "@/lib/types/settingsVersion";
import { SavedViewSchema, teamListProblems, type SavedView, type TeamListProblem } from "@/lib/types/savedView";
import { isWordsOp, sameView } from "./types";

/**
 * Restoring team views from Settings › History (piece C with O2, ADR-0024): one view at a time.
 * A version of the `views:person` setting names the views its save changed (a team save changes
 * one). Restoring it puts those views back as that version had them (name, filters, columns, sort,
 * and in use or archived) and leaves every other team view as it is now, so one admin's restore
 * never undoes another's change to a different view. It is saved as a new version on top.
 *
 * Each view that changes gets a new `version`, so a copy someone has open answers `view_changed`
 * instead of undoing the restore. Only me views are never in the settings log, so never here.
 * Pure: plain data only.
 */

export interface TeamViewRestorePlan {
  /** The team's list after the restore: every view kept, none removed. */
  items: SavedView[];
  /** Every view the version names, as the restore leaves it (those in `same` unchanged). */
  views: SavedView[];
  /** Archived now, in use in the version: back in the Views menu. */
  back: SavedView[];
  /** In use now, archived in the version: archived again. */
  archived: SavedView[];
  /** Name, filters, columns or sort go back, from the view as it is now. */
  changed: Array<{ now: SavedView; next: SavedView }>;
  /** Already as the version had them. */
  same: SavedView[];
  /** Caps the restore would break that the list doesn't break now. */
  problems: TeamListProblem[];
}

export type TeamViewRestoreRefusal =
  /** The version names no view. */
  | { ok: false; error: "nothing_to_restore" }
  /** A view in it doesn't fit today's views (or holds typed words, which no save keeps). */
  | { ok: false; error: "view_old_shape"; label: string };

export type TeamViewRestorePlanResult = { ok: true; plan: TeamViewRestorePlan } | TeamViewRestoreRefusal;

/** A view as the version had it: its snapshot's, else the version's own line. */
function thenOf(version: Pick<SettingsVersion, "items" | "snapshot">, key: string): unknown {
  return version.snapshot.items.find((v) => v.key === key) ?? version.items.find((i) => i.key === key)?.after ?? null;
}

/**
 * What restoring the views a team views version names does, from the list as it is now. `by` is
 * the admin restoring (a user id), `nowIso` when.
 */
export function planTeamViewRestore(
  current: readonly SavedView[],
  version: Pick<SettingsVersion, "items" | "snapshot">,
  opts: { by: string | null; nowIso: string },
): TeamViewRestorePlanResult {
  const keys = [...new Set(version.items.map((i) => i.key))];
  if (!keys.length) return { ok: false, error: "nothing_to_restore" };
  const now = new Map(current.map((v) => [v.key, v]));
  const next = new Map<string, SavedView>();
  const plan: TeamViewRestorePlan = { items: [], views: [], back: [], archived: [], changed: [], same: [], problems: [] };
  for (const key of keys) {
    const raw = thenOf(version, key);
    const parsed = SavedViewSchema.safeParse(raw);
    if (!parsed.success || parsed.data.definition.filters.some((f) => isWordsOp(f.op))) {
      const label = (raw as { label?: unknown } | null)?.label;
      return { ok: false, error: "view_old_shape", label: typeof label === "string" ? label : (version.items.find((i) => i.key === key)?.label ?? "") };
    }
    const then = parsed.data;
    const was = now.get(key) ?? null;
    const thenArchived = !!then.archivedAt;
    if (was && was.label === then.label && sameView(was.definition, then.definition) && !!was.archivedAt === thenArchived) {
      plan.same.push(was);
      plan.views.push(was);
      continue;
    }
    const base = was ?? then;
    const view: SavedView = {
      ...base,
      label: then.label,
      definition: then.definition,
      version: (was?.version ?? then.version) + 1,
      changedAt: opts.nowIso,
      changedBy: opts.by,
      // Archived in the version: archived now, keeping when it was archived if it already is.
      archivedAt: thenArchived ? (was?.archivedAt ?? opts.nowIso) : null,
      archivedBy: thenArchived ? (was?.archivedAt ? (was.archivedBy ?? null) : opts.by) : null,
      ...(thenArchived ? {} : { replacedBy: null }),
    };
    next.set(key, view);
    plan.views.push(view);
    if (!was || (was.archivedAt && !thenArchived)) plan.back.push(view);
    else if (!was.archivedAt && thenArchived) plan.archived.push(view);
    else plan.changed.push({ now: was, next: view });
  }
  plan.items = [...current.map((v) => next.get(v.key) ?? v), ...[...next.values()].filter((v) => !now.has(v.key))];
  const before = new Set(teamListProblems(current));
  plan.problems = teamListProblems(plan.items).filter((p) => !before.has(p));
  return { ok: true, plan };
}

/** The views a restore changes: every one the version names but those already as it had them. */
export function restoredViews(plan: Pick<TeamViewRestorePlan, "views" | "same">): SavedView[] {
  const same = new Set(plan.same.map((v) => v.key));
  return plan.views.filter((v) => !same.has(v.key));
}

/** What a restore's version says: "Restored ‘Wholesale’ as it was in version 4". */
export function teamViewRestoreMessage(plan: Pick<TeamViewRestorePlan, "views" | "same">, rev: number): string {
  const changed = restoredViews(plan);
  return changed.length === 1 ? `Restored ‘${changed[0]!.label}’ as it was in version ${rev}` : `Restored ${changed.length} team views as they were in version ${rev}`;
}
