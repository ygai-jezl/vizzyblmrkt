import { NextResponse } from "next/server";
import { guardEbookRoute } from "@/lib/content/create/ebookRoute";
import { updateContentPlanEbook } from "@/lib/tenant/workspaceContent";
import { generateEbookToc } from "@/lib/content/create/ebookToc";
import { activeBrandVoiceText } from "@/lib/content/create/activeBrandVoice";
import { retrieveSemanticKnowledgeContext } from "@/lib/agents/knowledgeRetrieval";
import { contentMatrixLabel } from "@/lib/content/contentMatrix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string }> };

/**
 * Generate the eBook's table of contents from the Scope intake (grounded), persist it as
 * the plan's `ebookDraft` (chapters status:"planned", tocConfirmed:false), and return it.
 * Non-streaming — a ToC is one bounded JSON. Flag-gated via guardEbookRoute (503 when off).
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId, planId } = await params;
  const guard = await guardEbookRoute(req, workspaceId, planId);
  if (guard.error) return guard.error;
  const { ctx, ws, plan } = guard.ok;

  const topicLabels = plan.scope.topics.map(contentMatrixLabel);
  const scopedTopic =
    plan.knowledge.groundingScope === "scoped" ? plan.scope.topics[0] : undefined;
  const queryText =
    [plan.scope.spark, plan.scope.industryLens, ...topicLabels].filter(Boolean).join(" — ") ||
    plan.name;
  const rag = await retrieveSemanticKnowledgeContext({
    ctx,
    ownerKind: "workspace",
    ownerId: workspaceId,
    queryText,
    limit: 8,
    bypassEnabledFlag: true,
    ...(scopedTopic ? { filter: { topic: scopedTopic } } : {}),
  }).catch(() => null);

  const ebook = await generateEbookToc({
    spark: plan.scope.spark,
    topicLabels,
    industryLens: plan.scope.industryLens,
    knowledgeContext: rag?.formatted ?? "",
    brandVoice: await activeBrandVoiceText(ctx.tenantId, ws.brandVoice),
    audience: ws.audience ?? null,
    fallbackTitle: plan.name,
  });

  const saved = await updateContentPlanEbook(ctx, workspaceId, planId, ebook);
  if (!saved) return NextResponse.json({ error: "save_failed" }, { status: 500 });
  return NextResponse.json({ ebook: saved });
}
