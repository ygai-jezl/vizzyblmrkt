import { commitMemberViews, commitSettingsChange, readMemberViews, readSetting, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { jsonBytes } from "@/lib/ontology/events";
import type { RecordField } from "@/lib/types/recordField";
import {
  MyViewSchema,
  SAVED_VIEW_LIMITS,
  SavedViewSchema,
  teamListProblems,
  ViewNameSchema,
  type MyView,
  type SavedView,
  type TeamViewList,
  type ViewScope,
} from "@/lib/types/savedView";
import { getSettingsVersion } from "@/lib/settings/history";
import { checkForSave } from "./conditions";
import { sameView, viewInOrder, type ViewDefinition } from "./types";
import { planTeamViewRestore, restoredViews, teamViewRestoreMessage } from "./versionRestore";

/**
 * Saved views on People (piece C, CRM_VIEWS_ENABLED): create, change, archive, bring back and delete.
 *
 * - Team views (Everyone on the team) are the settings subject `views:person`, saved only through
 *   commitSettingsChange, so each save is one settings version holding the whole list. Admins only
 *   (decision 4). Archived, never removed. Caps: 50 in use, 200 in all, the list under 200 KB, one
 *   view under 2 KB.
 * - Only me views belong to the signed in member (src/lib/tenant/memberViews.ts): anyone saves
 *   them, they are not logged, and they are deleted for real. 50 a member.
 * - A save whose list moved on reads it again and retries, up to 3 times; when the view itself
 *   changed since it was opened (its `version`), it answers `view_changed` and the route 409s.
 * - A view never keeps typed words (decision 3): `typed_words` names the filters that hold them.
 * - Settings › History restores team views one view at a time (restoreTeamViewsVersion, ADR-0024).
 */

export const TEAM_VIEWS_SUBJECT = "views:person" as const;
const TRIES = 3;

export type SavedViewError =
  | "admins_only"
  | "typed_words"
  | "invalid_view"
  | "invalid_name"
  | "view_too_large"
  | "team_views_full"
  | "my_views_full"
  | "view_not_found"
  | "view_changed"
  | "views_changed";

/** Each error's HTTP status. */
export const SAVED_VIEW_STATUS: Record<SavedViewError, number> = {
  admins_only: 403,
  typed_words: 400,
  invalid_view: 400,
  invalid_name: 400,
  view_too_large: 400,
  team_views_full: 400,
  my_views_full: 400,
  view_not_found: 404,
  view_changed: 409,
  views_changed: 409,
};

/** A saved view as the screens and Vizzy see it. */
export interface ShownView {
  id: string;
  scope: ViewScope;
  name: string;
  definition: ViewDefinition;
  version: number;
  archived: boolean;
  changedAt: string;
  /** Who changed it last, by user id (team views); null for an Only me view. */
  changedBy: string | null;
}

export type SaveResult = { ok: true; view: ShownView; message: string } | { ok: false; error: SavedViewError; filters?: number[] };

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/** `viw_` and 12 random lowercase letters or digits. */
export function newViewId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `viw_${[...bytes].map((b) => ALNUM[b % ALNUM.length]).join("")}`;
}

function teamShown(v: SavedView): ShownView {
  return { id: v.key, scope: "team", name: v.label, definition: viewInOrder(v.definition), version: v.version, archived: !!v.archivedAt, changedAt: v.changedAt, changedBy: v.changedBy };
}

function myShown(v: MyView): ShownView {
  return { id: v.key, scope: "me", name: v.label, definition: viewInOrder(v.definition), version: v.version, archived: false, changedAt: v.changedAt, changedBy: null };
}

/** The team list as stored: every item kept as it is, so a save never drops one that doesn't parse. */
export async function readTeamViews(ctx: TenantContext, db?: FirestoreLike): Promise<{ items: SavedView[]; rev: number }> {
  const stored = await readSetting<TeamViewList>(ctx, TEAM_VIEWS_SUBJECT, db);
  return { items: Array.isArray(stored?.value.items) ? stored!.value.items : [], rev: stored?.rev ?? 0 };
}

const parsedTeam = (items: readonly SavedView[]) => items.filter((v) => SavedViewSchema.safeParse(v).success);
const parsedMine = (views: readonly MyView[]) => views.filter((v) => MyViewSchema.safeParse(v).success);

/**
 * The team's views and the signed in member's own (two reads). Archived team views only with
 * `archived` (admins, to bring one back). Another brand's documents read as none.
 */
export async function listSavedViews(ctx: TenantContext, opts: { archived?: boolean } = {}, db?: FirestoreLike): Promise<{ team: ShownView[]; mine: ShownView[] }> {
  const [team, mine] = await Promise.all([readTeamViews(ctx, db), readMemberViews(ctx, db)]);
  return {
    team: parsedTeam(team.items)
      .filter((v) => opts.archived || !v.archivedAt)
      .map(teamShown),
    mine: parsedMine(mine.views).map(myShown),
  };
}

/** One saved view the signed in member may open: a team view (archived ones for admins), or one of their own. */
export async function findSavedView(ctx: TenantContext, id: string, db?: FirestoreLike): Promise<ShownView | null> {
  const { team, mine } = await listSavedViews(ctx, { archived: ctx.role === "admin" }, db);
  return team.find((v) => v.id === id) ?? mine.find((v) => v.id === id) ?? null;
}

type Planned<V> = { ok: true; list: V[]; view: V; message: string; unchanged?: boolean } | { ok: false; error: SavedViewError };

const clip = (s: string) => s.slice(0, 200);

/** Save the team list through the settings log, retrying when the list moved on. Admins only. */
async function saveTeam(ctx: TenantContext, plan: (items: SavedView[]) => Planned<SavedView>, nowIso: string, db?: FirestoreLike): Promise<SaveResult> {
  if (ctx.role !== "admin" || !ctx.userId) return { ok: false, error: "admins_only" };
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const { items, rev } = await readTeamViews(ctx, db);
    const p = plan(items);
    if (!p.ok) return p;
    if (p.unchanged) return { ok: true, view: teamShown(p.view), message: p.message };
    const problems = teamListProblems(p.list);
    if (problems.includes("view_too_large")) return { ok: false, error: "view_too_large" };
    if (problems.length) return { ok: false, error: "team_views_full" };
    const r = await commitSettingsChange<TeamViewList>(
      ctx,
      { subject: TEAM_VIEWS_SUBJECT, baseRev: rev, value: { items: p.list }, by: { type: "member", id: ctx.userId }, source: "editor", message: clip(p.message), nowIso },
      db,
    );
    if (r.ok) return { ok: true, view: teamShown(p.view), message: p.message };
  }
  return { ok: false, error: "views_changed" };
}

/** Save the signed in member's own list, retrying when it moved on (another tab). */
async function saveMine(ctx: TenantContext, plan: (views: MyView[]) => Planned<MyView>, nowIso: string, db?: FirestoreLike): Promise<SaveResult> {
  if (!ctx.userId) return { ok: false, error: "view_not_found" };
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const stored = await readMemberViews(ctx, db);
    const p = plan(stored.views);
    if (!p.ok) return p;
    if (p.unchanged) return { ok: true, view: myShown(p.view), message: p.message };
    if (p.list.some((v) => jsonBytes(v) > SAVED_VIEW_LIMITS.viewBytes)) return { ok: false, error: "view_too_large" };
    if (p.list.length > SAVED_VIEW_LIMITS.mine) return { ok: false, error: "my_views_full" };
    const r = await commitMemberViews(ctx, { baseRev: stored.rev, views: p.list, nowIso }, db);
    if (r.ok) return { ok: true, view: myShown(p.view), message: p.message };
  }
  return { ok: false, error: "views_changed" };
}

type Checked = { ok: true; name?: string; definition?: ViewDefinition } | { ok: false; error: SavedViewError; filters?: number[] };

/** The name and view a save carries, checked: a name of 1 to 60 characters, a view the field list allows, no typed words. */
function checkInput(input: { name?: unknown; definition?: unknown }, fields: readonly RecordField[]): Checked {
  let name: string | undefined;
  if (input.name !== undefined) {
    const n = ViewNameSchema.safeParse(input.name);
    if (!n.success) return { ok: false, error: "invalid_name" };
    name = n.data;
  }
  if (input.definition === undefined) return { ok: true, name };
  const d = checkForSave(input.definition, fields);
  if (!d.ok) return d.error === "typed_words" ? { ok: false, error: "typed_words", filters: d.filters } : { ok: false, error: "invalid_view" };
  return { ok: true, name, definition: d.definition };
}

/** Save a new view: for the team (admins) or only for the signed in member (anyone). */
export async function createSavedView(
  ctx: TenantContext,
  input: { scope: ViewScope; name: unknown; definition: unknown; fields: readonly RecordField[]; nowIso?: string; newId?: () => string },
  db?: FirestoreLike,
): Promise<SaveResult> {
  if (input.scope === "team" && ctx.role !== "admin") return { ok: false, error: "admins_only" };
  const c = checkInput({ name: input.name, definition: input.definition }, input.fields);
  if (!c.ok) return c;
  if (c.name === undefined || c.definition === undefined) return { ok: false, error: "invalid_name" };
  const name = c.name;
  const definition = c.definition;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const key = (input.newId ?? newViewId)();
  if (input.scope === "team") {
    return saveTeam(
      ctx,
      (items) => {
        const view: SavedView = { key, label: name, definition, version: 1, createdAt: nowIso, createdBy: ctx.userId ?? null, changedAt: nowIso, changedBy: ctx.userId ?? null, archivedAt: null, archivedBy: null };
        return { ok: true, list: [...items, view], view, message: `Saved team view ‘${name}’` };
      },
      nowIso,
      db,
    );
  }
  return saveMine(
    ctx,
    (views) => {
      const view: MyView = { key, label: name, definition, version: 1, createdAt: nowIso, changedAt: nowIso };
      return { ok: true, list: [...views, view], view, message: `Saved ‘${name}’ for you` };
    },
    nowIso,
    db,
  );
}

/** Which list holds a view: the team's or the signed in member's. */
async function scopeOf(ctx: TenantContext, id: string, db?: FirestoreLike): Promise<ViewScope | null> {
  const [team, mine] = await Promise.all([readTeamViews(ctx, db), readMemberViews(ctx, db)]);
  if (team.items.some((v) => v.key === id)) return "team";
  if (mine.views.some((v) => v.key === id)) return "me";
  return null;
}

/**
 * Change a view's name or filters, columns and sort, from the version it was opened at. A team
 * view is changed by admins only, and one that is archived must be brought back first.
 */
export async function changeSavedView(
  ctx: TenantContext,
  id: string,
  input: { version: number; name?: unknown; definition?: unknown; fields: readonly RecordField[]; nowIso?: string },
  db?: FirestoreLike,
): Promise<SaveResult> {
  const scope = await scopeOf(ctx, id, db);
  if (!scope) return { ok: false, error: "view_not_found" };
  if (scope === "team" && ctx.role !== "admin") return { ok: false, error: "admins_only" };
  const c = checkInput({ name: input.name, definition: input.definition }, input.fields);
  if (!c.ok) return c;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const next = <V extends SavedView | MyView>(v: V): { view: V; unchanged: boolean; message: string } => {
    const label = c.name ?? v.label;
    const definition = c.definition ?? v.definition;
    const unchanged = label === v.label && sameView(definition, v.definition);
    const message = label !== v.label ? `Renamed ‘${v.label}’ to ‘${label}’` : `Changed ‘${label}’`;
    return { view: unchanged ? v : { ...v, label, definition, version: v.version + 1, changedAt: nowIso, ...(scope === "team" ? { changedBy: ctx.userId ?? null } : {}) }, unchanged, message };
  };
  if (scope === "team") {
    return saveTeam(
      ctx,
      (items) => {
        const i = items.findIndex((v) => v.key === id);
        if (i < 0 || items[i]!.archivedAt) return { ok: false, error: "view_not_found" };
        if (items[i]!.version !== input.version) return { ok: false, error: "view_changed" };
        const n = next(items[i]!);
        return { ok: true, list: items.map((v, j) => (j === i ? n.view : v)), view: n.view, message: `${n.message}, a team view`, unchanged: n.unchanged };
      },
      nowIso,
      db,
    );
  }
  return saveMine(
    ctx,
    (views) => {
      const i = views.findIndex((v) => v.key === id);
      if (i < 0) return { ok: false, error: "view_not_found" };
      if (views[i]!.version !== input.version) return { ok: false, error: "view_changed" };
      const n = next(views[i]!);
      return { ok: true, list: views.map((v, j) => (j === i ? n.view : v)), view: n.view, message: n.message, unchanged: n.unchanged };
    },
    nowIso,
    db,
  );
}

/**
 * Take a view away: a team view is archived (admins; it stays in the list and the settings log, and
 * can be brought back), an Only me view is deleted for real.
 */
export async function removeSavedView(ctx: TenantContext, id: string, input: { version: number; nowIso?: string }, db?: FirestoreLike): Promise<SaveResult> {
  const scope = await scopeOf(ctx, id, db);
  if (!scope) return { ok: false, error: "view_not_found" };
  const nowIso = input.nowIso ?? new Date().toISOString();
  if (scope === "team") {
    if (ctx.role !== "admin") return { ok: false, error: "admins_only" };
    return saveTeam(
      ctx,
      (items) => {
        const i = items.findIndex((v) => v.key === id);
        if (i < 0) return { ok: false, error: "view_not_found" };
        const v = items[i]!;
        if (v.archivedAt) return { ok: true, list: items, view: v, message: `Archived ‘${v.label}’`, unchanged: true };
        if (v.version !== input.version) return { ok: false, error: "view_changed" };
        const view = { ...v, archivedAt: nowIso, archivedBy: ctx.userId ?? null, version: v.version + 1, changedAt: nowIso, changedBy: ctx.userId ?? null };
        return { ok: true, list: items.map((x, j) => (j === i ? view : x)), view, message: `Archived team view ‘${v.label}’` };
      },
      nowIso,
      db,
    );
  }
  return saveMine(
    ctx,
    (views) => {
      const i = views.findIndex((v) => v.key === id);
      if (i < 0) return { ok: false, error: "view_not_found" };
      if (views[i]!.version !== input.version) return { ok: false, error: "view_changed" };
      return { ok: true, list: views.filter((_, j) => j !== i), view: views[i]!, message: `Deleted ‘${views[i]!.label}’` };
    },
    nowIso,
    db,
  );
}

/** Bring an archived team view back into use (admins), within the 50 in use. */
export async function restoreTeamView(ctx: TenantContext, id: string, input: { nowIso?: string } = {}, db?: FirestoreLike): Promise<SaveResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  return saveTeam(
    ctx,
    (items) => {
      const i = items.findIndex((v) => v.key === id);
      if (i < 0) return { ok: false, error: "view_not_found" };
      const v = items[i]!;
      if (!v.archivedAt) return { ok: true, list: items, view: v, message: `Brought back ‘${v.label}’`, unchanged: true };
      const view = { ...v, archivedAt: null, archivedBy: null, replacedBy: null, version: v.version + 1, changedAt: nowIso, changedBy: ctx.userId ?? null };
      return { ok: true, list: items.map((x, j) => (j === i ? view : x)), view, message: `Brought back team view ‘${v.label}’` };
    },
    nowIso,
    db,
  );
}

export type TeamViewsRestoreError = "admins_only" | "views_changed" | "version_not_found" | "view_old_shape" | "nothing_to_restore" | "team_views_full";

export type TeamViewsRestoreResult = { ok: true; rev: number; message: string | null } | { ok: false; error: TeamViewsRestoreError };

/**
 * Restore the views a team views version names, as that version had them, as a new version on top
 * (Settings › History, ADR-0024): one view at a time, every other team view as it is now. Admins
 * only, from the rev the preview showed: a save in between answers `views_changed` and writes
 * nothing. Views already as the version had them write nothing either.
 */
export async function restoreTeamViewsVersion(
  ctx: TenantContext,
  input: { rev: number; baseRev: number; nowIso?: string },
  db?: FirestoreLike,
): Promise<TeamViewsRestoreResult> {
  if (ctx.role !== "admin" || !ctx.userId) return { ok: false, error: "admins_only" };
  const nowIso = input.nowIso ?? new Date().toISOString();
  const [current, target] = await Promise.all([readTeamViews(ctx, db), getSettingsVersion(ctx, TEAM_VIEWS_SUBJECT, input.rev, db)]);
  if (current.rev !== input.baseRev) return { ok: false, error: "views_changed" };
  if (!target) return { ok: false, error: "version_not_found" };
  const p = planTeamViewRestore(current.items, target, { by: ctx.userId, nowIso });
  if (!p.ok) return { ok: false, error: p.error };
  if (p.plan.problems.length) return { ok: false, error: "team_views_full" };
  if (!restoredViews(p.plan).length) return { ok: true, rev: current.rev, message: null };
  const message = teamViewRestoreMessage(p.plan, input.rev);
  const r = await commitSettingsChange<TeamViewList>(
    ctx,
    { subject: TEAM_VIEWS_SUBJECT, baseRev: input.baseRev, value: { items: p.plan.items }, by: { type: "member", id: ctx.userId }, source: "restore", restoredFrom: input.rev, message: clip(message), nowIso },
    db,
  );
  if (!r.ok) return { ok: false, error: "views_changed" };
  return { ok: true, rev: r.rev, message };
}
