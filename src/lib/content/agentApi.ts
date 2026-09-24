import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { ContentObjective, SequenceType, type ContentPlan } from "@/lib/types/contentPlan";
import { verifyCanvasContext, isCanvasAuthConfigured, tenantContextFromCanvasToken } from "@/lib/canvas/auth";
import { getContentPlan, listContentPlans, listTemplates } from "@/lib/tenant/workspaceContent";
import { isContentChatAuthoringEnabled } from "./chatAuthoring";
import { CONTENT_MATRIX_TOPICS } from "./contentMatrix";
import { CHANNELS } from "./channels";

/**
 * What Vizzy (the content_ops agent, nav v2 phase 4) may READ to draft or edit a
 * content plan: the brand's programmes, their template counts and recent plans,
 * and one plan's pieces — plus the values an intake accepts. Brand content only:
 * never a subscriber, an email address or anyone's data. Auth is the signed
 * canvas capability token, gated by CONTENT_CHAT_AUTHORING_ENABLED (separate from
 * the lifecycle gate, which needs the lifecycle flags).
 */

export type ApiResult = { status: number; body: unknown };

export function contentAgentGate(req: Request): { ok: true; ctx: TenantContext } | { ok: false; result: ApiResult } {
  if (!isContentChatAuthoringEnabled()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  return { ok: true, ctx: tenantContextFromCanvasToken(verified.claims) };
}

const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);
const isPiece = (t: string) => t !== "trigger" && t !== "wait" && t !== "condition";

function planSummary(p: ContentPlan) {
  const pieces = p.graph.nodes.filter((n) => isPiece(n.type));
  return {
    id: p.id,
    name: p.name,
    objective: p.strategy.objective,
    status: p.status,
    hubChannel: p.topology.hubChannel,
    pieces: pieces.length,
    written: pieces.filter((n) => n.status === "generated" || n.status === "approved").length,
    approved: pieces.filter((n) => n.status === "approved").length,
    authoredBy: p.authoredBy ?? "human",
    createdAt: p.createdAt,
  };
}

/** The brand's programmes (the one in view first), each with template counts and recent plans. */
export async function agentContentContext(
  ctx: TenantContext,
  opts: { workspaceId?: string | null } = {},
  db?: FirestoreLike,
): Promise<ApiResult> {
  const all = (await forTenant(ctx, db).workspaces.find({ where: [], limit: 200 })).filter((w) => !w.archivedAt);
  all.sort((a, b) => (a.id === opts.workspaceId ? -1 : b.id === opts.workspaceId ? 1 : 0));
  const programmes = await Promise.all(
    all.slice(0, 20).map(async (w) => {
      const [plans, templates] = await Promise.all([
        listContentPlans(ctx, w.id, 10, db).catch(() => [] as ContentPlan[]),
        listTemplates(ctx, w.id, 300, db).catch(() => []),
      ]);
      const byChannel: Record<string, number> = {};
      for (const t of templates) {
        const ch = t.channel ?? "any";
        byChannel[ch] = (byChannel[ch] ?? 0) + 1;
      }
      return {
        id: w.id,
        name: w.name,
        inView: w.id === opts.workspaceId,
        audience: clip(w.audience, 300),
        /** A programme voice is only used when the brand has no voice of its own. */
        hasOwnVoice: !!w.brandVoice?.trim(),
        templates: byChannel,
        recentPlans: plans.slice(0, 10).map(planSummary),
      };
    }),
  );
  return {
    status: 200,
    body: {
      programmes,
      allowed: {
        objectives: ContentObjective.options,
        sequenceTypes: SequenceType.options,
        hubChannels: ["newsletter", "blog"],
        spokeChannels: CHANNELS.map((c) => c.id).filter((id) => id !== "standalone" && id !== "newsletter" && id !== "blog" && id !== "ebook"),
        topics: CONTENT_MATRIX_TOPICS.map((t) => ({ id: t.id, label: t.label })),
      },
    },
  };
}

/** One plan's pieces — ids, types, statuses and (clipped) copy — so Vizzy can rewrite the right ones. */
export async function agentContentPlan(
  ctx: TenantContext,
  workspaceId: string,
  planId: string,
  db?: FirestoreLike,
): Promise<ApiResult> {
  const ws = await forTenant(ctx, db).workspaces.getById(workspaceId);
  if (!ws) return { status: 404, body: { error: "workspace_not_found" } };
  const plan = await getContentPlan(ctx, workspaceId, planId, db);
  if (!plan) return { status: 404, body: { error: "plan_not_found" } };
  return {
    status: 200,
    body: {
      plan: planSummary(plan),
      pieces: plan.graph.nodes
        .filter((n) => isPiece(n.type))
        .slice(0, 60)
        .map((n) => ({
          id: n.id,
          type: n.type,
          channel: n.channel,
          role: n.role,
          status: n.status,
          scheduled: !!(n.distributionStatus || n.scheduledAt),
          brief: clip(n.brief, 400),
          subject: n.subject ?? null,
          body: clip(n.body, 1200),
        })),
    },
  };
}
