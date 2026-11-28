import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { articleTranslationsAction, articleTranslationsView } from "@/lib/i18n/articleTranslations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string }> };

/**
 * An article's versions in other languages (PAGE_LANGUAGES_ENABLED; 503 while off). GET: each
 * language's version, its state, address and live check (members may look). POST (admins):
 * approve, approve_all, save, address or make.
 */
export async function GET(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId } = await params;
  if (!(await forTenant(ctx).workspaces.getById(workspaceId))) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await articleTranslationsView(ctx, workspaceId, planId);
  return NextResponse.json(r.body, { status: r.status });
}

export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { workspaceId, planId } = await params;
  if (!(await forTenant(ctx).workspaces.getById(workspaceId))) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await articleTranslationsAction(ctx, workspaceId, planId, await req.json().catch(() => undefined));
  return NextResponse.json(r.body, { status: r.status });
}
