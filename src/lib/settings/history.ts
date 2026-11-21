import { commitSettingsChange, forTenant, readSetting, settingsVersionId, type SettingsCommit, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { EventActor } from "@/lib/ontology/events";
import type { SettingsItem, SettingsList, SettingsSubject, SettingsVersion } from "@/lib/types/settingsVersion";
import { FORMER_TEAM_MEMBER, memberLabel } from "@/lib/team/names";
import { describeItemChanges, isArchived, sameItem } from "./archive";

/**
 * Reading and restoring the settings log (piece O part 1). Every version is kept: nothing is
 * pruned, and a restore is saved as a new version on top, so the one it replaces stays in the
 * history. Versions are read through forTenant(ctx).settingsVersions and written only by
 * commitSettingsChange (src/lib/tenant/settingsLog.ts).
 */

export { settingsVersionId, FORMER_TEAM_MEMBER };

/** Versions per page when the caller doesn't say. */
export const VERSIONS_PAGE = 20;
const MAX_PAGE = 100;

/**
 * One subject's versions, newest first, a page at a time: pass `nextCursor` back as `cursor`.
 * Reads by (tenantId, subject, rev DESC), the index firestore.indexes.json lists for it.
 */
export async function listSettingsVersions(
  ctx: TenantContext,
  subject: SettingsSubject,
  opts: { cursor?: number | null; limit?: number } = {},
  db?: FirestoreLike,
): Promise<{ versions: SettingsVersion[]; nextCursor: number | null }> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? VERSIONS_PAGE)), MAX_PAGE);
  const rows = await forTenant(ctx, db).settingsVersions.find({
    where: [["subject", "==", subject]],
    orderBy: [["rev", "desc"]],
    ...(opts.cursor ? { startAfter: [opts.cursor] } : {}),
    limit: limit + 1,
  });
  const versions = rows.slice(0, limit);
  return { versions, nextCursor: rows.length > limit ? versions[versions.length - 1]!.rev : null };
}

/** One version by its rev, or null. */
export async function getSettingsVersion(ctx: TenantContext, subject: SettingsSubject, rev: number, db?: FirestoreLike): Promise<SettingsVersion | null> {
  if (!Number.isInteger(rev) || rev < 1) return null;
  const v = await forTenant(ctx, db).settingsVersions.getById(settingsVersionId(ctx.tenantId, subject, rev));
  return v && v.subject === subject && v.rev === rev ? v : null;
}

export interface RestorePlan<I extends SettingsItem> {
  /** The setting's items after the restore: every current item kept, none removed. */
  items: I[];
  /** Items that come back from the archive (or were missing). */
  back: I[];
  /** Items in use now that the older version didn't have in use, so they are archived. */
  archived: I[];
  /** Items in use in both whose details go back to the older version's. */
  changed: I[];
  unchanged: I[];
}

/**
 * What restoring `target` (an older version's items) over `current` does, without saving: each
 * item the older version has takes its details from it, and each item it doesn't have is
 * archived, never removed. Pure.
 */
export function planRestore<I extends SettingsItem>(current: readonly I[], target: readonly I[], nowIso: string): RestorePlan<I> {
  const old = new Map(target.map((it) => [it.key, it]));
  const plan: RestorePlan<I> = { items: [], back: [], archived: [], changed: [], unchanged: [] };
  for (const now of current) {
    const was = old.get(now.key);
    old.delete(now.key);
    const next: I = was ? { ...was } : isArchived(now) ? now : { ...now, archivedAt: nowIso };
    plan.items.push(next);
    if (isArchived(now) && !isArchived(next)) plan.back.push(next);
    else if (!isArchived(now) && isArchived(next)) plan.archived.push(next);
    else if (sameItem(now, next)) plan.unchanged.push(next);
    else plan.changed.push(next);
  }
  // An item only the older version has: it can't happen when nothing is ever removed, but it comes back if it does.
  for (const was of old.values()) {
    plan.items.push({ ...was });
    if (!isArchived(was)) plan.back.push(was);
  }
  return plan;
}

export type RestoreResult = SettingsCommit<SettingsList> | { ok: false; error: "version_not_found" };

/**
 * Bring back an earlier version as a new one, from the rev the page shows (`baseRev`). Refused,
 * like a save, when the setting has moved on since.
 */
export async function restoreSettingsVersion(
  ctx: TenantContext,
  input: { subject: SettingsSubject; rev: number; baseRev: number; by: EventActor; message?: string | null; nowIso?: string },
  db?: FirestoreLike,
): Promise<RestoreResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const [target, current] = await Promise.all([
    getSettingsVersion(ctx, input.subject, input.rev, db),
    readSetting(ctx, input.subject, db),
  ]);
  if ((current?.rev ?? 0) !== input.baseRev) return { ok: false, error: "settings_changed", current };
  if (!target) return { ok: false, error: "version_not_found" };
  const now = current?.value ?? { items: [] };
  const plan = planRestore(now.items, target.snapshot.items, nowIso);
  return commitSettingsChange(
    ctx,
    {
      subject: input.subject,
      baseRev: input.baseRev,
      value: { ...target.snapshot, items: plan.items },
      by: input.by,
      source: "restore",
      restoredFrom: input.rev,
      message: input.message ?? null,
      items: describeItemChanges(now.items, plan.items),
      nowIso,
    },
    db,
  );
}

/**
 * Who saved a version, in words: a team member's name from `names` (user id to name, looked up
 * when shown), or "Former team member" when they are no longer on the team.
 */
export function byLabel(by: EventActor, names: Readonly<Record<string, string>>): string {
  switch (by.type) {
    case "member":
      return memberLabel(by.id, names);
    case "agent":
      return "Vizzy";
    case "product":
      return "Your product";
    case "person":
      return "A person";
    case "system":
      return "YouGrow";
  }
}
