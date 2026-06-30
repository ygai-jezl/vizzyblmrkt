import { renderPrompt } from "@/lib/agents/prompts/registry";
import { composePrompt, brandVoiceSection, audienceSection } from "@/lib/agents/prompts/compose";
import { generateText, parseFirstJson } from "@/lib/agents/gemini";
import { BLOCK_TYPES, isBlockType, getBlockType } from "@/lib/content/blocks";
import { channelBlueprint } from "@/lib/content/channels";
import { transformFor } from "@/lib/content/transformationMatrix";
import { WRITING_RULES } from "@/lib/content/writingRules";
import { reconcilePlaceholders } from "@/lib/content/placeholders";
import type { TemplatePlaceholder } from "@/lib/types/template";

/**
 * Transformation-Matrix Deconstructor: turn a hub/Pillar template into channel-
 * native spoke variants. For a hub/full-post: segment into constituent blocks; for
 * a single block: transform it directly. Each (block × target channel) → one spoke
 * via the matrix. Fan-out is bounded (MAX_BLOCKS × caller-capped channels).
 */
const MAX_BLOCKS = 4;

export interface DeconstructSource {
  body: string;
  blockType?: string | null;
  tier?: string | null;
  sourceSnapshot?: string | null;
}
export interface DeconstructInput {
  template: DeconstructSource;
  channels: string[];
  brandVoice?: string | null;
  audience?: string | null;
}
export interface SpokeDraft {
  title: string;
  body: string;
  placeholders: TemplatePlaceholder[];
  blockType: string;
  channel: string;
  format: string;
  moduleSize: "small" | "medium" | "large";
  source: "agent3";
}

interface Block {
  blockType: string;
  excerpt: string;
}

async function segment(content: string): Promise<Block[]> {
  const task = renderPrompt("content.segment", {
    content,
    block_ids: BLOCK_TYPES.map((b) => b.id).join(", "),
    max_blocks: String(MAX_BLOCKS),
  });
  const raw = await generateText(task);
  const j = raw ? parseFirstJson(raw) : null;
  const arr = j && typeof j === "object" ? (j as Record<string, unknown>).blocks : null;
  if (!Array.isArray(arr)) return [];
  const out: Block[] = [];
  for (const it of arr) {
    if (out.length >= MAX_BLOCKS) break;
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const blockType = typeof o.blockType === "string" && isBlockType(o.blockType) ? o.blockType : "full-post";
    const excerpt = typeof o.excerpt === "string" ? o.excerpt.slice(0, 4000) : "";
    if (excerpt) out.push({ blockType, excerpt });
  }
  return out;
}

async function transformOne(
  block: Block,
  channel: string,
  input: DeconstructInput,
): Promise<SpokeDraft | null> {
  const t = transformFor(block.blockType, channel);
  const task = renderPrompt("content.transform", {
    target_format: t.format,
    target_channel: channel,
    transform_hint: t.hint,
    channel_blueprint: channelBlueprint(channel),
    source: block.excerpt,
  });
  const prompt = composePrompt({
    identity: brandVoiceSection(input.brandVoice),
    communication: WRITING_RULES,
    userProfile: audienceSection(input.audience),
    task,
  });
  const raw = await generateText(prompt);
  const j = raw ? parseFirstJson(raw) : null;
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const title = typeof o.title === "string" && o.title.trim() ? o.title.trim().slice(0, 200) : null;
  const body = typeof o.body === "string" && o.body.trim() ? o.body.trim().slice(0, 10000) : null;
  if (!title || !body) return null;
  const ph = Array.isArray(o.placeholders) ? (o.placeholders as Partial<TemplatePlaceholder>[]) : [];
  return {
    title,
    body,
    placeholders: reconcilePlaceholders(body, ph),
    blockType: block.blockType,
    channel,
    format: t.format,
    moduleSize: getBlockType(block.blockType)?.defaultSize ?? "small",
    source: "agent3",
  };
}

export async function deconstructTemplate(input: DeconstructInput): Promise<SpokeDraft[]> {
  const content = (input.template.sourceSnapshot || input.template.body || "").slice(0, 12000);
  if (!content || input.channels.length === 0) return [];

  const isHub = input.template.tier === "hub" || input.template.blockType === "full-post";
  let blocks: Block[];
  if (isHub) {
    const segmented = await segment(content);
    blocks = segmented.length
      ? segmented.slice(0, MAX_BLOCKS)
      : [{ blockType: input.template.blockType ?? "full-post", excerpt: content }];
  } else {
    blocks = [{ blockType: input.template.blockType ?? "hook", excerpt: content }];
  }

  const jobs: Promise<SpokeDraft | null>[] = [];
  for (const b of blocks) {
    for (const ch of input.channels) jobs.push(transformOne(b, ch, input));
  }
  const results = await Promise.all(jobs);
  return results.filter((r): r is SpokeDraft => r !== null);
}
