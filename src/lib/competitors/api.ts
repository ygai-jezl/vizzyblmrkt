import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import type { AdminGate } from "@/lib/connect/admin";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { isRateLimited } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant/types";
import { CompetitorPatchSchema, MonitorInputSchema } from "@/lib/types/competitor";
import { forgetReviewCount } from "@/lib/review/summary";
import { isCompetitorsEnabled } from "./flags";
import { advanceCompetitor, type StepDeps } from "./steps";
import {
  addToBrandMap,
  checkNow,
  getCompetitor,
  listChanges,
  listCompetitors,
  listPosts,
  markSeen,
  monitorCompetitor,
  onBrandMap,
  removeCompetitor,
  retryCompetitor,
  unseenChanges,
  updateCompetitor,
  type Result,
} from "./store";
import { articlesForDetail, type CoverageDeps } from "./coverage";
import { detailOf, summaryOf } from "./view";

/**
 * The APIs behind Brand › Competitors: origin, switch, sign-in, admin (to change anything) and
 * the brand's access to the feature, in that order. Members can read; admins add, change, check
 * and stop watching.
 */

async function gate(req: Request, admin: boolean): Promise<AdminGate> {
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  if (!isCompetitorsEnabled()) return { ok: false, response: NextResponse.json({ error: "competitors_disabled" }, { status: 503 }) };
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (admin && ctx.role !== "admin") return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  if (!(await brandCanUse(ctx, "competitors"))) return { ok: false, response: NextResponse.json({ error: "not_included" }, { status: 403 }) };
  return { ok: true, ctx };
}

export const competitorsAdmin = (req: Request) => gate(req, true);
export const competitorsReader = (req: Request) => gate(req, false);

/** Monitor: five new competitors an hour per brand. */
export const MONITOR_LIMIT = { prefix: "competitors_monitor", burstLimit: 3, hourlyLimit: 5 };
/** Check now: three an hour per competitor (each reads their site again). */
export const CHECK_LIMIT = { prefix: "competitors_check", burstLimit: 2, hourlyLimit: 3 };
/** Work done in one request while a person waits. */
const ADVANCE_MS = 20_000;

export type ApiDeps = StepDeps & CoverageDeps & { limit?: typeof isRateLimited };

const noStore = { "cache-control": "no-store" };

function fail(r: Extract<Result<unknown>, { ok: false }>): Response {
  return NextResponse.json({ error: r.error, ...(r.id ? { id: r.id } : {}), ...(r.issues ? { issues: r.issues.slice(0, 5) } : {}) }, { status: r.status });
}

function invalid(issues: { path: PropertyKey[]; message: string }[]): Response {
  return NextResponse.json(
    { error: "invalid_input", issues: issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "input"}: ${i.message}`) },
    { status: 400 },
  );
}

async function listView(ctx: TenantContext, deps: ApiDeps) {
  const competitors = await listCompetitors(ctx, deps);
  const [changes, mapped] = await Promise.all([unseenChanges(ctx, deps), onBrandMap(ctx, competitors, deps)]);
  return competitors.map((c) => summaryOf(c, changes, mapped.has(c.id)));
}

async function detailView(ctx: TenantContext, id: string, deps: ApiDeps) {
  const c = await getCompetitor(ctx, id, deps);
  if (!c) return null;
  const [changes, posts, mapped, articles] = await Promise.all([
    listChanges(ctx, id, deps),
    listPosts(ctx, id, deps),
    onBrandMap(ctx, [c], deps),
    articlesForDetail(ctx, id, deps).catch(() => null),
  ]);
  return detailOf(c, changes, posts, mapped.has(c.id), articles);
}

export async function listFromRequest(ctx: TenantContext, deps: ApiDeps = {}): Promise<Response> {
  return NextResponse.json({ competitors: await listView(ctx, deps) }, { headers: noStore });
}

export async function detailFromRequest(ctx: TenantContext, id: string, deps: ApiDeps = {}): Promise<Response> {
  const detail = await detailView(ctx, id, deps);
  return detail ? NextResponse.json({ competitor: detail }, { headers: noStore }) : NextResponse.json({ error: "not_found" }, { status: 404 });
}

/** Monitor: start watching, then do the first steps while the person waits. */
export async function monitorFromRequest(ctx: TenantContext, body: unknown, deps: ApiDeps = {}): Promise<Response> {
  const parsed = MonitorInputSchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error.issues);
  if (await (deps.limit ?? isRateLimited)(`tenant:${ctx.tenantId}`, MONITOR_LIMIT, { db: deps.db })) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const r = await monitorCompetitor(ctx, parsed.data, deps);
  if (!r.ok) return fail(r);
  await advanceCompetitor(ctx, r.value.competitor.id, (deps.clock ?? Date.now)() + ADVANCE_MS, deps);
  const detail = await detailView(ctx, r.value.competitor.id, deps);
  return NextResponse.json({ competitor: detail, brandMap: r.value.brandMap }, { status: 201 });
}

export async function updateFromRequest(ctx: TenantContext, id: string, body: unknown, deps: ApiDeps = {}): Promise<Response> {
  const parsed = CompetitorPatchSchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error.issues);
  const r = await updateCompetitor(ctx, id, parsed.data, deps);
  if (!r.ok) return fail(r);
  return NextResponse.json({ competitor: await detailView(ctx, id, deps) });
}

export async function removeFromRequest(ctx: TenantContext, id: string, deps: ApiDeps = {}): Promise<Response> {
  const r = await removeCompetitor(ctx, id, deps);
  if (!r.ok) return fail(r);
  forgetReviewCount(ctx.tenantId);
  return NextResponse.json({ ok: true });
}

const ActionBody = z.object({ action: z.enum(["advance", "check", "retry", "brand_map"]) });

/**
 * One of a competitor's actions: carry on with setup (`advance`, while the page waits), check now,
 * try again after it needed a person, or put its name on the brand map again.
 */
export async function actionFromRequest(ctx: TenantContext, id: string, body: unknown, deps: ApiDeps = {}): Promise<Response> {
  const parsed = ActionBody.safeParse(body);
  if (!parsed.success) return invalid(parsed.error.issues);
  const action = parsed.data.action;
  if (action === "brand_map") {
    const r = await addToBrandMap(ctx, id, deps);
    if (!r.ok) return fail(r);
    return NextResponse.json({ competitor: await detailView(ctx, id, deps), brandMap: r.value.brandMap });
  }
  if (action === "check") {
    if (await (deps.limit ?? isRateLimited)(`competitor:${ctx.tenantId}:${id}`, CHECK_LIMIT, { db: deps.db })) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }
    const r = await checkNow(ctx, id, deps);
    if (!r.ok) return fail(r);
  }
  if (action === "retry") {
    const r = await retryCompetitor(ctx, id, deps);
    if (!r.ok) return fail(r);
  }
  const advanced = await advanceCompetitor(ctx, id, (deps.clock ?? Date.now)() + ADVANCE_MS, deps);
  if (!advanced) return NextResponse.json({ error: "not_found" }, { status: 404 });
  forgetReviewCount(ctx.tenantId);
  return NextResponse.json({ competitor: await detailView(ctx, id, deps) });
}

const SeenBody = z.object({ competitorId: z.string().regex(/^cmp_[a-z0-9]{8,40}$/).optional() });

/** Mark what changed as seen: one competitor's, or every competitor's. */
export async function seenFromRequest(ctx: TenantContext, body: unknown, deps: ApiDeps = {}): Promise<Response> {
  const parsed = SeenBody.safeParse(body ?? {});
  if (!parsed.success) return invalid(parsed.error.issues);
  const marked = await markSeen(ctx, parsed.data.competitorId ?? null, deps);
  forgetReviewCount(ctx.tenantId);
  return NextResponse.json({ ok: true, marked });
}
