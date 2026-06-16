/**
 * Embeddable-widget vocabulary, shared by the loader (/embed.js), the embed
 * page (/embed/[campaignId]), and the admin Widget Builder. We mirror
 * getwaitlist.com's three widget *types* for familiarity, but render them as a
 * sandboxed iframe rather than DOM-injection (see /embed.js for the rationale).
 */

/** The three widget shapes. WIDGET_1 = full form, WIDGET_2/3 = email-only. */
export const WIDGET_TYPES = ["WIDGET_1", "WIDGET_2", "WIDGET_3"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

/** Form layout the embed page renders for a given widget type. */
export type WidgetVariant = "full" | "mini" | "docked";

export interface WidgetTypeMeta {
  type: WidgetType;
  label: string;
  variant: WidgetVariant;
  description: string;
}

export const WIDGET_TYPE_META: Record<WidgetType, WidgetTypeMeta> = {
  WIDGET_1: {
    type: "WIDGET_1",
    label: "Full",
    variant: "full",
    description:
      "The complete form: name, contact, custom questions, position, count, and the referral link with share.",
  },
  WIDGET_2: {
    type: "WIDGET_2",
    label: "Mini",
    variant: "mini",
    description:
      "A sleek inline email capture. Collects email only; shows position and total (unless hidden).",
  },
  WIDGET_3: {
    type: "WIDGET_3",
    label: "Docked",
    variant: "docked",
    description:
      "Email-only with the Join button docked inside the email field — the most compact form.",
  },
};

/** The widget type used when none is specified. */
export const DEFAULT_WIDGET_TYPE: WidgetType = "WIDGET_1";

/** Parse an untrusted widget-type string, falling back to the default. */
export function parseWidgetType(raw: string | null | undefined): WidgetType {
  const up = (raw ?? "").trim().toUpperCase();
  return (WIDGET_TYPES as readonly string[]).includes(up)
    ? (up as WidgetType)
    : DEFAULT_WIDGET_TYPE;
}

export function widgetVariant(type: WidgetType): WidgetVariant {
  return WIDGET_TYPE_META[type].variant;
}

/** Widget mode: standard signup, or "check my status" (returning visitor). */
export const WIDGET_MODES = ["SIGNUP", "CHECK"] as const;
export type WidgetMode = (typeof WIDGET_MODES)[number];

export function parseWidgetMode(raw: string | null | undefined): WidgetMode {
  return (raw ?? "").trim().toUpperCase() === "CHECK" ? "CHECK" : "SIGNUP";
}

/**
 * Per-embed theme overrides. These flow from untrusted query params into inline
 * `style` on the server-rendered widget, so each value is validated as a CSS
 * hex color (`#rgb`/`#rrggbb`/`#rrggbbaa`). Anything else is dropped, falling
 * back to the campaign's configured colors — this is the CSS-injection guard.
 */
export interface ThemeOverrides {
  buttonColor?: string;
  backgroundColor?: string;
  fontColor?: string;
}

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Return the value only if it is a safe hex color, else undefined. */
export function safeColor(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim();
  return HEX_COLOR_RE.test(v) ? v : undefined;
}

export function parseThemeOverrides(get: (k: string) => string | null | undefined): ThemeOverrides {
  const out: ThemeOverrides = {};
  const button = safeColor(get("buttonColor"));
  const background = safeColor(get("bgColor"));
  const font = safeColor(get("fontColor"));
  if (button) out.buttonColor = button;
  if (background) out.backgroundColor = background;
  if (font) out.fontColor = font;
  return out;
}
