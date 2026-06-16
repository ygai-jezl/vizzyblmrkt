import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { generateHeroImage } from "@/lib/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ImageSchema = z.object({
  campaignId: z.string().min(1),
  brief: z.string().min(1).max(2000),
});

/** Agent 3 — generate a hero image (Vertex Imagen) and store it for the email. */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = ImageSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const campaign = await forTenant(ctx).campaigns.getById(parsed.data.campaignId);
  if (!campaign) {
    return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
  }

  const result = await generateHeroImage({
    campaign,
    brief: parsed.data.brief,
    tenantId: ctx.tenantId,
  });
  return NextResponse.json(result);
}
