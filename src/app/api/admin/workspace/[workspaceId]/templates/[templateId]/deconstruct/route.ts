import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { getTemplate, createTemplate } from "@/lib/tenant/workspaceContent";
import { deconstructTemplate } from "@/lib/content/deconstruct";
import { isChannel } from "@/lib/content/channels";
import type { ModuleSizeId, Template } from "@/lib/types/template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  channels: z.array(z.string().max(40)).min(1).max(4),
});

/** Deconstruct a hub/template into channel-native spoke templates (Transformation Matrix). */
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

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const channels = [...new Set(parsed.data.channels.filter(isChannel))];
  if (channels.length === 0) {
    return NextResponse.json({ error: "no_valid_channels" }, { status: 400 });
  }

  const spokes = await deconstructTemplate({
    template: {
      body: template.body,
      blockType: template.blockType,
      tier: template.tier,
      sourceSnapshot: template.sourceSnapshot,
    },
    channels,
    brandVoice: ws.brandVoice ?? null,
    audience: ws.audience ?? null,
  });

  const created: Template[] = [];
  for (const s of spokes) {
    try {
      const tpl = await createTemplate(ctx, workspaceId, {
        title: s.title,
        body: s.body,
        category: template.category,
        group: template.group,
        sourceIdeaId: null,
        topic: template.topic ?? null,
        tags: [],
        framework: template.framework ?? null,
        blockType: s.blockType,
        moduleSize: s.moduleSize as ModuleSizeId,
        channel: s.channel,
        format: s.format,
        tier: "spoke",
        parentTemplateId: template.id,
        placeholders: s.placeholders,
        confidence: 1,
        warnings: [],
        sourceSnapshot: null,
      });
      created.push(tpl);
    } catch {
      // Skip a single spoke that fails to persist rather than failing the batch.
    }
  }

  return NextResponse.json({ spokes: created });
}
