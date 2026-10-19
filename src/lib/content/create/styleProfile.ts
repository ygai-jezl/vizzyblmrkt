import { readWorkspaceAsset } from "@/lib/workspace/assetStore";
import { generateText, generateTextWithImage, parseFirstJson } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { EBOOK_IMAGE_INLINE_MAX_BYTES } from "@/lib/content/create/ebook";
import { StyleProfileSchema, type StyleProfile } from "@/lib/types/styleProfile";
import {
  getImageAsset,
  updateImageAsset,
  listBrandExemplars,
  listBrandNegatives,
} from "@/lib/admin/brandKit";
import { setTenantLearnedImageStyle, setTenantStyleLearned } from "@/lib/tenant/control";
import { canonicalStyleId } from "@/lib/content/imageStyle/catalogue";
import type { ImageStyleId } from "@/lib/types/imageStyle";
import type { TenantContext } from "@/lib/tenant/types";
import type { ImageAsset } from "@/lib/types/imageAsset";
import { isBrandStyleLoopEnabled } from "./brandStyleLoop";

/**
 * Layer 1 of the brand-style feedback loop: turn operator-approved images into a
 * reusable style signal. Two moves:
 *  1. extractStyleProfile — a vision pass distils ONE image's aesthetic into a
 *     structured StyleProfile (subject-agnostic, text-in-image ignored).
 *  2. refreshLearnedImageStyle — synthesize the tenant's rated exemplars (weighted by
 *     rating, with 👎 images as "avoid") into a single art-director directive stored on
 *     the tenant Brand Kit, from where assembleBrandContext injects it into every image
 *     prompt.
 * Everything is fail-soft (mirrors recordExemplar): a model/Firestore blip must never
 * break the operator's vote — the loop just stays at its previous state.
 */

const MAX_EXEMPLARS_FOR_SYNTHESIS = 20;
const MAX_NEGATIVES_FOR_SYNTHESIS = 8;

/** Vision-extract a StyleProfile from a stored image asset's bytes. Null on any failure. */
export async function extractStyleProfile(input: {
  tenantId: string;
  workspaceId: string;
  filename: string;
}): Promise<StyleProfile | null> {
  const asset = await readWorkspaceAsset(input.tenantId, input.workspaceId, input.filename).catch(
    () => null,
  );
  if (!asset) return null;
  if (asset.bytes.length > EBOOK_IMAGE_INLINE_MAX_BYTES) return null; // too large to inline
  const raw = await generateTextWithImage(
    renderPrompt("content.style_profile_extract", {}),
    asset.bytes.toString("base64"),
    asset.contentType,
  );
  if (!raw) return null;
  const json = parseFirstJson(raw);
  if (!json) return null;
  const parsed = StyleProfileSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * On a 👍: extract this asset's StyleProfile, persist it onto the row, then re-synthesize
 * the tenant's learned style. Fire-and-forget from the feedback route (never awaited by
 * the response). No-op when the loop kill switch is off.
 */
export async function refreshExemplarStyle(ctx: TenantContext, assetId: string): Promise<void> {
  if (!isBrandStyleLoopEnabled()) return;
  const asset = await getImageAsset(ctx, assetId);
  if (!asset) return;
  const profile = await extractStyleProfile({
    tenantId: ctx.tenantId,
    workspaceId: asset.workspaceId,
    filename: asset.filename,
  });
  if (profile) {
    await updateImageAsset(ctx, assetId, { styleProfile: profile }).catch(() => {});
  }
  await refreshLearnedImageStyle(ctx);
}

/** One-line summary of an exemplar's StyleProfile for the synthesis prompt. */
function profileLine(a: ImageAsset): string | null {
  const p = a.styleProfile;
  if (!p) return null;
  const bits = [
    p.medium,
    p.palette?.length ? `palette ${p.palette.join(" ")}` : "",
    p.lighting,
    p.mood,
    p.composition,
    p.texture,
    p.postProcessing,
    p.subjectTreatment,
  ]
    .map((s) => (s ?? "").trim())
    .filter(Boolean);
  return bits.length ? bits.join("; ") : null;
}

/**
 * Re-synthesize the tenant's learned image-style directive from its rated exemplars
 * (weighted by rating) + negatives, and persist it onto the tenant Brand Kit. Read-
 * merges the existing brandKit so the PDF-extracted fields are never clobbered.
 * Fail-soft; no-op when the loop is off.
 */
export async function refreshLearnedImageStyle(ctx: TenantContext): Promise<void> {
  if (!isBrandStyleLoopEnabled()) return;
  try {
    const [exemplars, negatives] = await Promise.all([
      listBrandExemplars(ctx, { limit: MAX_EXEMPLARS_FOR_SYNTHESIS }),
      listBrandNegatives(ctx, { limit: MAX_NEGATIVES_FOR_SYNTHESIS }),
    ]);
    const next = await synthesizeDirective(exemplars, negatives);
    if (next === "keep") return;
    await persistLearnedStyle(ctx, next.directive, next.sampleCount);
  } catch (err) {
    console.warn("[brandStyleLoop] refreshLearnedImageStyle failed:", err);
  }
}

/** How far down the newest votes a per-style refresh reads before filtering to one style. */
const MAX_POOL_FOR_STYLE = 100;
const MAX_NEGATIVE_POOL_FOR_STYLE = 50;

/**
 * Learning per style (BRAND_IMAGE_STYLE_ENABLED): re-learn one style's directive from the
 * thumbs on images made in that style only (old presets count towards the style they map
 * to), and store it under that style. Reads a wider pool and filters in memory, so no new
 * index. Fail-soft; no-op when the loop is off.
 */
export async function refreshLearnedStyleBucket(ctx: TenantContext, styleId: ImageStyleId): Promise<void> {
  if (!isBrandStyleLoopEnabled()) return;
  try {
    const [pool, negativePool] = await Promise.all([
      listBrandExemplars(ctx, { limit: MAX_POOL_FOR_STYLE }),
      listBrandNegatives(ctx, { limit: MAX_NEGATIVE_POOL_FOR_STYLE }),
    ]);
    const inStyle = (a: ImageAsset) => canonicalStyleId(a.style) === styleId;
    const exemplars = pool.filter(inStyle).slice(0, MAX_EXEMPLARS_FOR_SYNTHESIS);
    const negatives = negativePool.filter(inStyle).slice(0, MAX_NEGATIVES_FOR_SYNTHESIS);
    const next = await synthesizeDirective(exemplars, negatives);
    if (next === "keep") return;
    await setTenantStyleLearned(ctx.tenantId, styleId, next);
  } catch (err) {
    console.warn("[brandStyleLoop] refreshLearnedStyleBucket failed:", err);
  }
}

/**
 * One art-director directive from rated exemplars (weighted by rating) and negatives.
 * "keep" = exemplars exist but none is profiled yet: leave the current directive alone.
 */
async function synthesizeDirective(
  exemplars: ImageAsset[],
  negatives: ImageAsset[],
): Promise<{ directive: string | null; sampleCount: number } | "keep"> {
  const rated = exemplars
    .map((a) => ({ line: profileLine(a), rating: a.brandRating ?? 5 }))
    .filter((x): x is { line: string; rating: number } => Boolean(x.line));

  if (rated.length === 0) {
    // Clear the directive ONLY when there are genuinely no positive exemplars left (the
    // last 👍 was removed). If exemplars exist but none are profiled yet (extraction
    // pending/failed, or the profiled ones fell outside the top-N window), keep the
    // current directive rather than wiping a good one.
    return exemplars.length === 0 ? { directive: null, sampleCount: 0 } : "keep";
  }

  const exemplarBlock = rated
    .sort((a, b) => b.rating - a.rating)
    .map((x) => `[${x.rating}/10] ${x.line}`)
    .join("\n");
  const negativeBlock =
    negatives
      .map((a) => profileLine(a))
      .filter(Boolean)
      .join("\n") || "(none)";

  const directive = await generateText(
    renderPrompt("content.style_profile_synthesize", {
      exemplars: exemplarBlock,
      negatives: negativeBlock,
    }),
  );
  // Deterministic fallback: if the model is unavailable, use the top-rated exemplar's
  // line + a merged palette so the loop still improves generation.
  const fallback = deterministicDirective(rated, exemplars);
  return { directive: (directive?.trim() || fallback).slice(0, 2000), sampleCount: rated.length };
}

function deterministicDirective(
  rated: { line: string; rating: number }[],
  exemplars: ImageAsset[],
): string {
  const top = rated[0]?.line ?? "";
  const palette = [
    ...new Set(exemplars.flatMap((a) => a.styleProfile?.palette ?? [])),
  ].slice(0, 8);
  const paletteClause = palette.length ? ` Favour this palette: ${palette.join(", ")}.` : "";
  return `Match this brand look: ${top}.${paletteClause}`.trim();
}

async function persistLearnedStyle(
  ctx: TenantContext,
  directive: string | null,
  sampleCount: number,
): Promise<void> {
  // Dotted field-path write (control-plane): touches ONLY the learned-style keys, so it
  // can never clobber the PDF-extracted brandKit fields (summary/palette/tone/…), and a
  // concurrent whole-brandKit write can't clobber the learned style either.
  await setTenantLearnedImageStyle(ctx.tenantId, { directive, sampleCount });
}
