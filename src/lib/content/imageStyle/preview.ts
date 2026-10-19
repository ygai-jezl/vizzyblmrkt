/**
 * The drawn styles Brand › Image style can preview with the brand's own logo, fonts and accent.
 * Split card isn't one: without its painted photo the preview would mislead. Client-safe.
 */
export const PREVIEWABLE_STYLES = ["product_noir", "headline_card", "data_story", "type_poster", "line_art"] as const;

export function isPreviewable(styleId: string | null | undefined): boolean {
  return (PREVIEWABLE_STYLES as readonly string[]).includes(styleId ?? "");
}
