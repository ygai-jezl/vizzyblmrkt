import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { AgentMetaSchema } from "@/lib/types/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateBroadcastSchema = z.object({
  name: z.string().min(1).max(140),
  subject: z.string().max(300).default(""),
  body: z.string().max(50_000).default(""),
  // z.string().url() accepts javascript:/data: — require an explicit http(s) scheme.
  heroImageUrl: z
    .string()
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL")
    .nullable()
    .optional(),
  agentMeta: AgentMetaSchema.optional(),
});

/** List the broadcasts for a launch (newest first). */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { campaignId } = await params;
  const broadcasts = await forTenant(ctx).broadcasts.find({
    where: [["campaignId", "==", campaignId]],
    orderBy: [["createdAt", "desc"]],
  });
  return NextResponse.json({ broadcasts });
}

/** Create a draft broadcast for a launch. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { campaignId } = await params;
  const campaign = await forTenant(ctx).campaigns.getById(campaignId);
  if (!campaign) {
    return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
  }

  const parsed = CreateBroadcastSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_input",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const id = `bcast_${randomUUID()}`;
  const broadcast = await forTenant(ctx).broadcasts.create(id, {
    campaignId,
    name: parsed.data.name,
    subject: parsed.data.subject,
    body: parsed.data.body,
    heroImageUrl: parsed.data.heroImageUrl ?? null,
    status: "draft",
    mailchimpCampaignId: null,
    stats: null,
    agentMeta: parsed.data.agentMeta,
    lastError: null,
    createdAt: new Date().toISOString(),
    sentAt: null,
  });
  return NextResponse.json({ broadcast }, { status: 201 });
}
