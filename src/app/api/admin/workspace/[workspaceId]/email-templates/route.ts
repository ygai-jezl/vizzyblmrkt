import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { createEmailTemplate, listEmailTemplates } from "@/lib/tenant/workspaceContent";
import { EmailLayoutSchema } from "@/lib/types/emailLayout";
import { renderEmailLayout } from "@/lib/email/emailRender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  title: z.string().min(1).max(200),
  layout: EmailLayoutSchema,
});

/** List a workspace's saved email layout templates (newest first). */
export async function GET(req: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const templates = await listEmailTemplates(ctx, workspaceId);
  return NextResponse.json({ templates });
}

/** Save the current layout as a reusable email template. */
export async function POST(req: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const template = await createEmailTemplate(ctx, workspaceId, {
    title: parsed.data.title.trim(),
    layout: parsed.data.layout,
    thumbnailBody: renderEmailLayout(parsed.data.layout).slice(0, 20000),
  });
  return NextResponse.json({ template });
}
