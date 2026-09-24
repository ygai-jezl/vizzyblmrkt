import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import type { Workspace } from "@/lib/types/workspace";
import { getContentPlan, getTemplate, updateContentPlan, updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import { activeBrandVoiceText } from "./activeBrandVoice";
import { generateNode } from "./generateNode";

/**
 * Fill plan nodes with copy. Shared by the Create canvas's per-node route and
 * Vizzy's `content_plan` canvas kind (nav v2 phase 4), so both write the same
 * way. Brand voice comes from activeBrandVoiceText (the brand voice wins).
 */

export type FillResult = { ok: true; node: ContentNode } | { ok: false; status: number; error: string };

export interface FillDeps {
  db?: FirestoreLike;
  /** The copywriter (tests inject a stub). */
  generate?: typeof generateNode;
}

type WorkspaceBits = Pick<Workspace, "id" | "brandVoice" | "audience">;

/** Fill ONE node and flip the plan to "ready" once nothing is left empty. */
export async function fillPlanNode(
  ctx: TenantContext,
  args: { workspace: WorkspaceBits; plan: ContentPlan; nodeId: string },
  deps: FillDeps = {},
): Promise<FillResult> {
  const { workspace: ws, plan, nodeId } = args;
  const node = plan.graph.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, status: 404, error: "node_not_found" };

  // If the operator chose a template for this node, fill ITS skeleton (else compose).
  // Only honor a template native to this node's channel — a stale/mismatched pick (e.g.
  // a LinkedIn template left on a node after switching it to X) falls back to composing.
  let skeletonBody: string | null = null;
  if (node.templateId) {
    const tpl = await getTemplate(ctx, ws.id, node.templateId);
    skeletonBody = tpl && tpl.channel === node.channel ? tpl.body : null;
  }

  const patch = await (deps.generate ?? generateNode)({
    ctx,
    workspaceId: ws.id,
    plan,
    node,
    brandVoice: await activeBrandVoiceText(ctx.tenantId, ws.brandVoice),
    audience: ws.audience ?? null,
    skeletonBody,
  });

  // The persist re-validates the merged node via ContentNodeSchema.parse (throwing):
  // a schema-invalid patch is a 422, not an uncaught 500.
  let updated: ContentNode | null;
  try {
    updated = await updateContentPlanNode(
      ctx,
      ws.id,
      plan.id,
      nodeId,
      {
        body: patch.body,
        placeholderValues: patch.placeholderValues,
        status: patch.status,
        warnings: patch.warnings,
        format: patch.format,
        // Email nodes carry subject/preview/variants (+ a reconciled layout); other node
        // types omit them so we don't overwrite with undefined.
        ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
        ...(patch.previewText !== undefined ? { previewText: patch.previewText } : {}),
        ...(patch.subjectVariants !== undefined ? { subjectVariants: patch.subjectVariants } : {}),
        ...(patch.layout !== undefined ? { layout: patch.layout } : {}),
      },
      deps.db,
    );
  } catch {
    return { ok: false, status: 422, error: "invalid_node" };
  }
  if (!updated) return { ok: false, status: 404, error: "node_not_found" };

  // Flip to "ready" once nothing is left empty/generating. Read FRESH state after the
  // node transaction committed (not the pre-update snapshot) so concurrent per-node
  // fills can't all act on a stale count and leave the plan stuck in "generating".
  const fresh = await getContentPlan(ctx, ws.id, plan.id, deps.db);
  if (fresh && (fresh.status === "generating" || fresh.status === "draft")) {
    const remaining = fresh.graph.nodes.filter((n) => n.status === "empty" || n.status === "generating");
    if (remaining.length === 0) await updateContentPlan(ctx, ws.id, plan.id, { status: "ready" }, deps.db);
  }
  return { ok: true, node: updated };
}

/**
 * Fill several nodes, a few at a time, within a time budget (the agent's request
 * must return). Each node reads the plan fresh, so a spoke sees its hub's copy.
 * Nodes not reached stay empty for the operator to generate from the canvas.
 */
export async function fillPlanNodes(
  ctx: TenantContext,
  args: { workspace: WorkspaceBits; planId: string; nodeIds: string[] },
  opts: FillDeps & { budgetMs?: number; concurrency?: number; now?: () => number } = {},
): Promise<{ filled: string[]; failed: string[]; notReached: string[] }> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? 75_000);
  const queue = [...args.nodeIds];
  const filled: string[] = [];
  const failed: string[] = [];
  const worker = async () => {
    for (;;) {
      if (now() >= deadline) return;
      const nodeId = queue.shift();
      if (!nodeId) return;
      const plan = await getContentPlan(ctx, args.workspace.id, args.planId, opts.db);
      if (!plan) {
        failed.push(nodeId);
        continue;
      }
      const r = await fillPlanNode(ctx, { workspace: args.workspace, plan, nodeId }, opts).catch(() => null);
      (r?.ok ? filled : failed).push(nodeId);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 3) }, worker));
  return { filled, failed, notReached: queue };
}
