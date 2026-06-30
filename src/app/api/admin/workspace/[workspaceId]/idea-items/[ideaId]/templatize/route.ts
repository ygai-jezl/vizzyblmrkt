import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import {
  getIdeaItem,
  createTemplate,
  updateIdeaItem,
  addTemplateGroup,
} from "@/lib/tenant/workspaceContent";
import { readWorkspaceAsset } from "@/lib/workspace/assetStore";
import { templatizeIdea } from "@/lib/content/templatize";
import type { TemplateCategoryId } from "@/lib/types/template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Templatize an idea (inline Gemini) → create a template + mark the idea. */
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

  // Load the screenshot (if any) for multimodal analysis.
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
  });

  const template = await createTemplate(ctx, workspaceId, {
    title: result.title,
    body: result.body,
    category: result.category as TemplateCategoryId,
    group: result.group,
    sourceIdeaId: idea.id,
    topic: null,
    tags: [],
  });

  await updateIdeaItem(ctx, workspaceId, ideaId, {
    status: "templatized",
    templateId: template.id,
  });
  await addTemplateGroup(ctx, workspaceId, result.group);

  return NextResponse.json({ template, source: result.source });
}
