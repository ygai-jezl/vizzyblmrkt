import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, getTenantById } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { generateEmailLayout } from "@/lib/content/create/generateEmailLayout";
import { findCopyBlockIndex } from "@/lib/types/emailLayout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string; nodeId: string }> };

const BodySchema = z.object({ brief: z.string().min(1).max(2000) });

/**
 * Natural-language → email LAYOUT for one email node. Returns the generated layout
 * (does NOT persist — the editor applies it and the operator saves through the normal
 * path). Grounded in the workspace brand voice/audience + the tenant Brand Kit.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId, nodeId } = await params;

  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const node = plan.graph.nodes.find((n) => n.id === nodeId);
  if (!node) return NextResponse.json({ error: "node_not_found" }, { status: 404 });
  if (node.type !== "email") return NextResponse.json({ error: "not_email_node" }, { status: 400 });

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const tenant = await getTenantById(ctx.tenantId);
  // Seed the new copy block from the EXISTING copy block (node.body is the full rendered
  // layout when a layout exists — using it would cram the whole email into one block).
  const copyIdx = node.layout ? findCopyBlockIndex(node.layout) : -1;
  const copyBlock = copyIdx >= 0 ? node.layout!.blocks[copyIdx] : undefined;
  const currentBody = copyBlock && copyBlock.kind === "text" ? copyBlock.html : node.body;

  const layout = await generateEmailLayout({
    brief: parsed.data.brief,
    subject: node.subject ?? "",
    currentBody,
    brandVoice: ws.brandVoice ?? null,
    audience: ws.audience ?? null,
    brandKit: tenant?.brandKit ?? null,
  });
  if (!layout) return NextResponse.json({ error: "generation_failed" }, { status: 502 });
  return NextResponse.json({ layout });
}
