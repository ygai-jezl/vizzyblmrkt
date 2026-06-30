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
import {
  TemplateCategoryId,
  ModuleSizeId,
  TemplateTier,
  TemplatePlaceholderSchema,
  type Template,
} from "@/lib/types/template";
import { normalizeTags } from "@/lib/knowledge/tags";
import { isContentMatrixTopic } from "@/lib/content/contentMatrix";
import { reconcilePlaceholders } from "@/lib/content/placeholders";
import { isFramework } from "@/lib/content/frameworks";
import { isBlockType } from "@/lib/content/blocks";
import { isChannel, isFormat } from "@/lib/content/channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(10000).optional(),
  category: TemplateCategoryId.optional(),
  group: z.string().min(1).max(100).optional(),
  topic: z.string().nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  framework: z.string().max(40).optional(),
  blockType: z.string().max(40).optional(),
  moduleSize: ModuleSizeId.optional(),
  channel: z.string().max(40).optional(),
  format: z.string().max(40).optional(),
  tier: TemplateTier.optional(),
  placeholders: z.array(TemplatePlaceholderSchema).max(80).optional(),
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

  const d = parsed.data;
  if (
    (d.framework !== undefined && !isFramework(d.framework)) ||
    (d.blockType !== undefined && !isBlockType(d.blockType)) ||
    (d.channel !== undefined && !isChannel(d.channel)) ||
    (d.format !== undefined && !isFormat(d.format))
  ) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const patch: Partial<
    Pick<
      Template,
      | "title" | "body" | "category" | "group" | "topic" | "tags"
      | "framework" | "blockType" | "moduleSize" | "channel" | "format" | "tier" | "placeholders"
    >
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
  if (parsed.data.framework !== undefined) patch.framework = parsed.data.framework;
  if (parsed.data.blockType !== undefined) patch.blockType = parsed.data.blockType;
  if (parsed.data.moduleSize !== undefined) patch.moduleSize = parsed.data.moduleSize;
  if (parsed.data.channel !== undefined) patch.channel = parsed.data.channel;
  if (parsed.data.format !== undefined) patch.format = parsed.data.format;
  if (parsed.data.tier !== undefined) patch.tier = parsed.data.tier;
  // Keep body↔placeholders consistent: re-derive when either changes.
  if (parsed.data.body !== undefined || parsed.data.placeholders !== undefined) {
    const nextBody = patch.body ?? existing.body;
    patch.placeholders = reconcilePlaceholders(nextBody, parsed.data.placeholders ?? existing.placeholders);
  }

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
