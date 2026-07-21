import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { activeBrandVoiceText } from "@/lib/content/create/activeBrandVoice";
import {
  getIdeaItem,
  createTemplate,
  updateIdeaItem,
  addTemplateGroup,
} from "@/lib/tenant/workspaceContent";
import { readWorkspaceAsset } from "@/lib/workspace/assetStore";
import { templatizeIdea } from "@/lib/content/templatize";
import type { TemplateCategoryId, ModuleSizeId, TemplateTier } from "@/lib/types/template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  framework: z.string().max(40).optional(),
  blockType: z.string().max(40).optional(),
  channel: z.string().max(40).optional(),
  granularity: z.enum(["coarse", "normal", "fine"]).optional(),
});

/** Templatize an idea (inline modular Gemini pipeline) → create a template + mark the idea. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ workspaceId: string; ideaId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, ideaId } = await params;

  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const idea = await getIdeaItem(ctx, workspaceId, ideaId);
  if (!idea) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const opts = BodySchema.safeParse(await req.json().catch(() => ({})));
  const overrides = opts.success ? opts.data : {};

  let screenshot: { base64: string; mimeType: string } | null = null;
  if (idea.screenshotPath) {
    const asset = await readWorkspaceAsset(ctx.tenantId, workspaceId, idea.screenshotPath);
    if (asset) screenshot = { base64: asset.bytes.toString("base64"), mimeType: asset.contentType };
  }

  const result = await templatizeIdea({
    text: idea.text,
    url: idea.url,
    fetchable: idea.fetchable,
    screenshot,
    knownGroups: ws.templateGroups ?? [],
    framework: overrides.framework ?? null,
    blockType: overrides.blockType ?? null,
    channel: overrides.channel ?? null,
    granularity: overrides.granularity ?? null,
    brandVoice: await activeBrandVoiceText(ctx.tenantId, ws.brandVoice),
    audience: ws.audience ?? null,
  });

  let template;
  try {
    template = await createTemplate(ctx, workspaceId, {
      title: result.title,
      body: result.body,
      category: result.category as TemplateCategoryId,
      group: result.group,
      sourceIdeaId: idea.id,
      topic: null,
      tags: [],
      framework: result.framework,
      blockType: result.blockType,
      moduleSize: result.moduleSize as ModuleSizeId,
      channel: result.channel,
      format: result.format,
      tier: result.tier as TemplateTier,
      parentTemplateId: null,
      placeholders: result.placeholders,
      confidence: result.confidence,
      warnings: result.warnings,
      sourceSnapshot: result.sourceSnapshot,
    });
  } catch {
    return NextResponse.json({ error: "templatize_failed" }, { status: 502 });
  }

  await updateIdeaItem(ctx, workspaceId, ideaId, {
    status: "templatized",
    templateId: template.id,
  });
  await addTemplateGroup(ctx, workspaceId, result.group);

  return NextResponse.json({ template, source: result.source });
}
