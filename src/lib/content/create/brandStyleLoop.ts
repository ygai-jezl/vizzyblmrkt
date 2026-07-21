/**
 * Flags + constants for the brand-style feedback loop (RL-lite image generation).
 * Pure env reads, no imports — safe from both server routes and the creative layer.
 * The capture/gallery UI itself rides on BRAND_KIT_ENABLED (see content/brandKit.ts);
 * these gate the parts that call models or change generation.
 */

/** L1 — allow the vision extraction + style synthesis writes (kill switch). */
export function isBrandStyleLoopEnabled(): boolean {
  return process.env.BRAND_STYLE_LOOP_ENABLED === "true";
}

/** L2 — attach on-brand exemplars as STYLE reference images to generation. */
export function isBrandStyleRefsEnabled(): boolean {
  return process.env.BRAND_STYLE_REFS_ENABLED === "true";
}

/** L3 — generate N candidates and auto-pick the most on-brand (off by default). */
export function isBestOfNEnabled(): boolean {
  return process.env.BRAND_BEST_OF_N === "true";
}

/** How many candidates best-of-N generates (clamped 2–4; default 2). */
export function bestOfNCount(): number {
  const raw = Number.parseInt(process.env.BRAND_BEST_OF_N_COUNT ?? "", 10);
  if (!Number.isFinite(raw)) return 2;
  return Math.min(Math.max(raw, 2), 4);
}

/** Nano Banana FULL accepts at most 3 dedicated style-reference images. */
export const MAX_STYLE_REFS = 3;

/** Only exemplars rated at least this high are shown to the model as references. */
export const MIN_REF_RATING = 6;
