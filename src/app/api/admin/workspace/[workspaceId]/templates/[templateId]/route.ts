import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import {
  verifyWorkspace,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  addTemplateGroup,
} from "@/lib/tenant/workspaceContent";
import { TemplateCategoryId, type Template } from "@/lib/types/template";
import { normalizeTags } from "@/lib/knowledge/tags";
import { isContentMatrixTopic } from "@/lib/content/contentMatrix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(10000).optional(),
  category: TemplateCategoryId.optional(),
  group: z.string().min(1).max(100).optional(),
  topic: z.string().nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ workspaceId: string; templateId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, templateId } = await params;
  if (!(await verifyWorkspace(ctx, workspaceId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const existing = await getTemplate(ctx, workspaceId, templateId);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = UpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const patch: Partial<
    Pick<Template, "title" | "body" | "category" | "group" | "topic" | "tags">
  > = {};
  if (parsed.data.title !== undefined) patch.title = parsed.data.title.trim();
  if (parsed.data.body !== undefined) patch.body = parsed.data.body;
  if (parsed.data.category !== undefined) patch.category = parsed.data.category;
  if (parsed.data.group !== undefined) patch.group = parsed.data.group.trim();
  if (parsed.data.topic !== undefined) {
    const t = parsed.data.topic;
    patch.topic = t && isContentMatrixTopic(t) ? t : null;
  }
  if (parsed.data.tags !== undefined) patch.tags = normalizeTags(parsed.data.tags);

  await updateTemplate(ctx, workspaceId, templateId, patch);
  if (typeof patch.group === "string") await addTemplateGroup(ctx, workspaceId, patch.group);

  const template = await getTemplate(ctx, workspaceId, templateId);
  return NextResponse.json({ template });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ workspaceId: string; templateId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, templateId } = await params;
  if (!(await verifyWorkspace(ctx, workspaceId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  await deleteTemplate(ctx, workspaceId, templateId);
  return NextResponse.json({ ok: true });
}
