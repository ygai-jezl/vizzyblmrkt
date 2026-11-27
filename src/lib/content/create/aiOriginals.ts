import { createHash } from "node:crypto";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { getPrompt } from "@/lib/agents/prompts/registry";
import { TEXT_MODEL } from "@/lib/agents/modelConfig";
import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import {
  PAIRS_KEPT,
  aiOriginalId,
  type AiEditPair,
  type AiOriginalCopy,
  type AiOriginalDoc,
  type MadeBy,
  type OriginalBy,
  type OriginalStamp,
  type PairTrigger,
} from "@/lib/types/aiOriginal";
import { editMeasures } from "@/lib/content/editMeasures";
import { isAiOriginalsEnabled } from "./flags";
import { keepsAiDraft } from "./aiDraft";
import { countDraftOutcome } from "@/lib/loops/count";

/**
 * The AI original of each piece a writer makes (CONTENT_AI_ORIGINALS_ENABLED), kept in
 * `ai_originals/ao_<planId>_<nodeId>` beside the copy a person edits: pinned when a writer
 * writes the piece (the canvas, the autopilot, Vizzy, Regenerate, a refresh's Apply), and paired
 * with the approved copy when a person approves it or it is marked live. Nothing here changes the
 * plan, and nothing learns from it yet: it is the record the loops' edits learner will read.
 * /help/write-and-schedule#ai-draft explains it.
 */

export interface OriginalDeps {
  db?: FirestoreLike;
  now?: () => Date;
}

const nowIso = (deps: OriginalDeps) => (deps.now ?? (() => new Date()))().toISOString();

/** Who started the writing, from who is asking: a person, the autopilot or Vizzy. */
export function originalByOf(ctx: Pick<TenantContext, "source">): OriginalBy {
  if (ctx.source === "system") return "autopilot";
  if (ctx.source === "agent") return "vizzy";
  return "person";
}

/** The prompt and model behind a writer's copy. Null when the writer said nothing. */
export function stampOf(made: MadeBy | undefined): OriginalStamp | null {
  if (!made) return null;
  let promptVersion = 0;
  let templateHash = "";
  try {
    const p = getPrompt(made.promptId);
    promptVersion = p.version;
    templateHash = createHash("sha256").update(p.template).digest("hex").slice(0, 12);
  } catch {
    // An id the registry doesn't know keeps version 0 and no hash, so it is still recorded.
  }
  return { purpose: made.purpose, promptId: made.promptId, promptVersion, templateHash, model: TEXT_MODEL, repaired: Boolean(made.repaired) };
}

const isArticle = (node: Pick<ContentNode, "type" | "channel">) => node.type === "hub" && node.channel === "blog";

/**
 * Pin a writer's copy as the piece's AI original. A piece written again replaces the pin and
 * counts one more regeneration. Nothing is kept with the switch off, or for empty copy.
 */
export async function pinOriginal(
  ctx: TenantContext,
  args: {
    plan: Pick<ContentPlan, "id" | "workspaceId">;
    node: Pick<ContentNode, "id" | "type" | "channel">;
    body: string;
    meta?: { metaTitle?: string; metaDescription?: string };
    madeBy?: MadeBy;
  },
  deps: OriginalDeps = {},
): Promise<AiOriginalDoc | null> {
  if (!isAiOriginalsEnabled()) return null;
  const { plan, node, body } = args;
  if (!body.trim()) return null;
  const at = nowIso(deps);
  const original: AiOriginalCopy = {
    body,
    ...(args.meta?.metaTitle ? { metaTitle: args.meta.metaTitle } : {}),
    ...(args.meta?.metaDescription ? { metaDescription: args.meta.metaDescription } : {}),
    at,
    by: originalByOf(ctx),
    userId: ctx.userId ?? null,
    stamp: stampOf(args.madeBy),
    sources: [...new Set(args.madeBy?.sources ?? [])],
  };
  const { doc } = await forTenant(ctx, deps.db).aiOriginals.upsert(
    aiOriginalId(plan.id, node.id),
    () => ({ planId: plan.id, workspaceId: plan.workspaceId, nodeId: node.id, nodeType: node.type, channel: node.channel, original, regenerations: 0, pairs: [], updatedAt: at }),
    (current) => (current.original.body === body ? null : { original, regenerations: current.regenerations + 1, updatedAt: at }),
  );
  return doc;
}

/**
 * The fact check rewrote sentences of a fresh draft: the checked copy is still the AI's, so it
 * replaces the pin, but only while the pin is the copy the check started from (a person who
 * edited in between keeps their pin).
 */
export async function followCheck(
  ctx: TenantContext,
  args: { planId: string; nodeId: string; before: string; after: string },
  deps: OriginalDeps = {},
): Promise<boolean> {
  if (!isAiOriginalsEnabled() || args.before === args.after || !args.after.trim()) return false;
  const repo = forTenant(ctx, deps.db).aiOriginals;
  const id = aiOriginalId(args.planId, args.nodeId);
  if (!(await repo.getById(id).catch(() => null))) return false;
  let moved = false;
  await repo.upsert(
    id,
    () => {
      throw new Error("ai original gone");
    },
    (current) => {
      moved = current.original.body === args.before;
      return moved ? { original: { ...current.original, body: args.after }, updatedAt: nowIso(deps) } : null;
    },
  ).catch(() => null);
  return moved;
}

/**
 * A person approved the piece (or it was marked live): keep the AI original beside the approved
 * copy, with how they differ. The same approval kept twice (approved, then found live with the same
 * copy) is kept once. Returns the pair, or null when nothing was kept.
 */
export async function recordApproval(
  ctx: TenantContext,
  args: { planId: string; node: Pick<ContentNode, "id" | "type" | "channel" | "body">; trigger: PairTrigger },
  deps: OriginalDeps = {},
): Promise<AiEditPair | null> {
  return (await keepApproval(ctx, args, deps))?.pair ?? null;
}

/** recordApproval, saying too whether the pair is the first kept for this AI original, so a piece counts once however often it is approved again. */
async function keepApproval(
  ctx: TenantContext,
  args: { planId: string; node: Pick<ContentNode, "id" | "type" | "channel" | "body">; trigger: PairTrigger },
  deps: OriginalDeps = {},
): Promise<{ pair: AiEditPair; first: boolean } | null> {
  if (!isAiOriginalsEnabled() || !args.node.body.trim()) return null;
  const repo = forTenant(ctx, deps.db).aiOriginals;
  const id = aiOriginalId(args.planId, args.node.id);
  const doc = await repo.getById(id).catch(() => null);
  if (!doc) return null;
  const at = nowIso(deps);
  const last = doc.pairs[0];
  if (last && last.final.body === args.node.body && last.original.at === doc.original.at) return null;
  const pair: AiEditPair = {
    original: doc.original,
    final: { body: args.node.body, at, userId: ctx.userId ?? null },
    trigger: args.trigger,
    measures: editMeasures(doc.original.body, args.node.body, {
      originalAt: doc.original.at,
      approvedAt: at,
      regenerations: doc.regenerations,
      sections: isArticle(args.node),
    }),
  };
  let kept: { pair: AiEditPair; first: boolean } | null = null;
  await repo.upsert(
    id,
    () => {
      throw new Error("ai original gone");
    },
    (current) => {
      const top = current.pairs[0];
      if (top && top.final.body === pair.final.body && top.original.at === current.original.at) return null;
      kept = { pair, first: !current.pairs.some((p) => p.original.at === current.original.at) };
      // Regenerations count from one approval to the next.
      return { pairs: [pair, ...current.pairs].slice(0, PAIRS_KEPT), regenerations: 0, updatedAt: at };
    },
  ).catch(() => null);
  return kept;
}

/** Each piece a save approved: its status became "approved" in this save. */
export function newlyApproved(before: Pick<ContentPlan, "graph">, after: Pick<ContentPlan, "graph"> | null): ContentNode[] {
  if (!after) return [];
  const was = new Map(before.graph.nodes.map((n) => [n.id, n.status] as const));
  return after.graph.nodes.filter((n) => n.status === "approved" && was.get(n.id) !== "approved" && n.body.trim());
}

/**
 * Keep each approval a plan save made (the canvas Approve). Never fails the save. A piece's first
 * approval of its AI original also counts kept or edited against the piece's stamp, by the words
 * changed (learning loops step 5). A LinkedIn or X post counts when it is published instead, where
 * its words go public, so a post approved and then posted counts once.
 */
export async function recordApprovals(
  ctx: TenantContext,
  args: { before: ContentPlan; after: ContentPlan | null },
  deps: OriginalDeps = {},
): Promise<number> {
  if (!isAiOriginalsEnabled()) return 0;
  let n = 0;
  for (const node of newlyApproved(args.before, args.after)) {
    const kept = await keepApproval(ctx, { planId: args.before.id, node, trigger: "approve" }, deps).catch((err) => {
      console.error("[ai originals] keeping an approval failed", err);
      return null;
    });
    if (kept) n += 1;
    if (kept?.first && !keepsAiDraft(node.channel)) await countDraftOutcome(ctx, node.made, { wordsChanged: kept.pair.measures.wordsChanged }, { db: deps.db });
  }
  return n;
}

export async function readOriginal(ctx: TenantContext, planId: string, nodeId: string, deps: OriginalDeps = {}): Promise<AiOriginalDoc | null> {
  return forTenant(ctx, deps.db).aiOriginals.getById(aiOriginalId(planId, nodeId)).catch(() => null);
}

/** Every piece's AI original in a plan, for Vizzy's read of it. */
export async function readPlanOriginals(ctx: TenantContext, planId: string, deps: OriginalDeps = {}): Promise<AiOriginalDoc[]> {
  return forTenant(ctx, deps.db).aiOriginals.find({ where: [["planId", "==", planId]], limit: 100 }).catch(() => []);
}

/** A plan's AI originals go with it. */
export async function deleteOriginals(ctx: TenantContext, planId: string, deps: OriginalDeps = {}): Promise<number> {
  return forTenant(ctx, deps.db).aiOriginals.deleteWhere([["planId", "==", planId]]).catch(() => 0);
}
