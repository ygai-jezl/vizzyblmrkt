import {
  StoredJourneyStyleSchema,
  type HeaderTextChoice,
  type JourneyEmailStyle,
  type StoredJourneyStyle,
} from "@/lib/types/tenant";
import type { LifecycleDraft, LifecycleSettings } from "@/lib/types/lifecycle";
import { applyJourneyStyle, type ResolvedEmailStyle } from "@/lib/email/emailStyle";
import { emailStyleHints, secondColourDefault, type PaletteChip } from "../brand-kit/emailStyleForm";

/**
 * Pure helpers for a lifecycle journey's own Email style (EMAIL_JOURNEY_STYLE_ENABLED) in the
 * journey editor: the Settings section's Brand / Custom choice and its hints, the style the
 * editor's preview wears, whether the draft's style differs from the live one, what the draft
 * save sends, and Publish's confirm text. Client-safe.
 */

/** Custom's colours when there's nothing to start from: today's near-black, as the Email style page's. */
const NEAR_BLACK = "#111111";

/**
 * A journey style as a draft or the journey stores it, read leniently as the server reads it
 * (StoredJourneyStyleSchema): unreadable colours are none, the brand's; a damaged gradient or
 * header text drops alone. Docs come back raw, so the editor reads them this way too.
 */
export function readJourneyStyle(value: unknown): StoredJourneyStyle | null {
  return StoredJourneyStyleSchema.parse(value) ?? null;
}

/** Whether two journey styles hold the same colours and header text (none = the brand's, as is anything unreadable). */
export function sameJourneyStyle(a: unknown, b: unknown): boolean {
  const x = readJourneyStyle(a);
  const y = readJourneyStyle(b);
  if (!x || !y) return !x && !y;
  return (
    x.headerColor === y.headerColor &&
    x.accentColor === y.accentColor &&
    (x.headerGradientColor ?? null) === (y.headerGradientColor ?? null) &&
    (x.headerText ?? null) === (y.headerText ?? null)
  );
}

/**
 * The style the editor's preview wears for the draft (`draftStyle`, as the editor holds it): its
 * journey style over the brand's (`brand`, the detail's resolved Email style), exactly as
 * resolveJourneyEmailStyle draws it at send once it's published. Only for journey styles on (the
 * detail says so); no style, or one that doesn't read, is `brand` itself.
 */
export function journeyPreviewStyle(
  brand: ResolvedEmailStyle | null,
  draftStyle: unknown,
  opts: { fallbackName: string; headerOptions: boolean },
): ResolvedEmailStyle | null {
  return applyJourneyStyle(brand, readJourneyStyle(draftStyle), opts);
}

/**
 * What picking Custom starts from: the journey's earlier Custom style (kept while Brand was picked),
 * else the brand's header and button colours (its gradient and header text too, when header options
 * draw them), else near-black, so the emails look the same until a colour is changed.
 */
export function customJourneyStyle(
  previous: StoredJourneyStyle | null,
  brand: ResolvedEmailStyle | null,
  headerOptions: boolean,
): JourneyEmailStyle {
  if (previous) return previous;
  if (!brand) return { headerColor: NEAR_BLACK, accentColor: NEAR_BLACK };
  return {
    headerColor: brand.headerColor,
    accentColor: brand.accentColor,
    ...(headerOptions && brand.headerGradientColor ? { headerGradientColor: brand.headerGradientColor } : {}),
    ...(headerOptions && brand.headerText ? { headerText: brand.headerText } : {}),
  };
}

/** Gradient ticked (Colour 2 starts from the brand colours, as on the Email style page) or unticked (solid). */
export function withJourneyGradient(style: JourneyEmailStyle, on: boolean, palette: readonly PaletteChip[]): JourneyEmailStyle {
  const { headerGradientColor: _dropped, ...solid } = style;
  return on ? { ...solid, headerGradientColor: secondColourDefault(palette, style.headerColor) } : solid;
}

/** The header text choice: Auto is stored as no key. */
export function withJourneyHeaderText(style: JourneyEmailStyle, choice: HeaderTextChoice): JourneyEmailStyle {
  const { headerText: _dropped, ...auto } = style;
  return choice === "auto" ? auto : { ...auto, headerText: choice };
}

/**
 * What the section warns about for a Custom style, as the Email style page does (emailStyleHints):
 * the brand's logo on this header (`logoInk`, its average colour; null = not known, no warning),
 * the header text when the band shows any (a name, or no logo), a button colour too light for
 * links, and dark mode. The gradient and header text count only with header options on, as at send.
 */
export function journeyStyleHints(
  style: JourneyEmailStyle,
  brand: ResolvedEmailStyle | null,
  opts: { logoInk: string | null; headerOptions: boolean },
): string[] {
  return emailStyleHints({
    logoBytes: null,
    logoInk: brand?.logo ? opts.logoInk : null,
    headerColor: style.headerColor,
    accentColor: style.accentColor,
    headerGradientColor: opts.headerOptions ? (style.headerGradientColor ?? null) : null,
    headerText: opts.headerOptions ? (style.headerText ?? "auto") : "auto",
    showsText: Boolean(brand?.name) || !brand?.logo,
  });
}

/** Said under Custom when the brand's emails use a header image, which a Custom journey never shows. */
export function journeyBannerNote(brand: ResolvedEmailStyle | null): string | null {
  if (!brand?.headerImage) return null;
  return brand.logo
    ? "Your header image isn't used here: this journey's emails show your logo on the header colour."
    : "Your header image isn't used here: this journey's emails show your name on the header colour.";
}

/**
 * The brand logo's path on this site, which serves the logos emails load, so the page can read the
 * logo's colour (a canvas reads only same-origin images); null for any other URL.
 */
export function logoSamplePath(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { pathname } = new URL(url);
    return pathname.startsWith("/api/brand-logo/") ? pathname : null;
  } catch {
    return null;
  }
}

/**
 * The draft as the editor's Save sends it. Its journey style goes only when the Email style
 * control was touched since the draft loaded: a body without it keeps what's stored, so a tab
 * opened before Vizzy set a style can't undo it. A draft with no style key is sent as it is.
 */
export function draftForSave(draft: LifecycleDraft, styleTouched: boolean): LifecycleDraft {
  if (styleTouched || !("emailStyle" in draft.settings)) return draft;
  const { emailStyle: _kept, ...settings } = draft.settings;
  return { ...draft, settings };
}

/** `settings` with the journey style a save stored (`saved`, from the saved draft; none leaves no key). */
export function withSavedJourneyStyle(settings: LifecycleSettings, saved: unknown): LifecycleSettings {
  const { emailStyle: _replaced, ...rest } = settings;
  return saved === undefined || saved === null ? rest : { ...rest, emailStyle: saved as StoredJourneyStyle };
}

/**
 * Publish's confirm. A first publish starts the journey; a later one keeps people on the version
 * they started with, and when the draft's email style differs from the live one (`styleChanged`),
 * says their next email wears it: sends wear the journey's live style, whatever their version.
 */
export function publishConfirmText(
  journey: { publishedVersion: number | null; deliveryMode: string },
  styleChanged: boolean,
): string {
  if (!journey.publishedVersion) return `Publish and start the journey in ${journey.deliveryMode} mode?`;
  return styleChanged
    ? "Publish these changes? People already in the journey stay on the version they started with, and their next email uses the new email style."
    : "Publish these changes? People already in the journey stay on the version they started with.";
}
