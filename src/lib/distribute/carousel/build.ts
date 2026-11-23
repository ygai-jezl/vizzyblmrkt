import type { TenantContext } from "@/lib/tenant/types";
import { generateSlideImage, isUsageLimited, type AiUsage, type GeneratedImage, type UsageLimited } from "@/lib/agents/gemini";
import { aiUsage } from "@/lib/plans/meter";
import { storeWorkspaceImage, type StoreResult } from "@/lib/workspace/assetStore";
import { planSlides, slideImagePrompt } from "./slides";

/**
 * Carousel build pipeline: plan slides → generate an image per slide (Gemini) →
 * store each privately (reusing the workspace asset bucket + proxy). FLAG-GATED
 * OFF (`DISTRIBUTE_CAROUSEL_ENABLED`) until the Vertex image model + bucket are
 * provisioned. The image-gen + store deps are injectable so the orchestration is
 * unit-tested without real calls.
 */

export function isCarouselEnabled(): boolean {
  return process.env.DISTRIBUTE_CAROUSEL_ENABLED === "true";
}

export interface CarouselSlideAsset {
  index: number;
  text: string;
  filename: string;
}

export type BuildCarouselResult =
  | { ok: true; slides: CarouselSlideAsset[]; truncated: boolean }
  | { ok: false; reason: "disabled" | "no_slides" | "generation_failed" | "image_limit" | "store_failed" };

export interface BuildDeps {
  /** The brand's usage (tests); otherwise the brand's own, under "carousel". */
  usage?: AiUsage;
  generate?: (prompt: string) => Promise<GeneratedImage | UsageLimited | null>;
  store?: (
    tenantId: string,
    workspaceId: string,
    bytes: Buffer,
    mimeType: string,
  ) => Promise<StoreResult>;
}

export async function buildCarousel(
  ctx: TenantContext,
  workspaceId: string,
  body: string,
  opts: { maxSlides?: number; brandHint?: string } = {},
  deps: BuildDeps = {},
): Promise<BuildCarouselResult> {
  if (!isCarouselEnabled()) return { ok: false, reason: "disabled" };
  const usage = deps.usage ?? aiUsage(ctx, "carousel");
  const generate = deps.generate ?? ((prompt: string) => generateSlideImage(prompt, { usage }));
  const store = deps.store ?? storeWorkspaceImage;

  const { slides, truncated } = planSlides(body, opts.maxSlides);
  if (!slides.length) return { ok: false, reason: "no_slides" };
  // Every slide must fit under the month's image cap, so a carousel is never left half made.
  if (await usage.check("images", slides.length)) return { ok: false, reason: "image_limit" };

  const assets: CarouselSlideAsset[] = [];
  for (const slide of slides) {
    const img = await generate(slideImagePrompt(slide, slides.length, { brandHint: opts.brandHint }));
    // The brand has used its images for the month: no slide is made, as when the model can't make one.
    if (isUsageLimited(img)) return { ok: false, reason: "image_limit" };
    if (!img) return { ok: false, reason: "generation_failed" };
    const stored = await store(ctx.tenantId, workspaceId, img.bytes, img.mimeType);
    // A partial failure leaves earlier slides stored (orphaned in the private
    // bucket — harmless, content-addressed); the operator simply retries.
    if (!stored.ok) return { ok: false, reason: "store_failed" };
    assets.push({ index: slide.index, text: slide.text, filename: stored.filename });
  }
  return { ok: true, slides: assets, truncated };
}
