import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { activeBrandVoiceText } from "@/lib/content/create/activeBrandVoice";
import {
  getTemplate,
  getIdeaItem,
  updateTemplate,
  addTemplateGroup,
} from "@/lib/tenant/workspaceContent";
import { readWorkspaceAsset } from "@/lib/workspace/assetStore";
import { templatizeIdea, type TemplatizeInput } from "@/lib/content/templatize";
import type { ModuleSizeId } from "@/lib/types/template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  framework: z.string().max(40).optional(),
  blockType: z.string().max(40).optional(),
  channel: z.string().max(40).optional(),
  granularity: z.enum(["coarse", "normal", "fine"]).optional(),
});

/** Re-run the templatize pipeline on a template's source content with new overrides
 *  (reframe / different framework / granularity). Replaces body + modular metadata. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ workspaceId: string; templateId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, templateId } = await params;

  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const template = await getTemplate(ctx, workspaceId, templateId);
  if (!template) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const opts = BodySchema.safeParse(await req.json().catch(() => ({})));
  const overrides = opts.success ? opts.data : {};

  // Rebuild the source sample: snapshot → source idea → current body (self-contained).
  const input: TemplatizeInput = {
    knownGroups: ws.templateGroups ?? [],
    framework: overrides.framework ?? null,
    blockType: overrides.blockType ?? null,
    channel: overrides.channel ?? null,
    granularity: overrides.granularity ?? null,
    brandVoice: await activeBrandVoiceText(ctx.tenantId, ws.brandVoice),
    audience: ws.audience ?? null,
  };
  if (template.sourceSnapshot) {
    input.text = template.sourceSnapshot;
  } else if (template.sourceIdeaId) {
    const idea = await getIdeaItem(ctx, workspaceId, template.sourceIdeaId);
    if (idea) {
      input.text = idea.text;
      input.url = idea.url;
      input.fetchable = idea.fetchable;
      if (idea.screenshotPath) {
        const asset = await readWorkspaceAsset(ctx.tenantId, workspaceId, idea.screenshotPath);
        if (asset) input.screenshot = { base64: asset.bytes.toString("base64"), mimeType: asset.contentType };
      }
    } else {
      input.text = template.body;
    }
  } else {
    input.text = template.body;
  }

  const result = await templatizeIdea(input);

  await updateTemplate(ctx, workspaceId, templateId, {
    title: result.title,
    body: result.body,
    placeholders: result.placeholders,
    framework: result.framework,
    blockType: result.blockType,
    moduleSize: result.moduleSize as ModuleSizeId,
    channel: result.channel,
    format: result.format,
    // tier is the cluster ROLE (hub/spoke) — preserve it across a reframe so a hub
    // with spokes can't silently flip to "spoke"/"standalone" and disappear.
    confidence: result.confidence,
    warnings: result.warnings,
    sourceSnapshot: result.sourceSnapshot,
  });
  await addTemplateGroup(ctx, workspaceId, result.group);

  const updated = await getTemplate(ctx, workspaceId, templateId);
  return NextResponse.json({ template: updated, source: result.source });
}
