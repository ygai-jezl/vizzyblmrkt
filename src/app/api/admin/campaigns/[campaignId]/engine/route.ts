import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isWaitlistEngineUiEnabled } from "@/lib/lifecycle/waitlist/flags";
import { engineStatus, switchEngine } from "@/lib/lifecycle/waitlist/engineSwitch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ campaignId: string }> };

/**
 * A launch's email engine (engine move D5): where its welcome emails run, the
 * dry run of moving them, and the double-send check (GET); and rehearsing,
 * switching or switching back (POST, admins only). Counts only, never a person.
 */
export async function GET(req: Request, { params }: Params) {
  if (!isWaitlistEngineUiEnabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const status = await engineStatus(ctx, (await params).campaignId);
  if (!status) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}

const Body = z.object({ action: z.enum(["rehearse", "end_rehearsal", "switch", "rollback"]) });

export async function POST(req: Request, { params }: Params) {
  if (!isWaitlistEngineUiEnabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Moving a launch's welcome emails changes who emails its subscribers: admins only.
  if (ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const { campaignId } = await params;
  const r = await switchEngine(ctx, campaignId, parsed.data.action);
  if (!r.ok) return NextResponse.json({ error: r.error, ...(r.detail ? { detail: r.detail } : {}) }, { status: r.status });
  return NextResponse.json({ ok: true, ...r.value, status: await engineStatus(ctx, campaignId) });
}
