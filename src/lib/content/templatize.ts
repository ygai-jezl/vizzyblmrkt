import { renderPrompt } from "@/lib/agents/prompts/registry";
import { composePrompt } from "@/lib/agents/prompts/compose";
import { generateText, generateTextWithImage, parseFirstJson } from "@/lib/agents/gemini";
import {
  isTemplateCategory,
  DEFAULT_TEMPLATE_CATEGORY,
  SEED_TEMPLATE_GROUPS,
} from "@/lib/content/templateCategories";
import { CONTENT_FRAMEWORKS, getFramework, isFramework, DEFAULT_FRAMEWORK } from "@/lib/content/frameworks";
import {
  BLOCK_TYPES,
  getBlockType,
  isBlockType,
  isModuleSize,
  DEFAULT_BLOCK_TYPE,
} from "@/lib/content/blocks";
import { CHANNELS, isChannel, channelBlueprint, DEFAULT_CHANNEL } from "@/lib/content/channels";
import { WRITING_RULES } from "@/lib/content/writingRules";
import { reconcilePlaceholders, orphanPlaceholders, bodyTokens } from "@/lib/content/placeholders";
import { safeFetch, readTextCapped } from "@/lib/security/ssrf";
import type { TemplatePlaceholder } from "@/lib/types/template";

/**
 * Modular templatize engine (Agent 3 / Gemini, inline). Two-stage + validate:
 *   1. analyze   → classify framework / blockType / size / channel / tier / category / group
 *   2. templatize→ framework-guided {{token}} skeleton + structured placeholders (obeying the
 *                  modular writing rules; prompt composed dynamically)
 *   3. validate  → reconcile body↔placeholders, flag warnings, ONE repair pass if broken; else fallback.
 */

const MAX_SAMPLE_CHARS = 12000;
const MAX_SNAPSHOT_CHARS = 8000;
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

export type Granularity = "coarse" | "normal" | "fine";

export interface TemplatizeInput {
  text?: string | null;
  url?: string | null;
  fetchable?: boolean | null;
  screenshot?: { base64: string; mimeType: string } | null;
  knownGroups: string[];
  /** Overrides (reframe). */
  framework?: string | null;
  blockType?: string | null;
  channel?: string | null;
  granularity?: Granularity | null;
  /** Identity / UserProfile prompt context. */
  brandVoice?: string | null;
  audience?: string | null;
}

export interface TemplatizeResult {
  title: string;
  body: string;
  placeholders: TemplatePlaceholder[];
  framework: string;
  blockType: string;
  moduleSize: "small" | "medium" | "large";
  channel: string;
  format: string;
  tier: "hub" | "spoke" | "standalone";
  category: string;
  group: string;
  confidence: number;
  warnings: string[];
  sourceSnapshot: string | null;
  source: "agent3" | "fallback";
}

// ── source assembly ──────────────────────────────────────────────────────────

async function fetchReadableText(url: string): Promise<string | null> {
  try {
    const res = await safeFetch(
      url,
      { headers: { "User-Agent": "Vizzybl-Templatize/1.0", Accept: "text/html,text/plain" } },
      { timeoutMs: FETCH_TIMEOUT_MS, maxRedirects: 4 },
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.includes("text/html") && !ct.includes("text/plain")) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const html = await readTextCapped(res, MAX_FETCH_BYTES);
    return htmlToText(html).slice(0, MAX_SAMPLE_CHARS) || null;
  } catch {
    return null;
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function deriveTitle(text: string): string {
  const first = text.split(/\n/).map((l) => l.trim()).find(Boolean) ?? "Captured idea";
  return first.slice(0, 80);
}

async function assembleSample(input: TemplatizeInput): Promise<string> {
  const parts: string[] = [];
  if (input.text?.trim()) parts.push(input.text.trim());
  if (input.url && input.fetchable) {
    const fetched = await fetchReadableText(input.url);
    if (fetched) parts.push(fetched);
  } else if (input.url) {
    parts.push(`(Reference link: ${input.url})`);
  }
  return parts.join("\n\n").slice(0, MAX_SAMPLE_CHARS).trim();
}

// ── stage 1: analyze ─────────────────────────────────────────────────────────

interface Analysis {
  framework: string;
  blockType: string;
  moduleSize: "small" | "medium" | "large";
  channel: string;
  tier: "hub" | "spoke" | "standalone";
  category: string;
  group: string;
}

function analysisDefaults(): Analysis {
  return {
    framework: DEFAULT_FRAMEWORK,
    blockType: DEFAULT_BLOCK_TYPE,
    moduleSize: getBlockType(DEFAULT_BLOCK_TYPE)?.defaultSize ?? "medium",
    channel: DEFAULT_CHANNEL,
    tier: "standalone",
    category: DEFAULT_TEMPLATE_CATEGORY,
    group: "Uncategorised",
  };
}

/** Constrain the model-suggested group to a safe, short label. */
function sanitizeGroup(raw: unknown): string {
  if (typeof raw !== "string") return "Uncategorised";
  const g = raw
    .replace(/[^\p{L}\p{N} /&_-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return g || "Uncategorised";
}

function coerceAnalysis(o: Record<string, unknown>): Analysis {
  const framework = typeof o.framework === "string" && isFramework(o.framework) ? o.framework : DEFAULT_FRAMEWORK;
  const blockType = typeof o.blockType === "string" && isBlockType(o.blockType) ? o.blockType : DEFAULT_BLOCK_TYPE;
  const moduleSize =
    typeof o.moduleSize === "string" && isModuleSize(o.moduleSize)
      ? o.moduleSize
      : getBlockType(blockType)?.defaultSize ?? "medium";
  const channel = typeof o.channel === "string" && isChannel(o.channel) ? o.channel : DEFAULT_CHANNEL;
  const tier =
    o.tier === "hub" || o.tier === "spoke" || o.tier === "standalone" ? o.tier : "standalone";
  const category =
    typeof o.category === "string" && isTemplateCategory(o.category) ? o.category : DEFAULT_TEMPLATE_CATEGORY;
  const group = sanitizeGroup(o.group);
  return { framework, blockType, moduleSize, channel, tier, category, group };
}

async function analyze(
  sample: string,
  screenshot: TemplatizeInput["screenshot"],
  knownGroups: string[],
): Promise<Analysis | null> {
  const task = renderPrompt("content.analyze", {
    content_sample: sample || "(read the attached screenshot)",
    framework_ids: CONTENT_FRAMEWORKS.map((f) => f.id).join(", "),
    block_ids: BLOCK_TYPES.map((b) => b.id).join(", "),
    channel_ids: CHANNELS.map((c) => c.id).join(", "),
    known_groups: (knownGroups.length ? knownGroups : SEED_TEMPLATE_GROUPS).join(", "),
  });
  const raw = screenshot
    ? await generateTextWithImage(task, screenshot.base64, screenshot.mimeType)
    : await generateText(task);
  const j = raw ? parseFirstJson(raw) : null;
  if (!j || typeof j !== "object") return null;
  return coerceAnalysis(j as Record<string, unknown>);
}

// ── stage 2: templatize ──────────────────────────────────────────────────────

function granularityDirective(g?: Granularity | null): string {
  if (g === "coarse") return "Granularity: use FEWER, broader tokens (whole phrases or sentences).";
  if (g === "fine") return "Granularity: use MORE, granular tokens (individual words / short phrases).";
  return "";
}

function frameworkExamplesText(framework: string): string {
  const f = getFramework(framework);
  if (!f) return "";
  return f.examples.map((e) => `INPUT:\n${e.input}\nTEMPLATE:\n${e.template}`).join("\n\n");
}

interface Skeleton {
  title: string;
  body: string;
  placeholders: Partial<TemplatePlaceholder>[];
}

function coerceSkeleton(j: unknown): Skeleton | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const title = typeof o.title === "string" && o.title.trim() ? o.title.trim().slice(0, 200) : null;
  const body = typeof o.body === "string" && o.body.trim() ? o.body.trim().slice(0, 10000) : null;
  if (!title || !body) return null;
  const placeholders = Array.isArray(o.placeholders)
    ? (o.placeholders as Partial<TemplatePlaceholder>[])
    : [];
  return { title, body, placeholders };
}

async function templatizeStage(
  sample: string,
  input: TemplatizeInput,
  analysis: Analysis,
): Promise<Skeleton | null> {
  const f = getFramework(analysis.framework);
  const task = renderPrompt("content.templatize", {
    framework_label: f?.label ?? analysis.framework,
    framework_guidance: f?.structureHint ?? "",
    framework_examples: frameworkExamplesText(analysis.framework),
    granularity_directive: granularityDirective(input.granularity),
    content_sample: sample || "(read the attached screenshot)",
  });
  const prompt = composePrompt({
    identity: input.brandVoice ? `Brand voice: ${input.brandVoice}` : "",
    communication: WRITING_RULES,
    userProfile: input.audience ? `Audience / reader: ${input.audience}` : "",
    constraints:
      analysis.channel && analysis.channel !== "standalone"
        ? `Target channel structure: ${channelBlueprint(analysis.channel)}`
        : "",
    task,
  });
  const raw = input.screenshot
    ? await generateTextWithImage(prompt, input.screenshot.base64, input.screenshot.mimeType)
    : await generateText(prompt);
  return coerceSkeleton(raw ? parseFirstJson(raw) : null);
}

// ── stage 3: validate + repair ───────────────────────────────────────────────

function validate(body: string, framework: string): string[] {
  const w: string[] = [];
  if (bodyTokens(body).length === 0) w.push("no_placeholders");
  if (/\b(step|section)\s+\d|as shown above|as mentioned above|in the next step/i.test(body)) {
    w.push("linear_language");
  }
  if (framework === "listicle" && !/(^|\n)\s*([-*]|\d+[.)])/.test(body)) w.push("missing_list");
  return w;
}

async function repair(body: string, problems: string[]): Promise<Skeleton | null> {
  const task = renderPrompt("content.templatize_repair", { problems: problems.join("; "), body });
  const prompt = composePrompt({ communication: WRITING_RULES, task });
  const raw = await generateText(prompt);
  return coerceSkeleton(raw ? parseFirstJson(raw) : null);
}

// ── format mapping ───────────────────────────────────────────────────────────

function formatFor(channel: string, tier: string, moduleSize: string): string {
  switch (channel) {
    case "blog":
      return tier === "hub" ? "blog-pillar" : "blog-section";
    case "newsletter":
      return "newsletter-section";
    case "linkedin":
      return "linkedin-post";
    case "x":
      return "x-post";
    case "instagram":
      return "instagram-caption";
    default:
      return moduleSize === "large" ? "long-form" : "short-form";
  }
}

// ── entry point ──────────────────────────────────────────────────────────────

function buildFallback(sample: string, analysis: Analysis, snapshot: string | null): TemplatizeResult {
  const body = (sample || "(captured from screenshot)").slice(0, 10000);
  return {
    title: deriveTitle(sample || "Captured idea"),
    body,
    placeholders: reconcilePlaceholders(body, []),
    framework: analysis.framework,
    blockType: analysis.blockType,
    moduleSize: analysis.moduleSize,
    channel: analysis.channel,
    format: formatFor(analysis.channel, analysis.tier, analysis.moduleSize),
    tier: analysis.tier,
    category: analysis.category,
    group: analysis.group,
    confidence: 0.2,
    warnings: ["fallback"],
    sourceSnapshot: snapshot,
    source: "fallback",
  };
}

export async function templatizeIdea(input: TemplatizeInput): Promise<TemplatizeResult> {
  const sample = await assembleSample(input);
  const hasImage = Boolean(input.screenshot?.base64);
  const snapshot = sample ? sample.slice(0, MAX_SNAPSHOT_CHARS) : null;

  if (!sample && !hasImage) {
    return buildFallback("", analysisDefaults(), null);
  }

  // Stage 1 — analyze (with overrides).
  const analysis = (await analyze(sample, input.screenshot, input.knownGroups)) ?? analysisDefaults();
  if (input.framework && isFramework(input.framework)) analysis.framework = input.framework;
  if (input.blockType && isBlockType(input.blockType)) {
    analysis.blockType = input.blockType;
    // A new role implies a new default size (no separate size override exists).
    analysis.moduleSize = getBlockType(input.blockType)?.defaultSize ?? analysis.moduleSize;
  }
  if (input.channel && isChannel(input.channel)) analysis.channel = input.channel;

  // Stage 2 — templatize.
  let skeleton = await templatizeStage(sample, input, analysis);
  if (!skeleton) return buildFallback(sample, analysis, snapshot);

  // Stage 3 — validate + one repair pass if there are no tokens at all.
  let warnings = validate(skeleton.body, analysis.framework);
  if (warnings.includes("no_placeholders")) {
    const repaired = await repair(skeleton.body, ["no placeholder tokens were created"]);
    if (repaired && bodyTokens(repaired.body).length > 0) {
      skeleton = repaired;
      warnings = validate(skeleton.body, analysis.framework);
    }
  }
  const orphans = orphanPlaceholders(skeleton.body, skeleton.placeholders);
  if (orphans.length) warnings.push("orphan_placeholders");
  const placeholders = reconcilePlaceholders(skeleton.body, skeleton.placeholders);
  const uniqueWarnings = [...new Set(warnings)];
  const confidence = Math.max(0.1, 1 - 0.25 * uniqueWarnings.length);

  return {
    title: skeleton.title,
    body: skeleton.body,
    placeholders,
    framework: analysis.framework,
    blockType: analysis.blockType,
    moduleSize: analysis.moduleSize,
    channel: analysis.channel,
    format: formatFor(analysis.channel, analysis.tier, analysis.moduleSize),
    tier: analysis.tier,
    category: analysis.category,
    group: analysis.group,
    confidence,
    warnings: uniqueWarnings,
    sourceSnapshot: snapshot,
    source: "agent3",
  };
}
