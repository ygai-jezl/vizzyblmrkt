import { randomUUID } from "node:crypto";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { composePrompt, brandVoiceSection, audienceSection } from "@/lib/agents/prompts/compose";
import { generateText, parseFirstJson } from "@/lib/agents/gemini";
import { isChannel, channelBlueprint } from "@/lib/content/channels";
import { isBlockType } from "@/lib/content/blocks";
import { CORE_ANGLES, isCoreAngle, getFramework, frameworkLabel } from "@/lib/content/frameworks";
import { WRITING_RULES } from "@/lib/content/writingRules";
import { getSequenceBlueprint, type SequenceBlueprint } from "@/lib/content/create/sequenceBlueprints";
import { emailFrameworkLabel } from "@/lib/content/emailFrameworks";
import type {
  ContentNode,
  ContentEdge,
  ContentNodeType,
  ContentObjective,
  EbookDoc,
  SequenceType,
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
  overrides: Partial<ContentNode> = {},
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
    subject: null,
    previewText: null,
    subjectVariants: [],
    waitConfig: null,
    conditionConfig: null,
    ...overrides,
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

// ── eBook architect ─────────────────────────────────────────────────────────
// Finalize an authored eBook onto the canvas: the hub node IS the eBook (already written
// in the studio, so status:"generated" — nothing to LLM-fill), surrounded by the same
// pre/post promos + (angle × channel) spoke web as a normal hub-and-spoke plan so the
// operator can atomize the book into channel-native content. Fully deterministic (no
// Gemini call) — the book already exists; spokes carry briefs that reference it.

export interface EbookArchitectInput {
  spark: string;
  spokeChannels: string[];
  ebook: EbookDoc;
  templates?: TemplateRef[];
}

export async function architectEbookPlan(input: EbookArchitectInput): Promise<ArchitectGraph> {
  const spokeChannels = [...new Set(input.spokeChannels.filter(isChannel))].slice(0, 8);
  const promoChannel = spokeChannels[0] ?? DEFAULT_PROMO_CHANNEL;
  const sparkHint = input.spark ? ` on "${input.spark.slice(0, 120)}"` : "";
  const templates = input.templates ?? [];
  const title = input.ebook.title || "eBook";
  const synopsis =
    input.ebook.subtitle ||
    input.ebook.chapters.map((c) => c.title).filter(Boolean).join(" · ") ||
    title;

  const nodes: ContentNode[] = [];

  // The hub carries only a LIGHT eBook (ToC skeleton — titles/summaries, no chapter HTML or
  // image slots): the heavy prose stays the single source of truth on ContentPlan.ebookDraft
  // (which the studio re-opens), so the plan doc never stores the whole book twice (Firestore
  // 1MB cap). The canvas hub + preview only need the cover + table of contents.
  const hubEbook = {
    ...input.ebook,
    chapters: input.ebook.chapters.map((c) => ({ ...c, bodyHtml: "", images: [] })),
  };

  // Hub — the authored eBook, centered. status:"generated" (its content already exists).
  const hubNode = emptyNode(
    "hub",
    "ebook",
    `eBook: ${title}`.slice(0, 120),
    "full-post",
    `The eBook "${title}"${sparkHint}. Atomize its chapters into the spokes below.`,
    { x: CENTER.x, y: CENTER.y },
    null,
    null,
    { status: "generated", body: synopsis.slice(0, 2000), ebook: hubEbook },
  );

  // Pre-hub teaser — left of the hub.
  nodes.push(
    emptyNode(
      "promo_pre",
      promoChannel,
      "Pre-eBook Teaser",
      defaultBlockFor("promo_pre"),
      `Tease the upcoming eBook "${title}"${sparkHint}; build anticipation and point readers to {{hub_url}}.`,
      { x: CENTER.x - PROMO_OFFSET_X, y: CENTER.y },
      pickTemplate(templates, "promo_pre", promoChannel, defaultBlockFor("promo_pre")),
      null,
    ),
  );
  nodes.push(hubNode);
  // Post-hub promo — right of the hub.
  nodes.push(
    emptyNode(
      "promo_post",
      promoChannel,
      "Post-eBook Promo",
      defaultBlockFor("promo_post"),
      `Recap the eBook "${title}"'s payoff${sparkHint} and drive downloads at {{hub_url}}.`,
      { x: CENTER.x + PROMO_OFFSET_X, y: CENTER.y },
      pickTemplate(templates, "promo_post", promoChannel, defaultBlockFor("promo_post")),
      null,
    ),
  );

  // Spoke MATRIX: every CORE angle × each selected channel (the book already supports the
  // full range of angles, so — unlike architectPlan — we don't ask the model to prune).
  const spokeBlock = defaultBlockFor("spoke");
  const slots = CORE_ANGLES.flatMap((angleId) =>
    spokeChannels.map((channel) => ({ angleId, channel })),
  );
  slots.forEach((slot, i) => {
    const f = getFramework(slot.angleId);
    nodes.push(
      emptyNode(
        "spoke",
        slot.channel,
        `${frameworkLabel(slot.angleId)} → ${slot.channel}`,
        spokeBlock,
        `Atomize the eBook "${title}" as a ${f?.label ?? slot.angleId} for ${slot.channel}${sparkHint}. ${f?.structureHint ?? ""}`.trim(),
        radialPos(i, slots.length),
        pickTemplate(templates, "spoke", slot.channel, spokeBlock),
        slot.angleId,
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

// ── Email-sequence architect ────────────────────────────────────────────────
// Vertical drip layout: the trigger → email → wait chain runs straight down the
// main lane; a condition splits into a "no" continuation (straight down) and a
// "yes" branch offset to the right. Structure is deterministic; Gemini only writes
// the per-email briefs.
const SEQ_MAIN_X = 400;
const SEQ_YES_X = 780;
const SEQ_TOP_Y = 60;
const SEQ_STEP_Y = 170;

export interface SequenceArchitectInput {
  sequenceType: SequenceType;
  spark: string;
  topicLabels: string[];
  /** Pre-formatted RAG block (may be ""). */
  knowledgeContext: string;
  brandVoice?: string | null;
  audience?: string | null;
}

/** One Gemini call → a map of {email index (1-based) → enriched brief}. */
async function callSequenceArchitect(
  bp: SequenceBlueprint,
  input: SequenceArchitectInput,
): Promise<Map<number, string>> {
  const emailSteps = bp.steps.filter((s) => s.kind === "email");
  const outline = emailSteps
    .map((s, i) => {
      const fw = emailFrameworkLabel(s.framework ?? bp.defaultFramework);
      return `${i + 1}. ${s.label} [framework: ${fw}] — ${s.theme ?? ""}`.trim();
    })
    .join("\n");
  const task = renderPrompt("content.architect_sequence", {
    sequence_label: bp.label,
    scenario_brief: bp.scenarioBrief,
    spark: input.spark || "(none provided)",
    topics: input.topicLabels.length ? input.topicLabels.join(", ") : "(none)",
    knowledge_context: input.knowledgeContext || "",
    email_outline: outline,
  });
  const prompt = composePrompt({
    identity: brandVoiceSection(input.brandVoice),
    communication: WRITING_RULES,
    userProfile: audienceSection(input.audience),
    task,
  });
  const raw = await generateText(prompt);
  const j = raw ? parseFirstJson(raw) : null;
  const map = new Map<number, string>();
  if (j && typeof j === "object") {
    const arr = Array.isArray((j as Record<string, unknown>).emails)
      ? ((j as Record<string, unknown>).emails as unknown[])
      : [];
    for (const e of arr) {
      const cand = e as { index?: unknown; brief?: unknown };
      const idx = typeof cand?.index === "number" ? cand.index : NaN;
      const brief = typeof cand?.brief === "string" ? cand.brief.trim() : "";
      if (Number.isFinite(idx) && brief) map.set(idx, brief);
    }
  }
  return map;
}

/**
 * Build the email-sequence graph from a blueprint. Trigger/wait/condition nodes are
 * seeded status:"generated" (structural — nothing to LLM-fill, so the plan can reach
 * "ready"); email nodes are status:"empty" and carry the enriched brief + framework.
 * Falls back to the seeded theme briefs if Gemini is off/errors so the canvas always
 * builds.
 */
export async function architectSequence(input: SequenceArchitectInput): Promise<ArchitectGraph> {
  const bp = getSequenceBlueprint(input.sequenceType);
  if (!bp) return { nodes: [], edges: [] };

  const briefs = await callSequenceArchitect(bp, input).catch(
    () => new Map<number, string>(),
  );

  const nodes: ContentNode[] = [];
  const edges: ContentEdge[] = [];

  let mainTail: string | null = null; // last node on the pre-condition / main lane
  let conditionId: string | null = null; // the split node, once seen
  let condLabels: { yes: string; no: string } = { yes: "Yes", no: "No" };
  const branchTail: { yes: string | null; no: string | null } = { yes: null, no: null };
  let mainY = SEQ_TOP_Y; // y for the main / no lane
  let yesY = SEQ_TOP_Y; // y for the yes branch (reset when a condition appears)
  let emailIndex = 0; // 1-based email counter (matches the brief map)

  for (const step of bp.steps) {
    const branch = step.branch ?? "main";
    let x = SEQ_MAIN_X;
    let y: number;
    let pred: string | null;
    let label: string | null = null;

    if (branch === "yes") {
      x = SEQ_YES_X;
      y = yesY;
      yesY += SEQ_STEP_Y;
      pred = branchTail.yes ?? conditionId;
      if (pred === conditionId) label = condLabels.yes;
    } else if (branch === "no") {
      y = mainY;
      mainY += SEQ_STEP_Y;
      pred = branchTail.no ?? conditionId;
      if (pred === conditionId) label = condLabels.no;
    } else {
      y = mainY;
      mainY += SEQ_STEP_Y;
      pred = mainTail;
    }

    let node: ContentNode;
    if (step.kind === "trigger") {
      node = emptyNode("trigger", "standalone", step.label, "", "", { x, y }, null, null, {
        status: "generated",
        body: step.label,
      });
    } else if (step.kind === "wait") {
      node = emptyNode("wait", "standalone", step.label, "", "", { x, y }, null, null, {
        status: "generated",
        body: step.label,
        waitConfig: step.wait ?? null,
      });
    } else if (step.kind === "condition") {
      node = emptyNode("condition", "standalone", step.label, "", "", { x, y }, null, null, {
        status: "generated",
        body: step.label,
        conditionConfig: step.condition ?? null,
      });
    } else {
      emailIndex += 1;
      const fwId = step.framework ?? bp.defaultFramework;
      const seededBrief = `${step.theme ?? ""} ${bp.scenarioBrief}`.trim();
      node = emptyNode(
        "email",
        "newsletter",
        step.label,
        "full-post",
        briefs.get(emailIndex) || seededBrief,
        { x, y },
        null,
        fwId,
      );
    }
    nodes.push(node);

    if (pred) edges.push({ id: `e_${randomUUID()}`, source: pred, target: node.id, label });

    if (step.kind === "condition") {
      conditionId = node.id;
      condLabels = {
        yes: step.condition?.yesLabel ?? "Yes",
        no: step.condition?.noLabel ?? "No",
      };
      mainTail = null;
      yesY = y + SEQ_STEP_Y; // yes branch starts one row below the split
    } else if (branch === "yes") {
      branchTail.yes = node.id;
    } else if (branch === "no") {
      branchTail.no = node.id;
    } else {
      mainTail = node.id;
    }
  }

  return { nodes, edges };
}
