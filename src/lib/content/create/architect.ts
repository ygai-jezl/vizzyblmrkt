import { randomUUID } from "node:crypto";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { composePrompt, brandVoiceSection, audienceSection } from "@/lib/agents/prompts/compose";
import { generateText, parseFirstJson } from "@/lib/agents/gemini";
import { isChannel, channelBlueprint } from "@/lib/content/channels";
import { isBlockType } from "@/lib/content/blocks";
import { WRITING_RULES } from "@/lib/content/writingRules";
import type {
  ContentNode,
  ContentEdge,
  ContentNodeType,
  ContentObjective,
} from "@/lib/types/contentPlan";

/**
 * The Architect — stage 1 of the Create pillar. One Gemini call turns the intake +
 * RAG context into a hub-and-spoke NODE GRAPH skeleton (every node status:"empty",
 * body:""). The TOPOLOGY is canonical and derived deterministically in code (one
 * hub, a pre-hub + post-hub promo, one spoke per selected channel, fixed edges);
 * the model only enriches each node with a grounded BRIEF + a blockType suggestion.
 * If Gemini is unconfigured/errors, a deterministic fallback skeleton is returned so
 * the canvas always builds.
 */

const DEFAULT_PROMO_CHANNEL = "linkedin";

// Canvas layout (px). Pre → Hub → Post stacked centrally; spokes fanned in a row.
const COL_X = 240;
const ROW_Y = 160;
const SPOKE_GAP_X = 240;

/** Minimal template shape the architect matches against (from listTemplates). */
export interface TemplateRef {
  id: string;
  channel?: string | null;
  blockType?: string | null;
  tier?: string | null;
}

export interface ArchitectInput {
  objective: ContentObjective;
  spark: string;
  topicLabels: string[];
  hubChannel: "newsletter" | "blog";
  spokeChannels: string[];
  /** Pre-formatted RAG block (may be ""). */
  knowledgeContext: string;
  brandVoice?: string | null;
  audience?: string | null;
  /** Workspace templates to auto-select skeletons from (operator can override later). */
  templates?: TemplateRef[];
}

export interface ArchitectGraph {
  nodes: ContentNode[];
  edges: ContentEdge[];
}

interface ModelNode {
  type?: string;
  channel?: string;
  role?: string;
  blockType?: string;
  brief?: string;
}

function defaultBlockFor(type: ContentNodeType): string {
  switch (type) {
    case "hub":
      return "full-post";
    case "promo_pre":
      return "hook";
    case "promo_post":
      return "cta";
    default:
      return "hook";
  }
}

function emptyNode(
  type: ContentNodeType,
  channel: string,
  role: string,
  blockType: string,
  brief: string,
  position: { x: number; y: number },
  templateId: string | null,
): ContentNode {
  return {
    id: `${type}_${randomUUID()}`,
    type,
    channel,
    format: null,
    blockType,
    role,
    position,
    templateId,
    brief: brief.slice(0, 2000),
    body: "",
    placeholderValues: {},
    status: "empty",
    scheduledAt: null,
    warnings: [],
  };
}

/**
 * Auto-select a saved workspace template as the node's skeleton (best match by
 * channel + tier/role). Returns its id, or null to compose freely. The operator can
 * always override this in the inspector.
 */
function pickTemplate(
  templates: TemplateRef[],
  type: ContentNodeType,
  channel: string,
  blockType: string,
): string | null {
  if (!templates.length) return null;
  const onChannel = templates.filter((t) => t.channel === channel);
  if (type === "hub") {
    return (onChannel.find((t) => t.tier === "hub") ?? onChannel[0])?.id ?? null;
  }
  if (type === "spoke") {
    return (onChannel.find((t) => t.tier === "spoke") ?? onChannel[0])?.id ?? null;
  }
  // promo: prefer a block matching the promo role (hook/cta).
  return (onChannel.find((t) => t.blockType === blockType) ?? onChannel[0])?.id ?? null;
}

async function callArchitect(input: ArchitectInput): Promise<ModelNode[]> {
  const task = renderPrompt("content.architect", {
    objective: input.objective,
    spark: input.spark || "(none provided)",
    topics: input.topicLabels.length ? input.topicLabels.join(", ") : "(none)",
    hub_channel: input.hubChannel,
    hub_blueprint: channelBlueprint(input.hubChannel),
    spoke_channels: input.spokeChannels.length ? input.spokeChannels.join(", ") : "(none)",
    knowledge_context: input.knowledgeContext || "",
  });
  const prompt = composePrompt({
    identity: brandVoiceSection(input.brandVoice),
    communication: WRITING_RULES,
    userProfile: audienceSection(input.audience),
    task,
  });
  const raw = await generateText(prompt);
  const j = raw ? parseFirstJson(raw) : null;
  if (!j || typeof j !== "object") return [];
  const arr = (j as Record<string, unknown>).nodes;
  return Array.isArray(arr) ? (arr as ModelNode[]) : [];
}

/** Pull the model's brief + blockType for a canonical slot (by type, spokes by channel). */
function matchModel(
  models: ModelNode[],
  type: ContentNodeType,
  channel: string,
): { brief: string; blockType: string } {
  const m =
    type === "spoke"
      ? models.find((x) => x?.type === "spoke" && x?.channel === channel)
      : models.find((x) => x?.type === type);
  const brief = typeof m?.brief === "string" ? m.brief.trim() : "";
  const blockType =
    typeof m?.blockType === "string" && isBlockType(m.blockType) ? m.blockType : defaultBlockFor(type);
  return { brief, blockType };
}

export async function architectPlan(input: ArchitectInput): Promise<ArchitectGraph> {
  const models = await callArchitect(input).catch(() => [] as ModelNode[]);

  const spokeChannels = [...new Set(input.spokeChannels.filter(isChannel))].slice(0, 8);
  const promoChannel = spokeChannels[0] ?? DEFAULT_PROMO_CHANNEL;
  const sparkHint = input.spark ? ` on "${input.spark.slice(0, 120)}"` : "";
  const templates = input.templates ?? [];

  const nodes: ContentNode[] = [];

  // 1. Pre-hub teaser.
  {
    const { brief, blockType } = matchModel(models, "promo_pre", promoChannel);
    nodes.push(
      emptyNode(
        "promo_pre",
        promoChannel,
        "Pre-Hub Teaser",
        blockType,
        brief || `Tease the upcoming hub${sparkHint}; build anticipation and point readers to {{hub_url}}.`,
        { x: COL_X, y: 0 },
        pickTemplate(templates, "promo_pre", promoChannel, blockType),
      ),
    );
  }
  // 2. Hub.
  const hubBlock = matchModel(models, "hub", input.hubChannel);
  const hubNode = emptyNode(
    "hub",
    input.hubChannel,
    "Hub",
    hubBlock.blockType || "full-post",
    hubBlock.brief || `Write the comprehensive ${input.hubChannel} centerpiece${sparkHint}, grounded in the workspace knowledge.`,
    { x: COL_X, y: ROW_Y },
    pickTemplate(templates, "hub", input.hubChannel, hubBlock.blockType || "full-post"),
  );
  nodes.push(hubNode);
  // 3. Post-hub promo.
  {
    const { brief, blockType } = matchModel(models, "promo_post", promoChannel);
    nodes.push(
      emptyNode(
        "promo_post",
        promoChannel,
        "Post-Hub Promo",
        blockType,
        brief || `Recap the hub's payoff${sparkHint} and drive clicks to {{hub_url}}.`,
        { x: COL_X, y: ROW_Y * 2 },
        pickTemplate(templates, "promo_post", promoChannel, blockType),
      ),
    );
  }
  // 4. One spoke per selected channel, fanned out below the hub.
  const spokeCount = spokeChannels.length;
  const startX = COL_X - ((spokeCount - 1) * SPOKE_GAP_X) / 2;
  spokeChannels.forEach((channel, i) => {
    const { brief, blockType } = matchModel(models, "spoke", channel);
    nodes.push(
      emptyNode(
        "spoke",
        channel,
        `Spoke: ${channel}`,
        blockType,
        brief || `Atomize one idea from the hub into a native ${channel} post${sparkHint}.`,
        { x: startX + i * SPOKE_GAP_X, y: ROW_Y * 3 },
        pickTemplate(templates, "spoke", channel, blockType),
      ),
    );
  });

  // Canonical edges: pre → hub → post, and hub → each spoke.
  const edges: ContentEdge[] = [];
  const pre = nodes.find((n) => n.type === "promo_pre");
  const post = nodes.find((n) => n.type === "promo_post");
  if (pre) edges.push({ id: `e_${randomUUID()}`, source: pre.id, target: hubNode.id });
  if (post) edges.push({ id: `e_${randomUUID()}`, source: hubNode.id, target: post.id });
  for (const s of nodes.filter((n) => n.type === "spoke")) {
    edges.push({ id: `e_${randomUUID()}`, source: hubNode.id, target: s.id });
  }

  return { nodes, edges };
}
