import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { getContentPlan, listTemplates, updateContentPlan } from "@/lib/tenant/workspaceContent";
import { architectPlan, architectSequence } from "@/lib/content/create/architect";
import { retrieveSemanticKnowledgeContext } from "@/lib/agents/knowledgeRetrieval";
import { contentMatrixLabel } from "@/lib/content/contentMatrix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string }> };

/**
 * Architect — build the plan's hub-and-spoke graph skeleton (one Gemini call,
 * grounded). Persists the graph (nodes status:"empty") and flips the plan to
 * "generating"; the client then fills each node via the per-node route.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId } = await params;

  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Ground the architect: query = spark + topics; scoped → pre-filter by first topic.
  const scopedTopic =
    plan.knowledge.groundingScope === "scoped" ? plan.scope.topics[0] : undefined;
  const queryText =
    [plan.scope.spark, ...plan.scope.topics.map(contentMatrixLabel)].filter(Boolean).join(" — ") ||
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

  // Email sequences build a linear drip (trigger → email → wait, with branches); every
  // other objective builds the hub-and-spoke content graph.
  const graph =
    plan.strategy.objective === "email_sequence" && plan.strategy.sequenceType
      ? await architectSequence({
          sequenceType: plan.strategy.sequenceType,
          spark: plan.scope.spark,
          topicLabels: plan.scope.topics.map(contentMatrixLabel),
          knowledgeContext: rag?.formatted ?? "",
          brandVoice: ws.brandVoice ?? null,
          audience: ws.audience ?? null,
        })
      : await architectPlan({
          objective: plan.strategy.objective,
          spark: plan.scope.spark,
          topicLabels: plan.scope.topics.map(contentMatrixLabel),
          hubChannel: plan.topology.hubChannel,
          spokeChannels: plan.topology.spokeChannels,
          knowledgeContext: rag?.formatted ?? "",
          brandVoice: ws.brandVoice ?? null,
          audience: ws.audience ?? null,
          templates: (await listTemplates(ctx, workspaceId)).map((t) => ({
            id: t.id,
            channel: t.channel,
            blockType: t.blockType,
            tier: t.tier,
          })),
        });

  await updateContentPlan(ctx, workspaceId, planId, { graph, status: "generating" });
  const updated = await getContentPlan(ctx, workspaceId, planId);
  return NextResponse.json({ plan: updated });
}
