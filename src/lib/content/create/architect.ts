import { randomUUID } from "node:crypto";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { composePrompt, brandVoiceSection, audienceSection } from "@/lib/agents/prompts/compose";
import { generateText, parseFirstJson } from "@/lib/agents/gemini";
import { isChannel, channelBlueprint } from "@/lib/content/channels";
import { isBlockType } from "@/lib/content/blocks";
import { CORE_ANGLES, isCoreAngle, getFramework, frameworkLabel } from "@/lib/content/frameworks";
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
 * body:""). The TOPOLOGY is canonical and derived deterministically in code (one hub,
 * a pre-hub + post-hub promo, and a spider-web of (content-angle × selected-channel)
 * spokes). The model enriches the hub/promo briefs AND proposes which CORE content
 * angles this hub genuinely supports; code fans each chosen angle across every selected
 * channel. If Gemini is unconfigured/errors, a deterministic fallback (all core angles)
 * is returned so the canvas always builds.
 */

const DEFAULT_PROMO_CHANNEL = "linkedin";

// Radial "spider-web" layout (px). Hub centered; the (angle × channel) spokes sit on
// concentric rings around it; the pre/post promos are parked left/right of the hub.
const CENTER = { x: 900, y: 620 };
const RING_RADIUS = 340; // first ring radius
const RING_STEP = 220; // added radius per outer ring
const MAX_PER_RING = 10; // spokes per ring before spilling outward
const PROMO_OFFSET_X = 520; // promos sit this far left/right of the hub

/** Even radial placement: spoke i of n on a ring around the hub, spilling to an outer
 *  ring every MAX_PER_RING so a large matrix never overlaps. Starts at 12 o'clock and
 *  steps clockwise; alternate rings are half-step offset so nodes don't line up. */
function radialPos(i: number, n: number): { x: number; y: number } {
  const ring = Math.floor(i / MAX_PER_RING);
  const idxInRing = i % MAX_PER_RING;
  const countInRing = Math.min(n - ring * MAX_PER_RING, MAX_PER_RING);
  const radius = RING_RADIUS + ring * RING_STEP;
  const angleStep = (2 * Math.PI) / Math.max(countInRing, 1);
  const theta = -Math.PI / 2 + idxInRing * angleStep + (ring % 2) * (angleStep / 2);
  return {
    x: Math.round(CENTER.x + radius * Math.cos(theta)),
    y: Math.round(CENTER.y + radius * Math.sin(theta)),
  };
}

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

/** A CORE content angle the model proposed for this hub (id + a one-line brief). */
interface ProposedAngle {
  id: string;
  brief: string;
}
/** The architect call returns hub/promo node briefs AND the proposed angle subset. */
interface ArchitectResult {
  nodes: ModelNode[];
  angles: ProposedAngle[];
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
  framework: string | null,
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
    framework,
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

async function callArchitect(input: ArchitectInput): Promise<ArchitectResult> {
  // The catalog of CORE angles the model chooses from (never invents ids outside it).
  const angleCatalog = CORE_ANGLES.map((id) => {
    const f = getFramework(id);
    return `- ${id} (${f?.label ?? id}): ${f?.description ?? ""}`;
  }).join("\n");
  const task = renderPrompt("content.architect", {
    objective: input.objective,
    spark: input.spark || "(none provided)",
    topics: input.topicLabels.length ? input.topicLabels.join(", ") : "(none)",
    hub_channel: input.hubChannel,
    hub_blueprint: channelBlueprint(input.hubChannel),
    spoke_channels: input.spokeChannels.length ? input.spokeChannels.join(", ") : "(none)",
    angle_catalog: angleCatalog,
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
  if (!j || typeof j !== "object") return { nodes: [], angles: [] };
  const obj = j as Record<string, unknown>;
  const nodes = Array.isArray(obj.nodes) ? (obj.nodes as ModelNode[]) : [];
  const rawAngles = Array.isArray(obj.angles) ? obj.angles : [];
  const angles: ProposedAngle[] = [];
  const seen = new Set<string>();
  for (const a of rawAngles) {
    const cand = a as { id?: unknown; brief?: unknown };
    const id = typeof cand?.id === "string" ? cand.id.trim() : "";
    if (isCoreAngle(id) && !seen.has(id)) {
      seen.add(id);
      angles.push({ id, brief: typeof cand?.brief === "string" ? cand.brief.trim() : "" });
    }
  }
  return { nodes, angles };
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
  const result = await callArchitect(input).catch(
    () => ({ nodes: [], angles: [] }) as ArchitectResult,
  );
  const models = result.nodes;

  const spokeChannels = [...new Set(input.spokeChannels.filter(isChannel))].slice(0, 8);
  const promoChannel = spokeChannels[0] ?? DEFAULT_PROMO_CHANNEL;
  const sparkHint = input.spark ? ` on "${input.spark.slice(0, 120)}"` : "";
  const templates = input.templates ?? [];

  // The angle subset the model proposed; fall back to the full core set if none survived
  // (Gemini off/errored/returned nothing valid) so the canvas always builds a full web.
  let angles: ProposedAngle[] = result.angles.filter((a) => isCoreAngle(a.id));
  if (angles.length === 0) angles = CORE_ANGLES.map((id) => ({ id, brief: "" }));

  const nodes: ContentNode[] = [];

  // Hub — centered.
  const hubBlock = matchModel(models, "hub", input.hubChannel);
  const hubNode = emptyNode(
    "hub",
    input.hubChannel,
    "Hub",
    hubBlock.blockType || "full-post",
    hubBlock.brief || `Write the comprehensive ${input.hubChannel} centerpiece${sparkHint}, grounded in the workspace knowledge.`,
    { x: CENTER.x, y: CENTER.y },
    pickTemplate(templates, "hub", input.hubChannel, hubBlock.blockType || "full-post"),
    null,
  );

  // Pre-hub teaser — left of the hub.
  {
    const { brief, blockType } = matchModel(models, "promo_pre", promoChannel);
    nodes.push(
      emptyNode(
        "promo_pre",
        promoChannel,
        "Pre-Hub Teaser",
        blockType,
        brief || `Tease the upcoming hub${sparkHint}; build anticipation and point readers to {{hub_url}}.`,
        { x: CENTER.x - PROMO_OFFSET_X, y: CENTER.y },
        pickTemplate(templates, "promo_pre", promoChannel, blockType),
        null,
      ),
    );
  }
  nodes.push(hubNode);
  // Post-hub promo — right of the hub.
  {
    const { brief, blockType } = matchModel(models, "promo_post", promoChannel);
    nodes.push(
      emptyNode(
        "promo_post",
        promoChannel,
        "Post-Hub Promo",
        blockType,
        brief || `Recap the hub's payoff${sparkHint} and drive clicks to {{hub_url}}.`,
        { x: CENTER.x + PROMO_OFFSET_X, y: CENTER.y },
        pickTemplate(templates, "promo_post", promoChannel, blockType),
        null,
      ),
    );
  }

  // Spoke MATRIX: each proposed angle × each selected channel, arranged radially. Ordered
  // angle-major so an angle's per-channel variants cluster together on the ring.
  const spokeBlock = defaultBlockFor("spoke");
  const slots = angles.flatMap((a) => spokeChannels.map((channel) => ({ angle: a, channel })));
  slots.forEach((slot, i) => {
    const f = getFramework(slot.angle.id);
    const angleBrief = slot.angle.brief ? ` ${slot.angle.brief}` : "";
    nodes.push(
      emptyNode(
        "spoke",
        slot.channel,
        `${frameworkLabel(slot.angle.id)} → ${slot.channel}`,
        spokeBlock,
        `Atomize the hub as a ${f?.label ?? slot.angle.id} for ${slot.channel}${sparkHint}.${angleBrief} ${f?.structureHint ?? ""}`.trim(),
        radialPos(i, slots.length),
        pickTemplate(templates, "spoke", slot.channel, spokeBlock),
        slot.angle.id,
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
