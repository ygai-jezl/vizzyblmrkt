import { type WidgetMode, type WidgetType } from "./types";

/**
 * Live-preview vocabulary for the admin Embed & Design builder. The builder
 * iframes an ADMIN-ONLY route (src/app/admin-preview/[campaignId]) and passes
 * the founder's UNSAVED branding edits as query params, so every tweak is
 * reflected instantly without a save round-trip. The route sits OUTSIDE the
 * /admin tree on purpose — clear of the admin sidebar + launch-tab layouts — so
 * the frame shows only the hosted page or the bare widget.
 *
 * This is deliberately separate from the public embed snippet (snippet.ts):
 * because the preview route is admin-gated + same-origin-framed, it can safely
 * accept free-text copy overrides (success message, button label) that must NOT
 * be settable on the public /embed route.
 */

/**
 * What the preview renders. Either the standalone hosted page, or one of the
 * three embeddable widget types. `hosted` is not a WidgetType (it isn't an embed
 * surface), so the union is explicit.
 */
export type PreviewSurface = "hosted" | WidgetType;

/** Unsaved branding edits mirrored into the preview as query params. */
export interface PreviewBrandingDraft {
  widgetBackgroundColor?: string;
  widgetButtonColor?: string;
  widgetFontColor?: string;
  statusDescription?: string;
  joinButtonLabel?: string;
  removeWidgetHeaders?: boolean;
}

export interface PreviewUrlParams {
  origin: string;
  campaignId: string;
  surface: PreviewSurface;
  mode?: WidgetMode;
  draft?: PreviewBrandingDraft;
}

/** Parse an untrusted `surface` query value, defaulting to the full widget. */
export function parsePreviewSurface(raw: string | null | undefined): PreviewSurface {
  const up = (raw ?? "").trim().toUpperCase();
  if (up === "HOSTED") return "hosted";
  if (up === "WIDGET_2") return "WIDGET_2";
  if (up === "WIDGET_3") return "WIDGET_3";
  return "WIDGET_1";
}

/**
 * Build the admin preview-route URL. Colours/copy are added only when set;
 * `header` is ALWAYS sent as an explicit 0/1 so toggling "remove headers" in the
 * builder is reflected live (an absent param would otherwise fall back to the
 * persisted value and the toggle would appear dead).
 */
export function buildPreviewUrl({
  origin,
  campaignId,
  surface,
  mode,
  draft,
}: PreviewUrlParams): string {
  const base = origin.replace(/\/+$/, "");
  const qs = new URLSearchParams({ surface });
  if (mode === "CHECK") qs.set("mode", "CHECK");
  if (draft?.widgetButtonColor) qs.set("buttonColor", draft.widgetButtonColor);
  if (draft?.widgetBackgroundColor) qs.set("bgColor", draft.widgetBackgroundColor);
  if (draft?.widgetFontColor) qs.set("fontColor", draft.widgetFontColor);
  const success = draft?.statusDescription?.trim();
  if (success) qs.set("success", success);
  const joinLabel = draft?.joinButtonLabel?.trim();
  if (joinLabel) qs.set("joinLabel", joinLabel);
  qs.set("header", draft?.removeWidgetHeaders ? "0" : "1");
  return `${base}/admin-preview/${encodeURIComponent(campaignId)}?${qs.toString()}`;
}
