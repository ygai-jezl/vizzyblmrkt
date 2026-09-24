import type { TenantContext } from "@/lib/tenant/types";
import type { ContentGraph, ContentPlan } from "@/lib/types/contentPlan";
import { EbookDocSchema } from "@/lib/types/contentPlan";
import type { Workspace } from "@/lib/types/workspace";
import { listTemplates } from "@/lib/tenant/workspaceContent";
import { activeBrandVoiceText } from "./activeBrandVoice";
import { architectEbookPlan, architectPlan, architectSequence } from "./architect";
import { isEbookEnabled } from "./ebook";
import { retrieveSemanticKnowledgeContext } from "@/lib/agents/knowledgeRetrieval";
import { contentMatrixLabel } from "@/lib/content/contentMatrix";

/**
 * The Architect: a plan's graph skeleton (one grounded Gemini call). Shared by the
 * Create wizard's generate route and Vizzy's `content_plan` canvas kind (nav v2
 * phase 4). It returns the graph; the caller saves it. Brand voice comes from
 * activeBrandVoiceText, so the brand voice wins over a programme's own voice.
 */

export type ArchitectResult = { ok: true; graph: ContentGraph } | { ok: false; status: number; error: string };

export async function runArchitect(
  ctx: TenantContext,
  args: { workspace: Pick<Workspace, "id" | "brandVoice" | "audience">; plan: ContentPlan },
): Promise<ArchitectResult> {
  const { workspace: ws, plan } = args;
  const templates = async () =>
    (await listTemplates(ctx, ws.id)).map((t) => ({ id: t.id, channel: t.channel, blockType: t.blockType, tier: t.tier }));

  // Ground the architect: query = spark + topics; scoped → pre-filter by first topic.
  const scopedTopic = plan.knowledge.groundingScope === "scoped" ? plan.scope.topics[0] : undefined;
  const queryText = [plan.scope.spark, ...plan.scope.topics.map(contentMatrixLabel)].filter(Boolean).join(" — ") || plan.name;
  const rag = await retrieveSemanticKnowledgeContext({
    ctx,
    ownerKind: "workspace",
    ownerId: ws.id,
    queryText,
    limit: 8,
    bypassEnabledFlag: true,
    ...(scopedTopic ? { filter: { topic: scopedTopic } } : {}),
  }).catch(() => null);

  // The active brand voice (tenant-global authored voice, else the programme's own).
  const brandVoice = await activeBrandVoiceText(ctx.tenantId, ws.brandVoice);

  // Three architects: an eBook plan finalizes the authored book onto a hub+spoke canvas;
  // an email sequence builds a linear drip; everything else builds the hub-and-spoke graph.
  const hubChannel = plan.topology.hubChannel;
  if (hubChannel === "ebook") {
    // Finalize is an eBook path — the same server flag as the studio routes.
    if (!isEbookEnabled()) return { ok: false, status: 503, error: "ebook_disabled" };
    // The book is authored in the studio; finalizing needs a draft.
    const ebook = EbookDocSchema.safeParse(plan.ebookDraft);
    if (!ebook.success) return { ok: false, status: 400, error: "ebook_not_authored" };
    return {
      ok: true,
      graph: await architectEbookPlan({
        spark: plan.scope.spark,
        spokeChannels: plan.topology.spokeChannels,
        ebook: ebook.data,
        templates: await templates(),
      }),
    };
  }
  if (plan.strategy.objective === "email_sequence" && plan.strategy.sequenceType) {
    return {
      ok: true,
      graph: await architectSequence({
        sequenceType: plan.strategy.sequenceType,
        spark: plan.scope.spark,
        topicLabels: plan.scope.topics.map(contentMatrixLabel),
        knowledgeContext: rag?.formatted ?? "",
        brandVoice,
        audience: ws.audience ?? null,
      }),
    };
  }
  return {
    ok: true,
    graph: await architectPlan({
      objective: plan.strategy.objective,
      spark: plan.scope.spark,
      topicLabels: plan.scope.topics.map(contentMatrixLabel),
      hubChannel,
      spokeChannels: plan.topology.spokeChannels,
      knowledgeContext: rag?.formatted ?? "",
      brandVoice,
      audience: ws.audience ?? null,
      templates: await templates(),
    }),
  };
}
