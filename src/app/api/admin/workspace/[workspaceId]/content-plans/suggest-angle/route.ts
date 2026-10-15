import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, isRateLimited } from "@/lib/tenant";
import { isSuggestAngleEnabled } from "@/lib/content/create/flags";
import { SUGGEST_ANGLE_LIMIT, SuggestAngleBody, suggestAngle } from "@/lib/content/create/suggestAngle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Suggest an angle" (CREATE_SUGGEST_ANGLE_ENABLED): the Spark for a new workflow in this
 * programme, suggested from the brand map and the brand's own knowledge. Nothing is saved:
 * a person edits it in the wizard. Whoever can create a workflow can ask; rate-limited per
 * brand. FLAG-GATED (503 until switched on).
 */
export async function POST(req: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isSuggestAngleEnabled()) return NextResponse.json({ error: "suggest_angle_disabled" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const parsed = SuggestAngleBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  if (await isRateLimited(`tenant:${ctx.tenantId}`, SUGGEST_ANGLE_LIMIT)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const r = await suggestAngle(ctx, { id: ws.id, name: ws.name }, parsed.data);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ spark: r.spark, basis: r.basis });
}
