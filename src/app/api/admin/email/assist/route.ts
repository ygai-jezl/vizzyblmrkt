import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { draftCopy } from "@/lib/agents";
import { retrieveSemanticKnowledgeContext } from "@/lib/agents/knowledgeRetrieval";
import type { Broadcast } from "@/lib/types/broadcast";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AssistSchema = z.object({
  campaignId: z.string().min(1),
  brief: z.string().min(1).max(2000),
  variantCount: z.number().int().min(1).max(5).optional(),
});

/** Agent 3 — draft performance-informed copy variants for the composer. */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = AssistSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const campaign = await forTenant(ctx).campaigns.getById(parsed.data.campaignId);
  if (!campaign) {
    return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
  }

  // Feed prior-send performance to the model (best-effort).
  const prior = await forTenant(ctx).broadcasts.find({
    where: [["campaignId", "==", campaign.id]],
  });
  const performance = summarizePerformance(prior);

  // Best-effort RAG grounding: retrieve knowledge relevant to the brief. Never
  // blocks copy generation — any failure (flag off, no chunks, error) → no context.
  let knowledgeContext: string | undefined;
  try {
    const knowledge = await retrieveSemanticKnowledgeContext({
      ctx,
      campaignId: campaign.id,
      queryText: parsed.data.brief,
    });
    knowledgeContext = knowledge?.formatted || undefined;
  } catch {
    knowledgeContext = undefined;
  }

  const result = await draftCopy({
    campaign,
    brief: parsed.data.brief,
    variantCount: parsed.data.variantCount,
    performance,
    knowledgeContext,
  });
  return NextResponse.json(result);
}

function summarizePerformance(broadcasts: Broadcast[]): string {
  const sent = broadcasts
    .filter((b) => b.status === "sent" && b.stats?.openRate != null)
    .sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""))
    .slice(0, 5);
  if (sent.length === 0) return "No prior sends with reported stats yet.";
  const lines = sent.map(
    (b) =>
      `- "${b.name}": ${Math.round((b.stats?.openRate ?? 0) * 100)}% open` +
      (b.stats?.clickRate != null
        ? `, ${Math.round(b.stats.clickRate * 100)}% click`
        : ""),
  );
  return `Recent sends (newest first):\n${lines.join("\n")}`;
}
