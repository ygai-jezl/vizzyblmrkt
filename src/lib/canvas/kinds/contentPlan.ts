import { z } from "zod";
import { forTenant, isRateLimited } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ContentPlan } from "@/lib/types/contentPlan";
import type { Workspace } from "@/lib/types/workspace";
import {
  createContentPlan,
  deleteContentPlan,
  getContentPlan,
  updateContentPlan,
  updateContentPlanNode,
} from "@/lib/tenant/workspaceContent";
import { isContentChatAuthoringEnabled } from "@/lib/content/chatAuthoring";
import { IntakeSchema, planFromIntake } from "@/lib/content/create/intake";
import { runArchitect } from "@/lib/content/create/architectRun";
import { fillPlanNodes } from "@/lib/content/create/fillPlan";
import type { generateNode } from "@/lib/content/create/generateNode";
import type { CanvasAuthorArgs, CanvasAuthorOutcome, CanvasKind } from "../types";

/**
 * The `content_plan` canvas kind (nav v2 phase 4) — Vizzy drafts a content plan
 * in a programme from the chat, through the SAME intake, architect and copywriter
 * as the Create wizard, so the two produce identical drafts. Two modes:
 *  - `create`: a new plan from an intake; the architect lays out the pieces, then
 *    the hub is written (or, for an email sequence, the emails). The rest waits
 *    for the operator to approve the hub and press Generate on the canvas.
 *  - `refill`: rewrite chosen pieces from instructions. Never an approved or
 *    scheduled piece, and never a promo or spoke before the hub is approved.
 * Vizzy never approves, schedules or publishes; the tenant comes only from the
 * signed capability token.
 */

const ContentPlanInput = z.object({
  scope: z.object({
    workspaceId: z.string().min(1).max(200),
    planId: z.string().min(1).max(80).nullish(),
  }),
  mode: z.enum(["create", "refill"]).default("create"),
  intake: z.unknown().optional(),
  nodeIds: z.array(z.string().min(1).max(80)).min(1).max(20).optional(),
  instructions: z.string().trim().max(1500).optional(),
});

/** Each draft is an architect call plus several copywriter calls: keep it bounded per tenant. */
const AUTHOR_LIMIT = { prefix: "content_author", burstLimit: 3, hourlyLimit: 12 };
const SOCIAL = new Set(["promo_pre", "promo_post", "spoke"]);

export interface ContentPlanDeps {
  db?: FirestoreLike;
  architect?: typeof runArchitect;
  generate?: typeof generateNode;
  /** The agent's request has to return: fill what fits in this long. */
  budgetMs?: number;
}

function card(plan: ContentPlan, ws: Pick<Workspace, "id" | "name">, failed: number) {
  const url = `/admin/workspace/${ws.id}/create/${plan.id}`;
  const nodes = plan.graph.nodes.filter((n) => n.type !== "trigger" && n.type !== "wait" && n.type !== "condition");
  const written = nodes.filter((n) => n.status === "generated" || n.status === "approved").length;
  return {
    url,
    card: {
      kind: "content_plan",
      id: plan.id,
      title: plan.name,
      subtitle: ws.name,
      url,
      stats: [
        { label: "pieces", value: nodes.length },
        { label: "written", value: written },
        { label: "to write", value: nodes.length - written },
      ],
      warnings: failed,
    },
  };
}

export async function authorContentPlanDraft(
  { ctx, input, brief }: CanvasAuthorArgs,
  deps: ContentPlanDeps = {},
): Promise<CanvasAuthorOutcome> {
  if (!isContentChatAuthoringEnabled()) return { ok: false, status: 503, error: "unavailable" };
  const req = ContentPlanInput.safeParse(input);
  if (!req.success) {
    return { ok: false, status: 400, error: "invalid_input", issues: req.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  if (await isRateLimited(`tenant:${ctx.tenantId}`, AUTHOR_LIMIT, { db: deps.db })) {
    return { ok: false, status: 429, error: "rate_limited" };
  }
  const ws = await forTenant(ctx, deps.db).workspaces.getById(req.data.scope.workspaceId);
  if (!ws || ws.archivedAt) return { ok: false, status: 404, error: "workspace_not_found" };
  const fillOpts = { db: deps.db, generate: deps.generate, budgetMs: deps.budgetMs ?? 75_000, concurrency: 3 };

  if (req.data.mode === "refill") {
    const planId = req.data.scope.planId;
    if (!planId || !req.data.nodeIds?.length) {
      return { ok: false, status: 400, error: "invalid_input", issues: ["refill needs scope.planId and nodeIds"] };
    }
    const plan = await getContentPlan(ctx, ws.id, planId, deps.db);
    if (!plan || plan.status === "archived") return { ok: false, status: 404, error: "plan_not_found" };
    const hub = plan.graph.nodes.find((n) => n.type === "hub");
    const refused: string[] = [];
    for (const id of req.data.nodeIds) {
      const node = plan.graph.nodes.find((n) => n.id === id);
      if (!node) refused.push(`${id}: not in this plan`);
      else if (node.status === "approved") refused.push(`${id}: approved by a person — leave it alone`);
      else if (node.distributionStatus || node.scheduledAt) refused.push(`${id}: already scheduled`);
      else if (SOCIAL.has(node.type) && hub && hub.status !== "approved") refused.push(`${id}: approve the hub first`);
    }
    if (refused.length) return { ok: false, status: 409, error: "nodes_locked", issues: refused };

    if (req.data.instructions) {
      for (const id of req.data.nodeIds) {
        const node = plan.graph.nodes.find((n) => n.id === id)!;
        const next = [node.brief?.trim(), `Change: ${req.data.instructions}`].filter(Boolean).join("\n\n").slice(-2000);
        await updateContentPlanNode(ctx, ws.id, plan.id, id, { brief: next }, deps.db);
      }
    }
    const result = await fillPlanNodes(ctx, { workspace: ws, planId: plan.id, nodeIds: req.data.nodeIds }, fillOpts);
    const revision = (plan.agentRevision ?? 0) + 1;
    await updateContentPlan(ctx, ws.id, plan.id, { agentRevision: revision }, deps.db);
    const fresh = (await getContentPlan(ctx, ws.id, plan.id, deps.db)) ?? plan;
    const { url, card: c } = card(fresh, ws, result.failed.length);
    return {
      ok: true,
      id: plan.id,
      status: fresh.status,
      url,
      summary:
        `Rewrote ${result.filled.length} of ${req.data.nodeIds.length} piece${req.data.nodeIds.length === 1 ? "" : "s"} in “${plan.name}”.` +
        (result.notReached.length ? ` ${result.notReached.length} didn't fit in time — generate them on the canvas.` : "") +
        " Review them on the canvas; nothing is scheduled.",
      warnings: result.failed.map((id) => `${id}: couldn't be written`),
      card: c,
    };
  }

  // create
  const intake = IntakeSchema.safeParse(req.data.intake);
  if (!intake.success) {
    return {
      ok: false,
      status: 422,
      error: "invalid_intake",
      issues: intake.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  if (intake.data.topology.hubChannel === "ebook") {
    return { ok: false, status: 422, error: "ebook_in_studio", issues: ["eBooks are written in the eBook studio, not from chat."] };
  }
  const created = await createContentPlan(
    ctx,
    ws.id,
    { ...planFromIntake(intake.data), authoredBy: "agent", agentRevision: 1, agentBrief: brief.slice(0, 4000) },
    deps.db,
  );
  let built: Awaited<ReturnType<typeof runArchitect>>;
  try {
    built = await (deps.architect ?? runArchitect)(ctx, { workspace: ws, plan: created });
  } catch (err) {
    console.error("[canvas/content_plan] architect failed", err);
    built = { ok: false, status: 502, error: "architect_failed" };
  }
  if (!built.ok) {
    // Nothing is written yet: don't leave an empty plan behind for every retry.
    await deleteContentPlan(ctx, ws.id, created.id, deps.db).catch(() => undefined);
    return { ok: false, status: built.status, error: built.error };
  }
  await updateContentPlan(ctx, ws.id, created.id, { graph: built.graph, status: "generating" }, deps.db);

  // Write what can be written without a person: the hub (its spokes wait for its
  // approval), or every email of a sequence.
  const sequence = created.strategy.objective === "email_sequence";
  const toFill = built.graph.nodes
    .filter((n) => n.status === "empty" && (sequence ? n.type === "email" : n.type === "hub"))
    .map((n) => n.id);
  const result = await fillPlanNodes(ctx, { workspace: ws, planId: created.id, nodeIds: toFill }, fillOpts);
  const plan = (await getContentPlan(ctx, ws.id, created.id, deps.db)) ?? { ...created, graph: built.graph };
  const { url, card: c } = card(plan, ws, result.failed.length);
  const written = sequence
    ? `${result.filled.length} of ${toFill.length} emails written`
    : result.filled.length
      ? "the hub is written"
      : "the hub still needs writing";
  return {
    ok: true,
    id: plan.id,
    status: plan.status,
    url,
    summary:
      `Drafted “${plan.name}” in ${ws.name}: ${c.stats[0]!.value} pieces planned, ${written}. ` +
      (sequence
        ? "Review the emails on the canvas."
        : "Approve the hub on the canvas, then press Generate for the promos and spokes.") +
      " Nothing is scheduled.",
    warnings: result.failed.map((id) => `${id}: couldn't be written`),
    card: c,
  };
}

export const contentPlanCanvasKind: CanvasKind = {
  kind: "content_plan",
  label: "content plan",
  authorDraft: (args) => authorContentPlanDraft(args),
};
