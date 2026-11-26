import { z } from "zod";
import { readFieldList } from "@/lib/audience/fieldList";
import { getTenantById, isRateLimited, type RateLimitConfig, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { isViewId, VIEW_SCOPES } from "@/lib/types/savedView";
import { viewBackend } from "./backend";
import {
  changeSavedView,
  createSavedView,
  findSavedView,
  listSavedViews,
  removeSavedView,
  restoreTeamView,
  SAVED_VIEW_STATUS,
  type SaveResult,
} from "./savedViews";
import { readViewRows } from "./source";
import { VIEW_LIMITS, ViewDefinitionSchema } from "./types";

/**
 * The views routes' work (piece C, CRM_VIEWS_ENABLED), after viewsAdmin (switch, same origin, a
 * session). Anyone on the team runs views, reads rows and keeps their own views; team views are
 * saved, changed, archived and brought back by admins (decision 4). Rate limits: a run 20 a minute
 * and 200 an hour per member and 600 an hour per brand; rows 60 a minute per member; team saves 30
 * an hour per brand; Only me saves 20 a minute and 200 an hour per member.
 */

export type ApiResult = { status: number; body: unknown };

export const LIMITS = {
  runMember: { prefix: "views_run_member", burstLimit: 20, hourlyLimit: 200 },
  runBrand: { prefix: "views_run_brand", burstLimit: 600, hourlyLimit: 600 },
  rowsMember: { prefix: "views_rows_member", burstLimit: 60, hourlyLimit: 3600 },
  teamSaves: { prefix: "views_team_saves", burstLimit: 30, hourlyLimit: 30 },
  mySaves: { prefix: "views_my_saves", burstLimit: 20, hourlyLimit: 200 },
} as const satisfies Record<string, RateLimitConfig>;

export interface ViewsDeps {
  db?: FirestoreLike;
  loadTenant?: (id: string) => Promise<Tenant | null>;
  now?: () => Date;
}

const memberKey = (ctx: TenantContext) => `user:${ctx.tenantId}:${ctx.userId ?? "anon"}`;
const brandKey = (ctx: TenantContext) => `tenant:${ctx.tenantId}`;
const bad = (error = "invalid_input"): ApiResult => ({ status: 400, body: { error } });
const LIMITED: ApiResult = { status: 429, body: { error: "rate_limited" } };

async function overLimit(checks: Array<[string, RateLimitConfig]>, db?: FirestoreLike): Promise<boolean> {
  for (const [subject, config] of checks) if (await isRateLimited(subject, config, { db })) return true;
  return false;
}

const RunBody = z.object({ definition: z.unknown(), q: z.string().max(200).optional() }).strict();

/** Run a view: its count, the group it read and its total, whether it was capped, every match in order, and the first 50 rows. */
export async function runViewRequest(ctx: TenantContext, raw: unknown, deps: ViewsDeps = {}): Promise<ApiResult> {
  const body = RunBody.safeParse(raw);
  if (!body.success) return bad();
  const definition = ViewDefinitionSchema.safeParse(body.data.definition);
  if (!definition.success) return bad("invalid_view");
  if (await overLimit([[memberKey(ctx), LIMITS.runMember], [brandKey(ctx), LIMITS.runBrand]], deps.db)) return LIMITED;
  const [list, tenant] = await Promise.all([readFieldList(ctx, "person", deps.db), (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null)]);
  const r = await viewBackend().run(
    ctx,
    { definition: definition.data, q: body.data.q, fields: list.items, timeZone: tenant?.timeZone ?? null, now: deps.now?.() },
    deps.db,
  );
  if (!r.ok) return { status: 429, body: { error: r.error } };
  const rows = await readViewRows(ctx, r.run.ids.slice(0, VIEW_LIMITS.page), definition.data.columns, list.items, deps.db);
  return { status: 200, body: { ...r.run, rows } };
}

const RowsBody = z
  .object({
    ids: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).max(VIEW_LIMITS.page),
    columns: z.array(z.string().max(64)).max(VIEW_LIMITS.columns),
  })
  .strict();

/** Up to 50 people by id as rows with the chosen columns: Load more and a change of columns, never a new run. */
export async function viewRowsRequest(ctx: TenantContext, raw: unknown, deps: ViewsDeps = {}): Promise<ApiResult> {
  const body = RowsBody.safeParse(raw);
  if (!body.success) return bad();
  if (await overLimit([[memberKey(ctx), LIMITS.rowsMember]], deps.db)) return LIMITED;
  const list = await readFieldList(ctx, "person", deps.db);
  return { status: 200, body: { rows: await readViewRows(ctx, body.data.ids, body.data.columns, list.items, deps.db) } };
}

/** The team's views and the member's own; archived team views for admins, to bring one back. */
export async function listViewsRequest(ctx: TenantContext, deps: ViewsDeps = {}): Promise<ApiResult> {
  const admin = ctx.role === "admin";
  const { team, mine } = await listSavedViews(ctx, { archived: admin }, deps.db);
  return {
    status: 200,
    body: { team: team.filter((v) => !v.archived), archived: team.filter((v) => v.archived), mine, canSaveTeam: admin },
  };
}

function answer(r: SaveResult): ApiResult {
  if (r.ok) return { status: 200, body: { view: r.view, message: r.message } };
  return { status: SAVED_VIEW_STATUS[r.error], body: { error: r.error, ...(r.filters ? { filters: r.filters } : {}) } };
}

const CreateBody = z.object({ scope: z.enum(VIEW_SCOPES), name: z.string().max(200), definition: z.unknown() }).strict();

/** Save a new view, for the team (admins) or only for the member. */
export async function createViewRequest(ctx: TenantContext, raw: unknown, deps: ViewsDeps = {}): Promise<ApiResult> {
  const body = CreateBody.safeParse(raw);
  if (!body.success) return bad();
  if (body.data.scope === "team" && ctx.role !== "admin") return answer({ ok: false, error: "admins_only" });
  const limit: Array<[string, RateLimitConfig]> = body.data.scope === "team" ? [[brandKey(ctx), LIMITS.teamSaves]] : [[memberKey(ctx), LIMITS.mySaves]];
  if (await overLimit(limit, deps.db)) return LIMITED;
  const list = await readFieldList(ctx, "person", deps.db);
  return answer(await createSavedView(ctx, { scope: body.data.scope, name: body.data.name, definition: body.data.definition, fields: list.items, nowIso: deps.now?.().toISOString() }, deps.db));
}

/** The view a change names, if the member may change it, and its save limit; or why not. */
async function changeable(ctx: TenantContext, id: string, deps: ViewsDeps): Promise<{ ok: true; team: boolean } | { ok: false; result: ApiResult }> {
  if (!isViewId(id)) return { ok: false, result: { status: 404, body: { error: "view_not_found" } } };
  const view = await findSavedView(ctx, id, deps.db);
  if (!view) return { ok: false, result: { status: 404, body: { error: "view_not_found" } } };
  const team = view.scope === "team";
  if (team && ctx.role !== "admin") return { ok: false, result: answer({ ok: false, error: "admins_only" }) };
  if (await overLimit(team ? [[brandKey(ctx), LIMITS.teamSaves]] : [[memberKey(ctx), LIMITS.mySaves]], deps.db)) return { ok: false, result: LIMITED };
  return { ok: true, team };
}

const ChangeBody = z
  .object({ version: z.number().int().min(1), name: z.string().max(200).optional(), definition: z.unknown().optional(), archived: z.literal(false).optional() })
  .strict();

/** Change a view's name, filters, columns or sort from the version it was opened at; `archived: false` brings an archived team view back. */
export async function changeViewRequest(ctx: TenantContext, id: string, raw: unknown, deps: ViewsDeps = {}): Promise<ApiResult> {
  const body = ChangeBody.safeParse(raw);
  if (!body.success) return bad();
  const gate = await changeable(ctx, id, deps);
  if (!gate.ok) return gate.result;
  const nowIso = deps.now?.().toISOString();
  if (body.data.archived === false) {
    if (!gate.team) return bad();
    return answer(await restoreTeamView(ctx, id, { nowIso }, deps.db));
  }
  if (body.data.name === undefined && body.data.definition === undefined) return bad();
  const list = await readFieldList(ctx, "person", deps.db);
  return answer(
    await changeSavedView(ctx, id, { version: body.data.version, name: body.data.name, definition: body.data.definition, fields: list.items, nowIso }, deps.db),
  );
}

/** Archive a team view (admins), or delete an Only me view for real. */
export async function removeViewRequest(ctx: TenantContext, id: string, raw: unknown, deps: ViewsDeps = {}): Promise<ApiResult> {
  const body = z.object({ version: z.number().int().min(1) }).strict().safeParse(raw);
  if (!body.success) return bad();
  const gate = await changeable(ctx, id, deps);
  if (!gate.ok) return gate.result;
  return answer(await removeSavedView(ctx, id, { version: body.data.version, nowIso: deps.now?.().toISOString() }, deps.db));
}
