import { resolveProductName, type Campaign } from "@/lib/types/campaign";
import { MERGE_VARS } from "@/lib/email/mergeVars";
import { platformOrigin } from "@/lib/platform/origin";
import { languageDirective, resolveCampaignLocale } from "@/lib/i18n/locale";
import { getMessage } from "@/lib/i18n/messages";
import { renderPrompt } from "./prompts/registry";
import { brandVoiceSection } from "./prompts/compose";
import { generateText, generateImage, generateBlockImage, generateEbookImage } from "./gemini";
import { storeEmailImage } from "./imageStore";
import { storeWorkspaceImage, readWorkspaceAsset, deleteWorkspaceAsset } from "@/lib/workspace/assetStore";
import { SOCIAL_ASPECT_TO_GEMINI, socialImageStyle, type SocialAspect, type SocialImageStyle } from "@/lib/content/create/socialImage";
import {
  EBOOK_ASPECT_TO_GEMINI,
  EBOOK_IMAGE_INLINE_MAX_BYTES,
  ebookImageStyle,
} from "@/lib/content/create/ebook";
import type { EbookAspect } from "@/lib/types/contentPlan";
import { recordImageAsset } from "@/lib/admin/brandKit";
import { retrieveExemplarImages, STYLE_REF_DIRECTIVE } from "@/lib/content/create/exemplarImages";
import { isBestOfNEnabled, bestOfNCount } from "@/lib/content/create/brandStyleLoop";
import { generateBestOfN } from "@/lib/content/create/bestOfN";
import type { GeneratedImage } from "./gemini";
import type { ImageAsset } from "@/lib/types/imageAsset";
import type { Region } from "@/lib/types/tenant";
import type { TenantContext } from "@/lib/tenant/types";

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
  /**
   * The tenant-global authored brand voice (already resolved to plaintext by
   * `resolveBrandVoiceText`). Fenced as untrusted before it enters the prompt. Optional:
   * absent ⇒ the `[[brand_voice]]` placeholder renders empty and copy grounds on the
   * campaign's tone enum only, exactly as before.
   */
  brandVoice?: string | null;
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
    brand_voice: brandVoiceSection(input.brandVoice),
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
  /** Resolved tenant-global brand voice (fenced as untrusted); absent ⇒ tone enum only. */
  brandVoice?: string | null;
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
    brand_voice: brandVoiceSection(input.brandVoice),
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

export interface GenerateSocialImageInput {
  tenantId: string;
  workspaceId: string;
  /** Destination channel (linkedin/x/instagram) — shapes composition + aspect. */
  channel: string;
  brief: string;
  /** The post copy (plain text) so the image supports the message. */
  copyExcerpt?: string;
  aspect: SocialAspect;
  style: SocialImageStyle;
  /** Pre-assembled on-brand context (see brandContext.ts). */
  brandContext: string;
  knowledgeContext?: string;
  /**
   * Data-residency region. When present, the generated image is registered in the
   * Brand Kit image library (best-effort — never blocks the generation). Absent ⇒
   * no registry write (keeps existing callers/tests unaffected).
   */
  region?: Region;
  /** Optional source linkage for the Brand Kit registry (best-effort). */
  planId?: string;
  nodeId?: string;
  /**
   * Brand-style loop override (default true = automatic apply). When false, skip the
   * learned style reference images for THIS generation (the "Use learned brand style"
   * toggle off). The learned text directive is suppressed separately by the caller,
   * which passes `learnedImageStyle: null` to assembleBrandContext.
   */
  useBrandStyle?: boolean;
}

export interface GenerateSocialImageResult {
  /** Workspace-asset FILENAME (served via the authenticated workspace-asset proxy). */
  imageAssetRef: string | null;
  /** The expanded prompt actually rendered (capped for the node schema). */
  imagePrompt: string | null;
  source: "agent3" | "unavailable";
  reason?: HeroImageFailure | "bad_type" | "too_large";
}

/**
 * On-brand image for a SOCIAL POST node (Nano Banana). Two-stage: compose a brand-
 * grounded image prompt, then render it at the channel's aspect ratio and store it under
 * the workspace's PRIVATE asset path (served by the authenticated workspace-asset proxy —
 * the image isn't published yet). Degrades to a null ref (never throws) exactly like the
 * email/carousel paths.
 */
export async function generateSocialPostImage(
  input: GenerateSocialImageInput,
): Promise<GenerateSocialImageResult> {
  const style = socialImageStyle(input.style);
  const expandPrompt = renderPrompt("content.social_image_brief", {
    brief: input.brief,
    channel: input.channel,
    aspect: input.aspect,
    style_label: style.label,
    style_keywords: style.keywords,
    copy_excerpt: input.copyExcerpt?.slice(0, 800) || "(none)",
    brand_context: input.brandContext,
    knowledge_context: input.knowledgeContext ?? "",
  });
  const imagePrompt = (await generateText(expandPrompt)) ?? input.brief;

  // Brand-style loop (L2): fetch on-brand style references. When present, HYBRID-switch
  // this generation from the lite/text-only model to the FULL model so it can SEE the
  // brand look; otherwise stay on the lite path (bounds the added cost to the cases that
  // actually benefit). Gated by the flag + region + the per-generation override.
  const styleRefs =
    input.region && input.useBrandStyle !== false
      ? await retrieveExemplarImages({
          ctx: tenantCtx(input.tenantId, input.region),
          kind: "social",
          channel: input.channel,
        })
      : [];
  const produceImage = (): Promise<GeneratedImage | null> =>
    styleRefs.length > 0
      ? generateEbookImage({
          prompt: `${imagePrompt}\n\n${STYLE_REF_DIRECTIVE}`,
          aspectRatio: SOCIAL_ASPECT_TO_GEMINI[input.aspect],
          styleRefImages: styleRefs,
        })
      : generateBlockImage(imagePrompt, SOCIAL_ASPECT_TO_GEMINI[input.aspect]);
  // Best-of-N (L3): when enabled, generate several and auto-pick the most on-brand.
  const img =
    input.useBrandStyle !== false && isBestOfNEnabled()
      ? await generateBestOfN({
          n: bestOfNCount(),
          generate: produceImage,
          styleReference: input.brandContext,
          brief: input.brief,
        })
      : await produceImage();
  if (!img) {
    return { imageAssetRef: null, imagePrompt: null, source: "unavailable", reason: "image_model_unavailable" };
  }
  const stored = await storeWorkspaceImage(input.tenantId, input.workspaceId, img.bytes, img.mimeType);
  if (!stored.ok) return { imageAssetRef: null, imagePrompt: null, source: "unavailable", reason: stored.reason };
  const cappedPrompt = imagePrompt.slice(0, 1000);
  // Register in the Brand Kit image library (best-effort — a Firestore blip must
  // never fail an already-stored image). Only when the caller supplies its region.
  if (input.region) {
    await recordImageAsset(
      { tenantId: input.tenantId, region: input.region },
      {
        workspaceId: input.workspaceId,
        filename: stored.filename,
        mimeType: img.mimeType,
        kind: "social",
        prompt: cappedPrompt,
        brief: input.brief.slice(0, 1000),
        aspect: input.aspect,
        style: input.style,
        channel: input.channel,
        source: { planId: input.planId ?? null, nodeId: input.nodeId ?? null },
        parentAssetId: null,
        byteSize: img.bytes.length,
      },
    ).catch((e) => console.warn("[brandKit] record social image failed:", e));
  }
  // Cap the stored prompt to the ContentNode.imagePrompt schema limit (1000).
  return { imageAssetRef: stored.filename, imagePrompt: cappedPrompt, source: "agent3" };
}

export interface GenerateEbookImageInput {
  tenantId: string;
  workspaceId: string;
  /** For CREATE: the art brief. For EDIT: the change instruction ("make the background navy"). */
  brief: string;
  aspect: EbookAspect;
  /** Style preset id (see EBOOK_IMAGE_STYLES). */
  style: string;
  /** Pre-assembled on-brand context (see brandContext.ts). */
  brandContext: string;
  knowledgeContext?: string;
  /** Chapter text so a fresh illustration supports the page. */
  copyExcerpt?: string;
  /** ITERATIVE EDIT: the existing image asset filename to feed back in (image-in→image-out). */
  priorImageRef?: string | null;
  /**
   * Data-residency region. When present, the generated image is registered in the
   * Brand Kit image library (best-effort). Absent ⇒ no registry write.
   */
  region?: Region;
  /** Optional source linkage for the Brand Kit registry (best-effort). */
  planId?: string;
  chapterId?: string;
  /** Brand-style loop override (default true). When false, skip style references. */
  useBrandStyle?: boolean;
  /**
   * Best-of-N (L3) is expensive (N× gen + N× judge), so it runs on HERO surfaces only.
   * The route sets this true for the eBook COVER; chapter/slot illustrations stay single-shot
   * even when the best-of-N flag is on, so a long eBook doesn't multiply its whole build cost.
   */
  heroSurface?: boolean;
}

export interface GenerateEbookImageResult {
  imageAssetRef: string | null;
  imagePrompt: string | null;
  source: "gemini" | "unavailable";
  /** The Brand Kit registry row id created for this image (when input.region is set),
   *  so a caller that later discards the image can delete the dangling row. */
  imageAssetId?: string | null;
  reason?:
    | "image_model_unavailable"
    | "bad_type"
    | "too_large"
    | "no_asset_bucket"
    | "store_failed"
    | "prior_too_large"
    | "prior_unreadable";
}

/**
 * On-brand image for an eBook slot/cover using the edit-capable gemini-3.1-flash-image.
 * CREATE (no priorImageRef): expand the brief into a brand-grounded art-director prompt, then
 * render at the chosen aspect. EDIT (priorImageRef set): read the existing image (clamped to the
 * 7 MB inline limit), feed it back with the change instruction (kept concise so the model edits
 * rather than regenerates). Stores to the workspace's PRIVATE asset path; degrades to a null ref
 * (never throws).
 */
export async function generateEbookSlotImage(
  input: GenerateEbookImageInput,
): Promise<GenerateEbookImageResult> {
  const style = ebookImageStyle(input.style);

  // Iterative edit: load the prior image (clamped) as the model input. If it can't be read,
  // FAIL — never silently regenerate from the terse instruction (that would overwrite the
  // operator's existing image with an unrelated one on a transient read blip).
  let inputImages: { base64: string; mimeType: string }[] = [];
  if (input.priorImageRef) {
    const prior = await readWorkspaceAsset(input.tenantId, input.workspaceId, input.priorImageRef).catch(
      () => null,
    );
    if (!prior) {
      return { imageAssetRef: null, imagePrompt: null, source: "unavailable", reason: "prior_unreadable" };
    }
    if (prior.bytes.length > EBOOK_IMAGE_INLINE_MAX_BYTES) {
      return { imageAssetRef: null, imagePrompt: null, source: "unavailable", reason: "prior_too_large" };
    }
    inputImages = [{ base64: prior.bytes.toString("base64"), mimeType: prior.contentType }];
  }
  const isEdit = inputImages.length > 0;

  // EDIT: pass the concise instruction so the model edits the input. CREATE: expand a full
  // brand-grounded art-director prompt.
  const imagePrompt = isEdit
    ? input.brief
    : (await generateText(
        renderPrompt("content.ebook_image_brief", {
          brief: input.brief,
          aspect: input.aspect,
          style_label: style.label,
          style_keywords: style.keywords,
          copy_excerpt: input.copyExcerpt?.slice(0, 800) || "(none)",
          brand_context: input.brandContext,
          knowledge_context: input.knowledgeContext ?? "",
        }),
      )) ?? input.brief;

  // Brand-style loop (L2): on CREATE only (never during an edit — that would confuse the
  // model with the prior image), attach on-brand style references so a fresh illustration
  // matches the learned look. Gated by flag + region + the per-generation override.
  const styleRefs =
    !isEdit && input.region && input.useBrandStyle !== false
      ? await retrieveExemplarImages({
          ctx: tenantCtx(input.tenantId, input.region),
          kind: "ebook",
        })
      : [];

  const produceImage = (): Promise<GeneratedImage | null> =>
    generateEbookImage({
      prompt: styleRefs.length > 0 ? `${imagePrompt}\n\n${STYLE_REF_DIRECTIVE}` : imagePrompt,
      aspectRatio: EBOOK_ASPECT_TO_GEMINI[input.aspect],
      inputImages,
      styleRefImages: styleRefs,
    });
  // Best-of-N (L3) on CREATE + HERO surface only (the eBook cover) — never on an edit, and
  // never on every chapter illustration (that would multiply a long eBook's build cost).
  const img =
    !isEdit && input.heroSurface === true && input.useBrandStyle !== false && isBestOfNEnabled()
      ? await generateBestOfN({
          n: bestOfNCount(),
          generate: produceImage,
          styleReference: input.brandContext,
          brief: input.brief,
        })
      : await produceImage();
  if (!img) {
    return { imageAssetRef: null, imagePrompt: null, source: "unavailable", reason: "image_model_unavailable" };
  }
  const stored = await storeWorkspaceImage(input.tenantId, input.workspaceId, img.bytes, img.mimeType);
  if (!stored.ok) return { imageAssetRef: null, imagePrompt: null, source: "unavailable", reason: stored.reason };
  const cappedPrompt = imagePrompt.slice(0, 1000);
  // Register in the Brand Kit image library (best-effort). eBook-internal edits key
  // by filename (not assetId), so lineage (parentAssetId) is only resolvable in the
  // Brand Kit Customise flow — left null here. Return the created row id so the route
  // can delete it if the image is later discarded (not applied to the draft).
  let recordedAssetId: string | null = null;
  if (input.region) {
    recordedAssetId = await recordImageAsset(
      { tenantId: input.tenantId, region: input.region },
      {
        workspaceId: input.workspaceId,
        filename: stored.filename,
        mimeType: img.mimeType,
        kind: "ebook",
        prompt: cappedPrompt,
        brief: input.brief.slice(0, 1000),
        aspect: input.aspect,
        style: input.style,
        source: { planId: input.planId ?? null, chapterId: input.chapterId ?? null },
        parentAssetId: null,
        byteSize: img.bytes.length,
      },
    )
      .then((a) => a.id)
      .catch((e) => {
        console.warn("[brandKit] record ebook image failed:", e);
        return null;
      });
  }
  return {
    imageAssetRef: stored.filename,
    imagePrompt: cappedPrompt,
    source: "gemini",
    imageAssetId: recordedAssetId,
  };
}

/** Why a Customise (image-to-image edit) couldn't be produced — surfaced to the operator. */
export type CustomizeImageFailure =
  | "image_model_unavailable"
  | "bad_type"
  | "too_large"
  | "no_asset_bucket"
  | "store_failed"
  | "prior_too_large"
  | "prior_unreadable"
  | "record_failed";

export interface CustomizeImageInput {
  tenantId: string;
  region: Region;
  /** The source asset to iterate on (its bytes are read from ITS workspace). */
  source: ImageAsset;
  /** The concise change instruction ("make the background navy"). */
  instruction: string;
}

export interface CustomizeImageResult {
  asset: ImageAsset | null;
  reason?: CustomizeImageFailure;
}

/**
 * Brand Kit "Customise": generate a NEW image from an existing one via the edit-capable
 * Nano Banana 2 FULL model (image-in→image-out). Non-destructive — the source asset is
 * never mutated; the result is stored as a fresh workspace asset under the SAME workspace
 * and recorded as a new ImageAsset with `parentAssetId` = the source. Reuses the same
 * inline-size clamp discipline as generateEbookSlotImage: a source that can't be read (or
 * is too large to inline) FAILS rather than silently regenerating from the instruction.
 */
export async function customizeImageAsset(
  input: CustomizeImageInput,
): Promise<CustomizeImageResult> {
  const { tenantId, region, source, instruction } = input;

  // 1. Load the source bytes from ITS workspace (clamped to the inline edit limit).
  const prior = await readWorkspaceAsset(tenantId, source.workspaceId, source.filename).catch(
    () => null,
  );
  if (!prior) return { asset: null, reason: "prior_unreadable" };
  if (prior.bytes.length > EBOOK_IMAGE_INLINE_MAX_BYTES) {
    return { asset: null, reason: "prior_too_large" };
  }

  // 2. Best-effort aspect mapping (the FULL model preserves the input image's aspect
  //    anyway; this only nudges the target when the source aspect is known).
  const aspectRatio =
    (source.aspect && (EBOOK_ASPECT_TO_GEMINI as Record<string, string>)[source.aspect]) ??
    (source.aspect && (SOCIAL_ASPECT_TO_GEMINI as Record<string, string>)[source.aspect]) ??
    "1:1";

  // 3. Edit: image-in → image-out.
  const img = await generateEbookImage({
    prompt: instruction,
    aspectRatio,
    inputImages: [{ base64: prior.bytes.toString("base64"), mimeType: prior.contentType }],
  });
  if (!img) return { asset: null, reason: "image_model_unavailable" };

  // 4. Store as a NEW asset under the SAME workspaceId (auth proxy works; non-destructive).
  const stored = await storeWorkspaceImage(tenantId, source.workspaceId, img.bytes, img.mimeType);
  if (!stored.ok) return { asset: null, reason: stored.reason };

  // 5. Record with lineage. If the registry write fails, delete the just-stored orphan
  //    bytes and surface a mapped reason — never leak an object or throw a raw 500.
  try {
    const asset = await recordImageAsset(
      { tenantId, region },
      {
        workspaceId: source.workspaceId,
        filename: stored.filename,
        mimeType: img.mimeType,
        kind: "customized",
        prompt: instruction.slice(0, 1000),
        brief: instruction.slice(0, 1000),
        aspect: source.aspect ?? null,
        style: source.style ?? null,
        channel: source.channel ?? null,
        source: source.source ?? null,
        parentAssetId: source.id,
        byteSize: img.bytes.length,
      },
    );
    return { asset };
  } catch (err) {
    console.warn("[brandKit] customize record failed; cleaning orphan:", err);
    await deleteWorkspaceAsset(tenantId, source.workspaceId, stored.filename).catch(() => {});
    return { asset: null, reason: "record_failed" };
  }
}

// ---- internals ------------------------------------------------------------

/** Minimal system-scoped tenant context for best-effort registry reads/writes. */
function tenantCtx(tenantId: string, region: Region): TenantContext {
  return { tenantId, region, source: "system" };
}

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
