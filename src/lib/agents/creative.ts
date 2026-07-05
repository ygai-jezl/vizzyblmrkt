import { resolveProductName, type Campaign } from "@/lib/types/campaign";
import { MERGE_VARS } from "@/lib/email/mergeVars";
import { platformOrigin } from "@/lib/platform/origin";
import { languageDirective, resolveCampaignLocale } from "@/lib/i18n/locale";
import { getMessage } from "@/lib/i18n/messages";
import { renderPrompt } from "./prompts/registry";
import { generateText, generateImage, generateBlockImage } from "./gemini";
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
  /**
   * Content language (base code, e.g. "fr") to write the copy in. Defaults to the
   * launch's resolved locale (`campaign.strategy.defaultLocale` → "en"). An
   * explicit value lets a caller override per request (e.g. a per-recipient send).
   */
  locale?: string;
  /**
   * RAG grounding block (retrieved knowledge-base chunks) injected verbatim into
   * the prompt. Optional and best-effort: absent ⇒ the prompt's [[knowledge_context]]
   * renders empty and Agent 3 writes ungrounded, exactly as before.
   */
  knowledgeContext?: string;
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
  const locale = input.locale ?? resolveCampaignLocale(input.campaign);
  const prompt = renderPrompt("creative.draft_copy", {
    ...strategyVars(input.campaign),
    response_language_directive: languageDirective(locale),
    performance: input.performance ?? "No prior sends yet.",
    knowledge_context: input.knowledgeContext?.trim()
      ? input.knowledgeContext
      : "None available — write from the brief and brand tone only.",
    merge_vars: MERGE_VARS.map((v) => `{{${v}}}`).join(", "),
    brief: input.brief,
    variant_count: count,
  });

  const raw = await generateText(prompt);
  const parsed = raw ? parseVariants(raw) : null;
  if (parsed && parsed.length > 0) {
    return { variants: parsed.slice(0, count), source: "agent3" };
  }
  return { variants: fallbackVariants(input, count, locale), source: "fallback" };
}

export interface GenerateHeroImageInput {
  campaign: Campaign;
  brief: string;
  tenantId: string;
  /**
   * Absolute base URL (scheme + host) the email-asset proxy link is built from.
   * Falls back to NEXT_PUBLIC_PLATFORM_ORIGIN, then a relative path. Recipients
   * load images via `<base>/api/email-asset/<path>` (see imageStore.ts).
   */
  baseUrl?: string;
}

/** Why an image couldn't be produced — surfaced verbatim to the operator. */
export type HeroImageFailure =
  | "image_model_unavailable" // Imagen unconfigured or errored
  | "no_asset_bucket" // EMAIL_ASSET_BUCKET not set
  | "store_failed"; // upload to the bucket threw

export interface GenerateHeroImageResult {
  imageUrl: string | null;
  source: "agent3" | "unavailable";
  reason?: HeroImageFailure;
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
  const stored = await storeEmailImage(input.tenantId, input.campaign.id, img);
  if (!stored.ok) {
    return { imageUrl: null, source: "unavailable", reason: stored.reason };
  }
  const base = (input.baseUrl || platformOrigin()).replace(/\/+$/, "");
  return { imageUrl: `${base}/api/email-asset/${stored.path}`, source: "agent3" };
}

export interface GenerateBlockImageInput {
  tenantId: string;
  /** The storage path segment (workspaceId) — served publicly via /api/email-asset. */
  ownerId: string;
  brief: string;
  subject?: string;
  copyExcerpt?: string;
  /** Pre-assembled on-brand context (see brandContext.ts). */
  brandContext: string;
  knowledgeContext?: string;
  baseUrl?: string;
}

export interface GenerateBlockImageResult {
  imageUrl: string | null;
  source: "agent3" | "unavailable";
  reason?: HeroImageFailure;
}

/**
 * On-brand image for an email LAYOUT block (Nano Banana). Two-stage: compose a brand-
 * grounded image prompt, then render + store it under the workspace's private path and
 * return the public proxy URL. Workspace-scoped (no Campaign) — the brand context is
 * assembled by the caller from the workspace + tenant Brand Kit + the layout palette.
 */
export async function generateEmailBlockImage(
  input: GenerateBlockImageInput,
): Promise<GenerateBlockImageResult> {
  const expandPrompt = renderPrompt("content.email_image_brief", {
    brief: input.brief,
    subject: input.subject || "(none)",
    copy_excerpt: input.copyExcerpt?.slice(0, 800) || "(none)",
    brand_context: input.brandContext,
    knowledge_context: input.knowledgeContext ?? "",
  });
  const imagePrompt = (await generateText(expandPrompt)) ?? input.brief;
  const img = await generateBlockImage(imagePrompt);
  if (!img) return { imageUrl: null, source: "unavailable", reason: "image_model_unavailable" };
  const stored = await storeEmailImage(input.tenantId, input.ownerId, img);
  if (!stored.ok) return { imageUrl: null, source: "unavailable", reason: stored.reason };
  const base = (input.baseUrl || platformOrigin()).replace(/\/+$/, "");
  return { imageUrl: `${base}/api/email-asset/${stored.path}`, source: "agent3" };
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

/**
 * Deterministic copy used when the model is unavailable. Strings come from the
 * locale message catalog (English base; localizes per-locale as translations are
 * added) so a non-English launch isn't silently shipped English connective copy.
 * The operator's own `brief` is passed through verbatim (already in their language)
 * and `{{merge_tokens}}` survive untouched for the send pipeline.
 */
function fallbackVariants(input: DraftCopyInput, count: number, locale: string): CopyVariant[] {
  // Name the product in copy, not the (possibly CTA-style) <h1> headline. The
  // model path uses the {{waitlist_name}} token, which already resolves the same.
  const name = resolveProductName(input.campaign);
  const briefHtml = escapeHtml(
    input.brief.trim() || getMessage(locale, "email.fallback.body.newsFrom", { name }),
  );
  const subjects = [
    getMessage(locale, "email.fallback.subject.update", {
      name,
      brief: truncate(input.brief, 48) || getMessage(locale, "email.fallback.subject.default"),
    }),
    getMessage(locale, "email.fallback.subject.climbing"),
    getMessage(locale, "email.fallback.subject.quickUpdate", { name }),
    getMessage(locale, "email.fallback.subject.dontMiss"),
    getMessage(locale, "email.fallback.subject.whatsNext", { name }),
  ];
  const greeting = getMessage(locale, "email.fallback.body.greeting");
  const rankLine = getMessage(locale, "email.fallback.body.rankLine", { name: escapeHtml(name) });
  return Array.from({ length: count }, (_, i) => ({
    subject: subjects[i % subjects.length]!,
    body: `<p>${greeting}</p><p>${briefHtml}</p><p>${rankLine}</p>`,
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
