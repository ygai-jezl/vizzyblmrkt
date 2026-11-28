import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { launchTranslationsAction, launchTranslationsView } from "@/lib/i18n/launchTranslations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ campaignId: string }> };

/**
 * A launch page's own words in other languages (PAGE_LANGUAGES_ENABLED; 503 while off). GET: each
 * language's version and state (members may look). POST (admins): approve, approve_all, save or make.
 */
export async function GET(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await launchTranslationsView(ctx, (await params).campaignId);
  return NextResponse.json(r.body, { status: r.status });
}

export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const r = await launchTranslationsAction(ctx, (await params).campaignId, await req.json().catch(() => undefined));
  return NextResponse.json(r.body, { status: r.status });
}
