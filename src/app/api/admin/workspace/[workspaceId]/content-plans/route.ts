import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { createContentPlan, listContentPlans } from "@/lib/tenant/workspaceContent";
import { IntakeSchema, planFromIntake } from "@/lib/content/create/intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a ContentPlan from intake (graph empty; the Architect builds it next). */
export async function POST(req: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = IntakeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues.map((i) => i.path.join(".")) },
      { status: 400 },
    );
  }
  const plan = await createContentPlan(ctx, workspaceId, planFromIntake(parsed.data));
  return NextResponse.json({ plan });
}

/** List the workspace's content plans (newest first). */
export async function GET(req: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const plans = await listContentPlans(ctx, workspaceId);
  return NextResponse.json({ plans });
}
