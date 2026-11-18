/**
 * BRAND_CONTEXT_ENABLED: the context pack (src/lib/brandContext/pack.ts), everything a brand knows
 * about one question gathered in one place, and Vizzy's get_brand_context, which reads it.
 */
export function isBrandContextEnabled(): boolean {
  return process.env.BRAND_CONTEXT_ENABLED === "true";
}
