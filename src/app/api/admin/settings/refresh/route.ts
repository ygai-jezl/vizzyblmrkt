import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { isBlogFreshnessEnabled } from "@/lib/brandMap/flags";
import { readRefresh, saveRefresh } from "@/lib/content/blog/refreshAdmin";
import { sameOriginGuard } from "@/lib/http/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The brand's refresh clock, Next up's refresh share, and what the freshness watch counted last. */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBlogFreshnessEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await readRefresh(ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}

/** Admins set them: `{ clock: "test" | 20 | 30 | 45, share: 0..3 }`. */
export async function PUT(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBlogFreshnessEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const r = await saveRefresh(ctx, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status });
}
