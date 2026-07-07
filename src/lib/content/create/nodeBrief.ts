import { renderPrompt } from "@/lib/agents/prompts/registry";
import { composePrompt, brandVoiceSection, audienceSection } from "@/lib/agents/prompts/compose";
import { generateText, parseFirstJson } from "@/lib/agents/gemini";
import { channelBlueprint, channelLabel } from "@/lib/content/channels";
import { getFramework, frameworkLabel } from "@/lib/content/frameworks";
import { WRITING_RULES } from "@/lib/content/writingRules";
import {
  retrieveSemanticKnowledgeContext,
  type ContextRetrievalRequest,
} from "@/lib/agents/knowledgeRetrieval";
import type { TenantContext } from "@/lib/tenant/types";
import type {
  ContentGraph,
  ContentNode,
  ContentNodeType,
  ContentPlan,
} from "@/lib/types/contentPlan";

/**
 * Auto-write a node's generation BRIEF from the nodes it's connected to. When a user
 * wires a freshly-added node DOWNSTREAM of the hub (directly or via other spokes), we
 * walk its ancestors up to the hub and ask the model for a 1–3 sentence brief — the
 * same instruction the Architect writes at build time, but on demand from the local
 * graph context. Consumed later by generateNode() exactly like any other brief.
 *
 * One Gemini call. Degrades gracefully: a deterministic fallback brief always returns
 * (mirrors architect.ts) so a connect never leaves the node brief-less.
 */

const MAX_DEPTH = 6; // ancestor hops to walk (guards deep / cyclic graphs)
const MAX_ANCESTORS = 12; // total ancestors folded into the prompt
const ANCESTOR_EXCERPT_CHARS = 1500; // per-ancestor body excerpt
const ANCESTOR_BLOCK_CHARS = 8000; // whole upstream-context block cap
const MAX_BRIEF_CHARS = 2000; // matches ContentNodeSchema.brief

export interface AncestorContext {
  id: string;
  type: ContentNodeType;
  role: string;
  channel: string;
  framework: string | null;
  brief: string | null;
  body: string;
  /** Hops from the target node (1 = direct parent). */
  distance: number;
}

/**
 * Walk the graph UPSTREAM from `nodeId` (following incoming edges: e.target === cur →
 * e.source) and collect ancestor nodes. Pure + cycle-safe (visited set), bounded by
 * MAX_DEPTH / MAX_ANCESTORS. Returned ROOT-FIRST (the hub / farthest ancestor first,
 * the nearest parent last) so the prompt reads centerpiece → nearest context.
 */
export function gatherAncestorContext(graph: ContentGraph, nodeId: string): AncestorContext[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const visited = new Set<string>([nodeId]);
  const out: AncestorContext[] = [];
  let frontier: string[] = [nodeId];

  for (let depth = 1; depth <= MAX_DEPTH && frontier.length; depth++) {
    const parents: string[] = [];
    for (const cur of frontier) {
      for (const e of graph.edges) {
        if (e.target === cur && !visited.has(e.source)) {
          visited.add(e.source);
          parents.push(e.source);
        }
      }
    }
    for (const pid of parents) {
      const n = byId.get(pid);
      if (!n) continue;
      out.push({
        id: n.id,
        type: n.type,
        role: n.role,
        channel: n.channel,
        framework: n.framework ?? null,
        brief: n.brief ?? null,
        body: n.body ?? "",
        distance: depth,
      });
      if (out.length >= MAX_ANCESTORS) return sortRootFirst(out);
    }
    frontier = parents;
  }
  return sortRootFirst(out);
}

/** Farthest ancestor (root/hub) first, nearest parent last; stable within a distance. */
function sortRootFirst(list: AncestorContext[]): AncestorContext[] {
  return list
    .map((a, i) => ({ a, i }))
    .sort((x, y) => y.a.distance - x.a.distance || x.i - y.i)
    .map(({ a }) => a);
}

/** One human-readable line per ancestor: prefer its generated body, else its brief/role. */
function formatAncestors(ancestors: AncestorContext[]): string {
  if (!ancestors.length) return "(no upstream content connected yet)";
  const lines = ancestors.map((a) => {
    const angle = a.framework ? ` · ${frameworkLabel(a.framework)}` : "";
    const source = a.body.trim()
      ? a.body.trim().slice(0, ANCESTOR_EXCERPT_CHARS)
      : a.brief?.trim() || `(planned: ${a.role})`;
    return `- ${a.role} · ${channelLabel(a.channel)}${angle}:\n${source}`;
  });
  return lines.join("\n\n").slice(0, ANCESTOR_BLOCK_CHARS);
}

/** Deterministic brief when Gemini is off / errors / returns nothing (mirrors architect). */
function fallbackBrief(node: ContentNode, plan: ContentPlan, hasAncestors: boolean): string {
  const label = node.framework ? frameworkLabel(node.framework) : node.channel;
  const sparkHint = plan.scope.spark ? ` on "${plan.scope.spark.slice(0, 120)}"` : "";
  const fw = node.framework ? getFramework(node.framework) : undefined;
  const structureHint = fw?.structureHint ? ` ${fw.structureHint}` : "";
  const source = hasAncestors ? "the connected content above" : "the workspace knowledge";
  return `Atomize ${source} as a ${label} for ${node.channel}${sparkHint}.${structureHint}`
    .trim()
    .slice(0, MAX_BRIEF_CHARS);
}

export interface GenerateNodeBriefInput {
  ctx: TenantContext;
  workspaceId: string;
  plan: ContentPlan;
  node: ContentNode;
  brandVoice?: string | null;
  audience?: string | null;
}

type RetrieveFn = typeof retrieveSemanticKnowledgeContext;

export async function generateNodeBrief(
  input: GenerateNodeBriefInput,
  retrieve: RetrieveFn = retrieveSemanticKnowledgeContext,
): Promise<{ brief: string }> {
  const { ctx, workspaceId, plan, node } = input;
  const ancestors = gatherAncestorContext(plan.graph, node.id);

  // A spoke carries a content ANGLE (framework) — inject its shape so the brief is
  // angle-aware (same treatment generateNode gives at fill time).
  const fw = node.framework ? getFramework(node.framework) : undefined;
  const angleGuidance = fw
    ? `- Content ANGLE — ${fw.label}: ${fw.description} Shape it this way: ${fw.structureHint}`
    : "";
  const angleClause = fw ? ` and the "${fw.label}" angle` : "";

  // Ground: scoped → pre-filter by the first scope topic (findNearest takes one).
  const scopedTopic =
    plan.knowledge.groundingScope === "scoped" ? plan.scope.topics[0] : undefined;
  const req: ContextRetrievalRequest = {
    ctx,
    ownerKind: "workspace",
    ownerId: workspaceId,
    queryText: plan.scope.spark || ancestors[0]?.brief || node.role,
    limit: 8,
    bypassEnabledFlag: true,
    ...(scopedTopic ? { filter: { topic: scopedTopic } } : {}),
  };
  const rag = await retrieve(req).catch(() => null);
  const knowledgeContext = rag?.formatted ?? "";

  const task = renderPrompt("content.node_brief", {
    channel: node.channel,
    channel_blueprint: channelBlueprint(node.channel),
    role: node.role,
    skeleton_present: node.templateId ? "yes (fill its {{token}} structure)" : "no (compose fresh)",
    angle_guidance: angleGuidance,
    angle_clause: angleClause,
    ancestor_context: formatAncestors(ancestors),
    spark: plan.scope.spark || "(none)",
    knowledge_context: knowledgeContext,
  });
  const prompt = composePrompt({
    identity: brandVoiceSection(input.brandVoice),
    communication: WRITING_RULES,
    userProfile: audienceSection(input.audience),
    task,
  });

  const raw = await generateText(prompt).catch(() => null);
  const j = raw ? parseFirstJson(raw) : null;
  const modelBrief =
    j && typeof j === "object" && typeof (j as Record<string, unknown>).brief === "string"
      ? ((j as Record<string, unknown>).brief as string).trim()
      : "";

  const brief = (modelBrief || fallbackBrief(node, plan, ancestors.length > 0)).slice(
    0,
    MAX_BRIEF_CHARS,
  );
  return { brief };
}
