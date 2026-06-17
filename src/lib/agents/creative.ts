import type { Campaign } from "@/lib/types/campaign";
import { MERGE_VARS } from "@/lib/email/mergeVars";
import { renderPrompt } from "./prompts/registry";
import { generateText, generateImage } from "./gemini";
import { storeEmailImage } from "./imageStore";

/**
 * Agent 3 — Creative Director & Copywriter. Drafts performance-informed copy
 * variants and generates hero images, constrained by the campaign's strategy
 * (brand tone / audience / goal). Every prompt comes from the registry; if the
 * model is unconfigured or errors, it degrades to deterministic templated copy
 * so the composer always returns something usable.
 */
export interface CopyVariant {
  subject: string;
  body: string;
}

export interface DraftCopyInput {
  campaign: Campaign;
  brief: string;
  variantCount?: number;
  /** Human-readable prior-send performance summary, fed to the model. */
  performance?: string;
}

export interface DraftCopyResult {
  variants: CopyVariant[];
  source: "agent3" | "fallback";
}

function strategyVars(campaign: Campaign): Record<string, string> {
  const s = campaign.strategy;
  return {
    brand_tone: s?.brandTone ?? "PRODUCT_LED_CASUAL",
    target_audience: s?.targetAudience ?? "GENERAL_CONSUMERS",
    campaign_goal: s?.campaignGoal ?? "PRE_LAUNCH_WAITLIST",
    custom_tone: s?.customToneInstructions ?? "",
  };
}

export async function draftCopy(input: DraftCopyInput): Promise<DraftCopyResult> {
  const count = Math.min(Math.max(input.variantCount ?? 3, 1), 5);
  const prompt = renderPrompt("creative.draft_copy", {
    ...strategyVars(input.campaign),
    performance: input.performance ?? "No prior sends yet.",
    merge_vars: MERGE_VARS.map((v) => `{{${v}}}`).join(", "),
    brief: input.brief,
    variant_count: count,
  });

  const raw = await generateText(prompt);
  const parsed = raw ? parseVariants(raw) : null;
  if (parsed && parsed.length > 0) {
    return { variants: parsed.slice(0, count), source: "agent3" };
  }
  return { variants: fallbackVariants(input, count), source: "fallback" };
}

export interface GenerateHeroImageInput {
  campaign: Campaign;
  brief: string;
  tenantId: string;
}

export interface GenerateHeroImageResult {
  imageUrl: string | null;
  source: "agent3" | "unavailable";
  reason?: string;
}

export async function generateHeroImage(
  input: GenerateHeroImageInput,
): Promise<GenerateHeroImageResult> {
  const expandPrompt = renderPrompt("creative.image_brief", {
    brand_tone: strategyVars(input.campaign).brand_tone,
    brief: input.brief,
  });
  // Expand the brief into a richer image prompt; fall back to the raw brief.
  const imagePrompt = (await generateText(expandPrompt)) ?? input.brief;
  const img = await generateImage(imagePrompt);
  if (!img) {
    return { imageUrl: null, source: "unavailable", reason: "image_model_unavailable" };
  }
  const url = await storeEmailImage(input.tenantId, input.campaign.id, img);
  if (!url) {
    return { imageUrl: null, source: "unavailable", reason: "no_asset_bucket" };
  }
  return { imageUrl: url, source: "agent3" };
}

// ---- internals ------------------------------------------------------------

function parseVariants(raw: string): CopyVariant[] | null {
  // Extract the first {...} block (models sometimes wrap JSON in fences/prose).
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as {
      variants?: Array<{ subject?: unknown; body?: unknown }>;
    };
    const out = (obj.variants ?? [])
      .filter((v) => typeof v.subject === "string" && typeof v.body === "string")
      .map((v) => ({ subject: String(v.subject), body: String(v.body) }));
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function fallbackVariants(input: DraftCopyInput, count: number): CopyVariant[] {
  const name = input.campaign.waitlistName;
  const brief = escapeHtml(input.brief.trim() || `News from ${name}`);
  const subjects = [
    `${name}: ${truncate(input.brief, 48) || "an update for you"}`,
    `You're on the move, {{first_name}} 🚀`,
    `A quick update from ${name}`,
    `Don't miss this, {{first_name}}`,
    `${name} — what's next`,
  ];
  return Array.from({ length: count }, (_, i) => ({
    subject: subjects[i % subjects.length]!,
    body:
      `<p>Hi {{first_name}},</p>` +
      `<p>${brief}</p>` +
      `<p>You're currently <strong>#{{current_rank}}</strong> on the ${escapeHtml(
        name,
      )} waitlist. Share your link to climb: <a href="{{referral_link}}">{{referral_link}}</a></p>`,
  }));
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
