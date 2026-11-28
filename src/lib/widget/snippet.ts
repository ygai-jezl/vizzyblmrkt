import {
  DEFAULT_WIDGET_TYPE,
  type ThemeOverrides,
  type WidgetMode,
  type WidgetType,
} from "./types";

/**
 * The `data-*` attributes the loader (/embed.js) reads off the container div.
 * Kept here so the snippet generator and the loader agree on names. The loader
 * is plain JS text, so it duplicates these strings literally — change both.
 */
export const EMBED_ATTR = {
  campaign: "data-vizzybl-campaign",
  tenant: "data-vizzybl-tenant",
  type: "data-vizzybl-type",
  mode: "data-vizzybl-mode",
  ref: "data-vizzybl-ref",
  buttonColor: "data-vizzybl-button-color",
  bgColor: "data-vizzybl-bg-color",
  fontColor: "data-vizzybl-font-color",
  height: "data-vizzybl-height",
  /** The host page's language (PAGE_LANGUAGES_ENABLED): the widget shows it, before the visitor's browser. */
  lang: "data-vizzybl-lang",
} as const;

/** The path of the loader script, relative to the app origin. */
export const EMBED_SCRIPT_PATH = "/embed.js";

export interface EmbedUrlParams {
  origin: string;
  campaignId: string;
  /** Explicit tenant id, carried as `?t=` for shared-platform-host routing. */
  tenantId?: string;
  widgetType?: WidgetType;
  mode?: WidgetMode;
  ref?: string;
  theme?: ThemeOverrides;
  /** The page's language, carried as `?lng=`. */
  lang?: string;
}

/**
 * The iframe `src` for an embed (also used as the live-preview URL). Always
 * carries the widget type; mode/ref/theme are added only when set. Values are
 * URL-encoded by URLSearchParams.
 */
export function buildEmbedUrl({
  origin,
  campaignId,
  tenantId,
  widgetType = DEFAULT_WIDGET_TYPE,
  mode,
  ref,
  theme,
  lang,
}: EmbedUrlParams): string {
  const base = origin.replace(/\/+$/, "");
  const qs = new URLSearchParams({ type: widgetType });
  if (tenantId) qs.set("t", tenantId);
  if (mode === "CHECK") qs.set("mode", "CHECK");
  if (ref) qs.set("ref", ref);
  if (theme?.buttonColor) qs.set("buttonColor", theme.buttonColor);
  if (theme?.backgroundColor) qs.set("bgColor", theme.backgroundColor);
  if (theme?.fontColor) qs.set("fontColor", theme.fontColor);
  if (lang) qs.set("lng", lang);
  return `${base}/embed/${encodeURIComponent(campaignId)}?${qs.toString()}`;
}

/** Escape a value for safe interpolation inside a double-quoted HTML attribute. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface EmbedSnippetParams {
  origin: string;
  campaignId: string;
  /** Explicit tenant id baked into the snippet for shared-platform-host routing. */
  tenantId?: string;
  widgetType?: WidgetType;
  mode?: WidgetMode;
  /** The language of the page it goes on; absent = the visitor's own. */
  lang?: string;
}

/**
 * The copy-paste HTML a customer drops onto any site: a container div with
 * data attributes plus the async loader script. The loader turns the div into
 * a sandboxed iframe and keeps it sized to its content.
 */
export function buildEmbedSnippet({
  origin,
  campaignId,
  tenantId,
  widgetType = DEFAULT_WIDGET_TYPE,
  mode,
  lang,
}: EmbedSnippetParams): string {
  const base = origin.replace(/\/+$/, "");
  const attrs = [
    `${EMBED_ATTR.campaign}="${escapeAttr(campaignId)}"`,
  ];
  if (tenantId) attrs.push(`${EMBED_ATTR.tenant}="${escapeAttr(tenantId)}"`);
  attrs.push(`${EMBED_ATTR.type}="${escapeAttr(widgetType)}"`);
  if (mode === "CHECK") attrs.push(`${EMBED_ATTR.mode}="CHECK"`);
  if (lang) attrs.push(`${EMBED_ATTR.lang}="${escapeAttr(lang)}"`);
  return [
    "<!-- Vizzybl waitlist widget -->",
    `<div ${attrs.join(" ")}></div>`,
    `<script src="${escapeAttr(base + EMBED_SCRIPT_PATH)}" async></script>`,
  ].join("\n");
}
