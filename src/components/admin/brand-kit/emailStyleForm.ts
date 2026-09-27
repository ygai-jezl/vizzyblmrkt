import { EMAIL_STYLE_LIMITS, type BrandKit, type EmailStyleSuggestion } from "@/lib/types/tenant";
import type { BrandLogo } from "@/lib/types/brandLogo";
import { normalizeHex } from "@/lib/content/create/colorPalette";
import {
  accentFor,
  contrastRatio,
  isEmailLogo,
  luminance,
  readableOn,
  type BrandKitEmailStyle,
  type EmailStyleLogoOption,
} from "@/lib/email/emailStyle";

/**
 * Pure helpers for the Brand › Email style page (EmailStyleCard): sizing a logo for the
 * header, the logo-on-header contrast check, "Use brand kit" with the logo in view, reviewing
 * a Vizzy suggestion, and the page's hints. Client-safe; only the canvas read itself lives in
 * the component.
 */

/** A logo the page can offer: what "Use brand kit" needs, plus its name and size on disk. */
export type EmailStyleLogoChoice = EmailStyleLogoOption & Pick<BrandLogo, "title" | "byteSize">;

export interface PaletteChip {
  hex: string;
  name: string;
}

/** Past this, a logo can load slowly in an inbox. */
export const HEAVY_LOGO_BYTES = 200 * 1024;

/** The header's minimum contrast for a logo (WCAG's 3:1 for graphics). */
const LOGO_CONTRAST = 3;

/** The logo's display size: its natural size, scaled down (never up) to fit 200×48. */
export function fitLogoSize(naturalWidth: number, naturalHeight: number): { width: number; height: number } | null {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return null;
  const { logoWidth, logoHeight } = EMAIL_STYLE_LIMITS;
  const scale = Math.min(1, logoWidth / naturalWidth, logoHeight / naturalHeight);
  return {
    width: Math.min(logoWidth, Math.max(1, Math.round(naturalWidth * scale))),
    height: Math.min(logoHeight, Math.max(1, Math.round(naturalHeight * scale))),
  };
}

/** The average colour of a logo's opaque pixels (RGBA bytes, as getImageData gives them); null when none are. */
export function averageInk(rgba: ArrayLike<number>): string | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 128) continue;
    r += rgba[i]!;
    g += rgba[i + 1]!;
    b += rgba[i + 2]!;
    n++;
  }
  if (!n) return null;
  return `#${[r, g, b].map((c) => Math.round(c / n).toString(16).padStart(2, "0")).join("")}`;
}

/** The logo is hard to see on this header (below 3:1). An unknown ink — the canvas couldn't be read — never warns. */
export function logoHardToSee(ink: string | null, headerColor: string): boolean {
  return ink !== null && contrastRatio(ink, headerColor) < LOGO_CONTRAST;
}

/**
 * "Use brand kit" with the logo in view: when the logo is hard to see on the brand colour but
 * fine on white, the header turns white and the brand colour moves to the button.
 */
export function brandKitWithLogo(kit: BrandKitEmailStyle, ink: string | null): BrandKitEmailStyle {
  if (!logoHardToSee(ink, kit.headerColor) || logoHardToSee(ink, "#ffffff")) return kit;
  return {
    ...kit,
    headerColor: "#ffffff",
    accentColor: kit.headerColor,
    notes: [...kit.notes, "Your logo is hard to see on your brand colour, so the header is white and the brand colour is on the button"],
  };
}

/** A pending Vizzy suggestion as the page shows it: who asked is left out. */
export type PendingEmailStyleSuggestion = Omit<EmailStyleSuggestion, "suggestedBy">;

/**
 * Review a Vizzy suggestion: its values for the form, exactly as asked (a hard-to-see logo
 * gets the page's warning, never a colour swap). A logo that's since been deleted, or that
 * email can't show, falls back to no logo with a note. With no logo list (`unlisted`: Logos is
 * off, or the list failed to load), only the saved logo is known: any other suggested logo
 * leaves the saved one.
 */
export function suggestionForReview(
  suggestion: PendingEmailStyleSuggestion,
  logos: readonly EmailStyleLogoChoice[],
  unlisted?: { savedLogoId: string | null; logosOff?: boolean },
): BrandKitEmailStyle {
  const notes = [...suggestion.notes];
  let logoId: string | null;
  if (unlisted) {
    const known = suggestion.logoId === null || suggestion.logoId === unlisted.savedLogoId;
    logoId = known ? suggestion.logoId : unlisted.savedLogoId;
    if (!known) {
      notes.push(
        unlisted.logosOff
          ? "Logos aren't switched on in this environment, so the suggested logo isn't used"
          : "Your logos couldn't be loaded, so the suggested logo isn't used — try Review again later",
      );
    }
  } else {
    const logo = logos.find((l) => l.id === suggestion.logoId);
    const usable = logo && isEmailLogo(logo) ? logo : null;
    logoId = usable?.id ?? null;
    if (suggestion.logoId !== null && !usable) {
      notes.push(
        logo
          ? "The suggested logo can't be shown in email, so there's no logo — pick another if you like"
          : "The suggested logo has been deleted, so there's no logo — pick another if you like",
      );
    }
  }
  return {
    logoId,
    companyName: suggestion.companyName,
    headerColor: suggestion.headerColor,
    accentColor: suggestion.accentColor,
    notes,
  };
}

/** What the page warns about for the style being edited. */
export function emailStyleHints(input: {
  logoBytes: number | null;
  logoInk: string | null;
  headerColor: string;
  accentColor: string;
}): string[] {
  const hints: string[] = [];
  if (logoHardToSee(input.logoInk, input.headerColor)) {
    hints.push(
      luminance(input.logoInk!) < luminance(input.headerColor)
        ? "Your logo is hard to see on this header — pick a lighter header or upload a light version of the logo"
        : "Your logo is hard to see on this header — pick a darker header or upload a dark version of the logo",
    );
  }
  if (input.logoBytes !== null && input.logoBytes > HEAVY_LOGO_BYTES) {
    hints.push("This logo is over 200 KB, so it may load slowly — a smaller PNG or JPG is better");
  }
  if (!accentFor({ accentColor: input.accentColor }, "link")) {
    hints.push("This button colour is too light for text links, so links stay dark. Buttons still use it, with dark text");
  }
  if (readableOn(input.headerColor) === "#000000") {
    hints.push("Gmail's phone apps may darken a light header in dark mode — check it on your phone after saving");
  }
  return hints;
}

/** The brand's colours as quick picks: `palette` then `palettes`, deduped, at most `max`. */
export function paletteChips(kit: BrandKit | null | undefined, max = 12): PaletteChip[] {
  const chips: PaletteChip[] = [];
  const seen = new Set<string>();
  for (const c of [...(kit?.palette ?? []), ...(kit?.palettes ?? []).flatMap((g) => g.colors)]) {
    const hex = normalizeHex(c.hex);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    chips.push({ hex, name: c.name?.trim() || hex });
    if (chips.length >= max) break;
  }
  return chips;
}
