import {
  EMAIL_STYLE_LIMITS,
  type BrandKit,
  type EmailFontId,
  type EmailStyleHeaderImage,
  type EmailStyleInput,
  type EmailStyleLogo,
  type EmailStyleSuggestion,
  type EmailTheme,
  type EmailThemePreset,
  type HeaderTextChoice,
  type TextStyle,
  type TextStyleRole,
} from "@/lib/types/tenant";
import type { BrandLogo } from "@/lib/types/brandLogo";
import { normalizeHex } from "@/lib/content/create/colorPalette";
import {
  accentFor,
  bandStops,
  bandTextContrast,
  cleanCompanyName,
  contrastRatio,
  isEmailLogo,
  luminance,
  readableOn,
  type BrandKitEmailStyle,
  type EmailStyleLogoOption,
} from "@/lib/email/emailStyle";
import { EMAIL_FONTS, EMAIL_FONT_LIST, emailFontFileUrl, isEmailFontId, isWebFont } from "@/lib/email/emailFonts";
import { EMAIL_THEME_PRESET_SPECS, compactTheme, isEmailThemePreset } from "@/lib/email/emailThemes";
import { bannerWarnings, type EmailHeaderImageChoice } from "./headerImage";

/**
 * Pure helpers for the Brand › Email style page (EmailStyleCard): sizing a logo for the
 * header, the logo-on-header contrast check, "Use brand kit" with the logo in view, reviewing
 * a Vizzy suggestion, a gradient's starting colour, the page's hints, the theme (its fonts,
 * "Use brand fonts") and what a Save sends. Client-safe; only the canvas read itself lives in
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

/** The header text's minimum contrast: it's 18px bold, which counts as large text here (3:1). */
const TEXT_CONTRAST = 3;

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

/** A reviewed suggestion as the form loads it, with its header options (null = solid, "auto" = Auto). */
export type ReviewedEmailStyle = BrandKitEmailStyle & {
  headerGradientColor: string | null;
  headerText: HeaderTextChoice;
  /** The header image to pick (null = the colour header); only there when `headers` was given. */
  headerImageId?: string | null;
  /** The look and its fonts (none = Classic with the system font); only there when `themes` was given. */
  theme?: FormTheme;
};

/**
 * Review a Vizzy suggestion: its values for the form, exactly as asked (a hard-to-see logo
 * gets the page's warning, never a colour swap). A logo that's since been deleted, or that
 * email can't show, falls back to no logo with a note. With no logo list (`unlisted`: Logos is
 * off, or the list failed to load), only the saved logo is known: any other suggested logo
 * leaves the saved one. A suggestion is a whole style, so no header options means solid, Auto.
 *
 * With the header options on (`headers`), its header too: no header image means the colour
 * header, and one that's since been deleted falls back to it with a note. With no header-image
 * list (`headers.images` null), the Header choice is locked and Save keeps the stored one, so
 * the saved choice stays, with a note when the suggestion asked for another.
 *
 * With themes on (`themes`), its theme too, the same way: none means Classic with the system font.
 */
export function suggestionForReview(
  suggestion: PendingEmailStyleSuggestion,
  logos: readonly EmailStyleLogoChoice[],
  unlisted?: { savedLogoId: string | null; logosOff?: boolean },
  headers?: { images: readonly Pick<EmailHeaderImageChoice, "id">[] | null; savedImageId: string | null },
  themes?: boolean,
): ReviewedEmailStyle {
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
  let headerImageId: string | null | undefined;
  if (headers) {
    const asked = suggestion.headerImageId ?? null;
    if (!headers.images) {
      headerImageId = headers.savedImageId;
      if (asked !== headers.savedImageId) {
        notes.push("Your header images couldn't be loaded, so the suggested header isn't used — try Review again later");
      }
    } else if (asked && !headers.images.some((i) => i.id === asked)) {
      headerImageId = null;
      notes.push("The suggested header image has been deleted, so the header uses its colour");
    } else {
      headerImageId = asked;
    }
  }
  return {
    logoId,
    companyName: suggestion.companyName,
    headerColor: suggestion.headerColor,
    accentColor: suggestion.accentColor,
    headerGradientColor: suggestion.headerGradientColor ?? null,
    headerText: suggestion.headerText ?? "auto",
    ...(headerImageId !== undefined ? { headerImageId } : {}),
    ...(themes ? { theme: themeForForm(suggestion.theme) } : {}),
    notes,
  };
}

const LINK_HINT = "This button colour is too light for text links, so links stay dark. Buttons still use it, with dark text";
const DARK_MODE_HINT = "Gmail's phone apps may darken a light header in dark mode — check it on your phone after saving";

/**
 * What the page warns about for the style being edited. With a gradient, the logo and the
 * light-header checks run across both colours (the logo warns on the worse one), and the
 * header text is checked too, when the band shows any (`showsText`): a forced colour or a
 * gradient can take it below 3:1. Never blocks a Save.
 *
 * With a header image (`headerImage` set, Image mode) the band is the banner on the plain
 * header colour, so the logo and header-text checks don't apply: the banner's own warnings
 * (narrow, tall, heavy) come first, then the link hint, and the dark-mode hint for the header
 * colour alone, which shows behind a transparent banner and whenever images are off.
 *
 * With a theme (`theme`, themes on), last in either mode: what most inboxes show in place of a
 * web font, since only a few load them (none at all while web fonts are off).
 */
export function emailStyleHints(input: {
  logoBytes: number | null;
  logoInk: string | null;
  headerColor: string;
  accentColor: string;
  /** The gradient's second colour; null or absent = a solid header. */
  headerGradientColor?: string | null;
  /** Absent = Auto. */
  headerText?: HeaderTextChoice;
  /** The band shows text: a company name, or the name in place of a logo. */
  showsText?: boolean;
  /**
   * Image mode: the picked banner's size (a null byte size skips the weight hint), or null
   * with none picked yet. Absent = the colour header.
   */
  headerImage?: { width: number; height: number; byteSize: number | null } | null;
  /** The theme's fonts, and whether web fonts are on. Absent = themes are off. */
  theme?: { headingFont: EmailFontId; bodyFont: EmailFontId; webFonts: boolean };
}): string[] {
  const fontHint = input.theme ? webFontHint(input.theme) : null;
  if (input.headerImage !== undefined) {
    const hints = input.headerImage ? bannerWarnings(input.headerImage) : [];
    if (!accentFor({ accentColor: input.accentColor }, "link")) hints.push(LINK_HINT);
    const [bg] = bandStops({ headerColor: input.headerColor });
    if (readableOn(bg) === "#000000") hints.push(DARK_MODE_HINT);
    if (fontHint) hints.push(fontHint);
    return hints;
  }
  const hints: string[] = [];
  const band = {
    headerColor: input.headerColor,
    headerGradientColor: input.headerGradientColor ?? undefined,
    headerText: input.headerText === "white" || input.headerText === "black" ? input.headerText : undefined,
  };
  const stops = bandStops(band);
  const ink = input.logoInk;
  // The stop the logo is hardest to see on.
  const worst = ink === null ? null : stops.reduce((a, b) => (contrastRatio(ink, b) < contrastRatio(ink, a) ? b : a));
  if (worst && logoHardToSee(ink, worst)) {
    hints.push(
      luminance(ink!) < luminance(worst)
        ? "Your logo is hard to see on this header — pick a lighter header or upload a light version of the logo"
        : "Your logo is hard to see on this header — pick a darker header or upload a dark version of the logo",
    );
  }
  if (input.showsText) {
    const ratio = bandTextContrast(band);
    if (ratio < TEXT_CONTRAST) {
      // Rounded down, so a warning never shows 3.0:1.
      const shown = `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`;
      // "Pick Auto" only when Auto would read well: on a light-to-dark gradient it can't either.
      if (band.headerText && bandTextContrast({ ...band, headerText: undefined }) >= TEXT_CONTRAST) {
        hints.push(
          band.headerText === "white"
            ? `White text is hard to read on this header (${shown}) — pick Auto, or a darker header`
            : `Black text is hard to read on this header (${shown}) — pick Auto, or a lighter header`,
        );
      } else {
        hints.push(`The header text is hard to read on part of the gradient (${shown}) — pick two colours closer in lightness`);
      }
    }
  }
  if (input.logoBytes !== null && input.logoBytes > HEAVY_LOGO_BYTES) {
    hints.push("This logo is over 200 KB, so it may load slowly — a smaller PNG or JPG is better");
  }
  if (!accentFor({ accentColor: input.accentColor }, "link")) hints.push(LINK_HINT);
  if (stops.some((bg) => readableOn(bg) === "#000000")) hints.push(DARK_MODE_HINT);
  if (fontHint) hints.push(fontHint);
  return hints;
}

/** "A", "A and B", "A, B and C". */
function andList(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The theme's web fonts (heading first, each once), and the safe fonts most inboxes show instead; null with none. */
function webFontHint(theme: { headingFont: EmailFontId; bodyFont: EmailFontId; webFonts: boolean }): string | null {
  const web = [...new Set([theme.headingFont, theme.bodyFont])].filter(isWebFont).map((id) => EMAIL_FONTS[id]);
  if (!web.length) return null;
  const names = andList(web.map((f) => f.label));
  const fallbacks = andList([...new Set(web.map((f) => f.web!.fallback))]);
  return theme.webFonts
    ? `Gmail, Outlook.com and most other inboxes show ${fallbacks} in place of ${names} — see “As Gmail & Outlook.com see it”`
    : `Web fonts aren't switched on yet, so every inbox shows ${fallbacks} in place of ${names}`;
}

/** Where the picked logo is: none picked, being measured, failed to load, or measured. */
export type LogoState = "none" | "checking" | "failed" | "ready";

/**
 * The logo a Save sends, and what holds the Save back. In Colour mode, as ever: the measured
 * logo, else the one kept while the list is unavailable, and a logo still checking or failed
 * blocks the Save (the Logo fieldset says why). In Image mode that fieldset is hidden, but the
 * logo is kept for the colour header: one still checking holds the Save (the page says so by
 * Save), and one that won't load sends the SAVED logo unchanged (the server re-checks it)
 * rather than block a Save for a reason the admin can't see, and never becomes null in place
 * of a saved logo. Switching back to Colour shows the failure as usual.
 */
export function logoForSave(input: {
  imageMode: boolean;
  logoState: LogoState;
  /** The picked logo with its measured size; null until it's measured. */
  measured: EmailStyleLogo | null;
  /** The saved logo, kept as it is while the logo list is unavailable; else null. */
  kept: EmailStyleLogo | null;
  saved: Pick<EmailStyleInput, "logo"> | null;
}): { logo: EmailStyleLogo | null; blocked: "checking" | "failed" | null } {
  const logo = input.measured ?? input.kept;
  if (!input.imageMode) {
    return {
      logo,
      blocked: input.logoState === "checking" || input.logoState === "failed" ? input.logoState : null,
    };
  }
  if (input.logoState === "checking") return { logo, blocked: "checking" };
  if (input.logoState === "failed") return { logo: input.saved?.logo ?? null, blocked: null };
  return { logo, blocked: null };
}

/** The form's Header choice: Colour or Image, and the banner picked for Image. */
export interface HeaderChoice {
  headerMode: "colour" | "image";
  headerImageId: string | null;
}

/**
 * The form's Header choice after a banner is deleted. A form that hadn't picked it is
 * unchanged. One that had goes back to the saved style's header (`saved`, as the form shows
 * the saved style): Colour when the delete cleared the saved style's banner (`cleared`), else
 * the saved banner the delete left alone — so a later Save doesn't quietly drop it — or Colour
 * when the saved style has none. A form on Colour stays on Colour.
 */
export function headerAfterDelete<D extends HeaderChoice>(
  draft: D,
  deleted: { id: string; cleared: boolean },
  saved: HeaderChoice,
): D {
  if (draft.headerImageId !== deleted.id) return draft;
  const back: HeaderChoice =
    deleted.cleared || saved.headerImageId === deleted.id ? { headerMode: "colour", headerImageId: null } : saved;
  return {
    ...draft,
    headerMode: draft.headerMode === "image" ? back.headerMode : "colour",
    headerImageId: back.headerImageId,
  };
}

/** A made-up Colour 2 differs from the header by at least this contrast, so the fade shows. */
const GRADIENT_STEP = 1.5;

/**
 * What Colour 2 starts as when Gradient is ticked: the first brand colour that isn't the
 * header colour, else the header colour 30% darker — or 30% lighter for a dark header, where
 * darker barely shows (below 1.5:1 against it) — so the band always fades to something.
 */
export function secondColourDefault(palette: readonly PaletteChip[], headerColor: string): string {
  const header = normalizeHex(headerColor) ?? "#111111";
  // Chips are already #rrggbb (paletteChips).
  const chip = palette.find((c) => c.hex !== header);
  if (chip) return chip.hex;
  const channels = [1, 3, 5].map((i) => parseInt(header.slice(i, i + 2), 16));
  const mix = (toward: number) =>
    `#${channels.map((c) => Math.round(c + (toward - c) * 0.3).toString(16).padStart(2, "0")).join("")}`;
  const darker = mix(0);
  return contrastRatio(darker, header) >= GRADIENT_STEP ? darker : mix(255);
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

/**
 * What Save sends (before `fromSuggestion`), key for key. The header options' keys come only
 * with `headerOptions`, and then always: null = solid, "auto" = Auto, a null image = the colour
 * header; an undefined `headerImage` (no image list) leaves the image out, so the server keeps
 * it. The theme comes only with `themes` (EMAIL_THEMES_ENABLED), compacted as it's stored (null =
 * Classic with the system font). With both off, it's the body the page sent before either.
 */
export function emailStyleSaveInput(
  draft: {
    companyName: string;
    headerColor: string;
    accentColor: string;
    gradient: boolean;
    headerColor2: string;
    headerText: HeaderTextChoice;
    theme: FormTheme;
  },
  opts: {
    logo: EmailStyleLogo | null;
    headerOptions: boolean;
    headerImage?: EmailStyleHeaderImage | null;
    themes: boolean;
  },
): EmailStyleInput {
  return {
    logo: opts.logo,
    companyName: cleanCompanyName(draft.companyName),
    headerColor: draft.headerColor,
    accentColor: draft.accentColor,
    ...(opts.headerOptions
      ? {
          headerGradientColor: draft.gradient ? draft.headerColor2 : null,
          headerText: draft.headerText,
          ...(opts.headerImage !== undefined ? { headerImage: opts.headerImage } : {}),
        }
      : {}),
    ...(opts.themes ? { theme: compactTheme(draft.theme) } : {}),
  };
}

// ── Theme (EMAIL_THEMES_ENABLED) ─────────────────────────────────────────────

/** A theme as the form holds it: a look and both fonts, filled in (a stored one leaves out the look's own). */
export interface FormTheme {
  preset: EmailThemePreset;
  headingFont: EmailFontId;
  bodyFont: EmailFontId;
}

/** A look with its own fonts: what picking its tile gives. */
export function presetTheme(preset: EmailThemePreset): FormTheme {
  const spec = EMAIL_THEME_PRESET_SPECS[preset];
  return { preset, headingFont: spec.headingFont, bodyFont: spec.bodyFont };
}

/**
 * A saved theme as the form holds it: a font left out is the look's own, as it is in emails.
 * None, or one it can't read, is Classic with the system font (today's look).
 */
export function themeForForm(theme: Partial<EmailTheme> | null | undefined): FormTheme {
  if (!theme || !isEmailThemePreset(theme.preset)) return presetTheme("classic");
  const own = presetTheme(theme.preset);
  return {
    preset: theme.preset,
    headingFont: isEmailFontId(theme.headingFont) ? theme.headingFont : own.headingFont,
    bodyFont: isEmailFontId(theme.bodyFont) ? theme.bodyFont : own.bodyFont,
  };
}

export const sameTheme = (a: FormTheme, b: FormTheme) =>
  a.preset === b.preset && a.headingFont === b.headingFont && a.bodyFont === b.bodyFont;

/** A theme by name, as Vizzy's card and the suggestion banner give it: "Modern (Inter / Inter)"; none is Classic. */
export function themeLabel(theme: Partial<EmailTheme> | null | undefined): string {
  const { preset, headingFont, bodyFont } = themeForForm(theme);
  return `${EMAIL_THEME_PRESET_SPECS[preset].label} (${EMAIL_FONTS[headingFont].label} / ${EMAIL_FONTS[bodyFont].label})`;
}

/**
 * A font as the pickers list it, with where it shows: a safe font in every inbox; a web font
 * only in the few that load one (the rest show its safe font), or, while web fonts are off, in none.
 */
export function emailFontOption(id: EmailFontId, webFonts: boolean): string {
  const font = EMAIL_FONTS[id];
  if (!font.web) return `${font.label} — All inboxes`;
  return webFonts
    ? `${font.label} — Apple Mail & Outlook for Mac · others see ${font.web.fallback}`
    : `${font.label} — shows as ${font.web.fallback} for now`;
}

/** The page's own family name for a web font, so nothing else on the page picks up its @font-face. */
const pageFamily = (family: string) => `Email ${family}`;

/**
 * The page's @font-face rules for the web fonts, bold only (the tiles' "Aa"), from this origin's
 * /email-fonts/. A browser only fetches a file once something on the page uses its family.
 */
export function pageWebFontFaces(): string {
  return EMAIL_FONT_LIST.flatMap((f) =>
    f.web
      ? [
          `@font-face{font-family:'${pageFamily(f.web.family)}';font-style:normal;font-weight:700;` +
            `src:url(${emailFontFileUrl("", f.id, 700, "woff2")}) format('woff2');font-display:swap}`,
        ]
      : [],
  ).join("\n");
}

/** A font as the page draws it: a web font's own family first when web fonts are on (see pageWebFontFaces), then its safe stack. */
export function pageFontStack(id: EmailFontId, webFonts: boolean): string {
  const font = EMAIL_FONTS[id];
  return webFonts && font.web ? `'${pageFamily(font.web.family)}',${font.safeStack}` : font.safeStack;
}

/** Weight and style words a family name may end in ("Montserrat Semi Bold", "Lora Italic"). */
const STYLE_WORDS = new Set([
  "thin",
  "hairline",
  "extra",
  "ultra",
  "semi",
  "demi",
  "light",
  "extralight",
  "ultralight",
  "regular",
  "normal",
  "book",
  "medium",
  "semibold",
  "demibold",
  "bold",
  "extrabold",
  "ultrabold",
  "black",
  "heavy",
  "italic",
  "oblique",
]);

/** The email font a brand font family names, by its name or id, ignoring case and weight words; null = none. */
export function emailFontForFamily(family: string): EmailFontId | null {
  const words = family.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  while (words.length > 1 && STYLE_WORDS.has(words[words.length - 1]!)) words.pop();
  const key = words.join(" ");
  if (!key) return null;
  return EMAIL_FONT_LIST.find((f) => f.label.toLowerCase() === key || f.id.replace(/-/g, " ") === key)?.id ?? null;
}

/** "Use brand fonts": the email fonts Brand's fonts map to, and why any don't. */
export interface BrandFontsForEmail {
  /** null = Brand has none for it, or none email can use: the form keeps its own. */
  headingFont: EmailFontId | null;
  bodyFont: EmailFontId | null;
  notes: string[];
}

const NO_BRAND_FONTS = "No brand fonts yet — add text styles in Brand › Fonts";
const NOT_FOR_EMAIL = "isn't available for email yet, so";

/** Whether a note is one of brandFontsToEmail's: Vizzy's suggestion keeps them apart from its logo notes. */
export function isBrandFontNote(note: string): boolean {
  return note === NO_BRAND_FONTS || note.includes(`” ${NOT_FOR_EMAIL} `);
}

const HEADING_ROLES: readonly TextStyleRole[] = ["heading", "title"];
const BODY_ROLES: readonly TextStyleRole[] = ["body"];

/**
 * "Use brand fonts": Brand › Fonts' text styles (a Heading, else a Title, style → the heading
 * font; a Body style → the body font), then the fonts read from the brand guidelines (the first
 * for headings, the second, else the first, for text). A brand with one font uses it for both.
 * A font email doesn't have, uploaded ones included, keeps the form's, with a note.
 */
export function brandFontsToEmail(
  typography: { styles?: readonly TextStyle[] | null } | null | undefined,
  kitFonts: readonly string[] | null | undefined,
): BrandFontsForEmail {
  const styles = typography?.styles ?? [];
  const styled = (roles: readonly TextStyleRole[]) => {
    for (const role of roles) {
      const family = styles.find((s) => s.role === role && s.fontFamily?.trim())?.fontFamily?.trim();
      if (family) return family;
    }
    return null;
  };
  const kit = (kitFonts ?? []).map((f) => f.trim()).filter(Boolean);
  const styledHeading = styled(HEADING_ROLES);
  const styledBody = styled(BODY_ROLES);
  const heading = styledHeading ?? kit[0] ?? styledBody;
  const body = styledBody ?? kit[1] ?? kit[0] ?? styledHeading;
  if (!heading || !body) {
    return { headingFont: null, bodyFont: null, notes: [NO_BRAND_FONTS] };
  }
  const headingFont = emailFontForFamily(heading);
  const bodyFont = emailFontForFamily(body);
  const missing = new Map<string, string[]>();
  if (!headingFont) missing.set(heading, ["headings"]);
  if (!bodyFont) missing.set(body, [...(missing.get(body) ?? []), "text"]);
  const notes = [...missing].map(
    ([family, uses]) =>
      `“${family}” ${NOT_FOR_EMAIL} ${andList(uses)} ${uses.join() === "text" ? "keeps" : "keep"} the current font`,
  );
  return { headingFont, bodyFont, notes };
}
