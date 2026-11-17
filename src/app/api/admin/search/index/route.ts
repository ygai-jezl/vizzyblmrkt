import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { isSearchEnabled } from "@/lib/search/flags";
import { indexSummary } from "@/lib/search/status";
import { sweepBrand } from "@/lib/search/sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A rebuild stops here and the scheduled check carries on with the rest. */
const REBUILD_BUDGET_MS = 45_000;

/** What the brand's search index holds, by kind, and where it lives (the Search card in Settings). */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isSearchEnabled()) return NextResponse.json({ error: "search_disabled" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await brandCanUse(ctx, "brand_search"))) return NextResponse.json({ error: "search_not_granted" }, { status: 403 });
  return NextResponse.json(await indexSummary(ctx));
}

/** Bring the index up to date now (admins only): index what changed and remove what is gone. */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isSearchEnabled()) return NextResponse.json({ error: "search_disabled" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!(await brandCanUse(ctx, "brand_search"))) return NextResponse.json({ error: "search_not_granted" }, { status: 403 });
  const counts = await sweepBrand(ctx, { deadlineMs: Date.now() + REBUILD_BUDGET_MS });
  return NextResponse.json({ ...counts, summary: await indexSummary(ctx) });
}
