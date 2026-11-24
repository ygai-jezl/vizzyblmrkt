import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { isBlogDatesEnabled } from "@/lib/brandMap/flags";
import { readTimeZone, saveTimeZone } from "@/lib/content/blog/datesAdmin";
import { sameOriginGuard } from "@/lib/http/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The brand's time zone, for its articles' dates. */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBlogDatesEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await readTimeZone(ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}

/** Admins set it: `{ timeZone: "Europe/London" }`, or `{ timeZone: null }` for UTC. */
export async function PUT(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBlogDatesEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const r = await saveTimeZone(ctx, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status });
}
