import { NextResponse } from "next/server";
import { z } from "zod";
import { AUTOPILOT_RUNNING, autopilotHolds } from "@/lib/autopilot/planLock";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { isBlogRefreshEnabled } from "@/lib/brandMap/flags";
import { listVersions, restoreVersion } from "@/lib/content/blog/versions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ workspaceId: string; planId: string; nodeId: string }>;
};

const BodySchema = z.strictObject({ restore: z.number().int().min(1).max(1_000_000) });

const RESTORE_ERRORS = { not_found: 404, no_version: 404, locked: 409 } as const;

async function load(ctx: NonNullable<Awaited<ReturnType<typeof getAdminContext>>>, workspaceId: string, planId: string) {
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return null;
  return getContentPlan(ctx, workspaceId, planId);
}

/**
 * A blog article's earlier versions (BLOG_REFRESH_ENABLED): GET lists them without their copy,
 * POST `{ restore: n }` puts one back (keeping the copy it replaces) and sends the article back
 * for approval. Members and admins alike, as for any edit to an article.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  if (!isBlogRefreshEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId } = await params;
  const plan = await load(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ versions: await listVersions(ctx, plan.id) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBlogRefreshEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId, nodeId } = await params;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const plan = await load(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // The article autopilot is writing it: nothing saves over the run until it ends or a person takes over.
  if (autopilotHolds(plan)) return NextResponse.json(AUTOPILOT_RUNNING, { status: 409 });

  const r = await restoreVersion(ctx, { plan, nodeId, n: parsed.data.restore });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: RESTORE_ERRORS[r.error] });
  return NextResponse.json({ node: r.node, kept: r.kept, versions: await listVersions(ctx, plan.id) });
}
