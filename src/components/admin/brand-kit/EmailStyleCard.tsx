"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  EMAIL_THEME_PRESETS,
  EmailStyleInputSchema,
  HEADER_TEXT_CHOICES,
  type EmailFontId,
  type EmailStyleInput,
  type EmailThemePreset,
  type HeaderTextChoice,
} from "@/lib/types/tenant";
import type { BrandLogo } from "@/lib/types/brandLogo";
import {
  BRAND_KIT_LOGOS_ROUTE,
  brandLogoAbsoluteUrl,
  brandLogoPublicUrl,
  emailHeaderImageAbsoluteUrl,
  emailHeaderImagePublicUrl,
} from "@/lib/content/brandKit";
import { normalizeHex } from "@/lib/content/create/colorPalette";
import {
  bandStops,
  cleanCompanyName,
  isEmailLogo,
  isHeaderImageUrlShape,
  isLogoUrlShape,
  resolveStoredStyle,
  type BrandKitEmailStyle,
} from "@/lib/email/emailStyle";
import { EMAIL_FONT_LIST, isEmailFontId } from "@/lib/email/emailFonts";
import { EMAIL_THEME_PRESET_SPECS, PILL_RADIUS, compactTheme, tint } from "@/lib/email/emailThemes";
import { renderLifecycleEmail, type RenderValues } from "@/lib/lifecycle/render";
import {
  averageInk,
  brandKitWithLogo,
  buttonColourHint,
  emailFontOption,
  emailStyleHints,
  emailStyleSaveInput,
  fitLogoSize,
  headerAfterDelete,
  logoForSave,
  pageFontStack,
  pageWebFontFaces,
  presetTheme,
  sameTheme,
  secondColourDefault,
  suggestionForReview,
  themeForForm,
  themeLabel,
  type BrandFontsForEmail,
  type EmailStyleLogoChoice,
  type FormTheme,
  type PaletteChip,
  type PendingEmailStyleSuggestion,
} from "./emailStyleForm";
import { hasWhiteBackground } from "./logoCleanup";
import { LogoCleanupPanel } from "./LogoCleanupPanel";
import { HeaderImagePicker } from "./HeaderImagePicker";
import type { EmailHeaderImageChoice } from "./headerImage";

/**
 * Brand › Email style: the header band (logo, optional company name, header colour) and the
 * button colour that branded emails wear, plus, with the header options on, a gradient and
 * the header text colour, an admin's logo clean-up (a new, transparent or white copy of
 * the picked logo, saved to Brand › Logos), and a Header choice: Colour (all of that) or
 * Image (a banner uploaded here, on the header colour, in place of the logo and name; the
 * colour-header fields are hidden but kept). "Use brand kit" fills it in from Brand; nothing
 * changes until an admin saves. The preview goes through the lifecycle renderer, so it matches
 * the send. A banner shows Vizzy's pending suggestion: Review loads it into the form and Save
 * applies it, or Dismiss drops it. Members see it all read-only.
 *
 * With themes on, a Theme section too: four looks (tiles drawn in each one's page colour, card,
 * button and heading font), a heading and a body font labelled with where each shows, and "Use
 * brand fonts" from Brand › Fonts. With web fonts on as well, the preview shows the email as
 * Apple Mail sees it (web fonts loaded) or as Gmail and Outlook.com do (their safe fonts).
 *
 * With layout buttons following the Email style, the Button colour hint says it colours the
 * buttons in Create email layouts too.
 */

const FIELD =
  "rounded-md border border-neutral-300 px-3 py-2 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900";
const INPUT = `w-full ${FIELD}`;
const LABEL = "block text-sm font-medium";
const HINT = "text-xs text-neutral-500";
const BTN =
  "rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700";
const SWATCH =
  "h-9 w-12 shrink-0 cursor-pointer rounded border border-neutral-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700";
const ERROR = "text-xs text-red-600 dark:text-red-400";

/** Subtle checkerboard so transparent (PNG) logos read as transparent (as in LogosGallery). */
const CHECKER: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg,#00000010 25%,transparent 25%,transparent 75%,#00000010 75%,#00000010)," +
    "linear-gradient(45deg,#00000010 25%,transparent 25%,transparent 75%,#00000010 75%,#00000010)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0,8px 8px",
};

const HEX_TYPED = /^#?[0-9a-f]{6}$/i;

interface Draft {
  logoId: string | null;
  companyName: string;
  headerColor: string;
  accentColor: string;
  /** The header options (only shown and sent with `headerOptions`). Colour 2 is kept while unticked. */
  gradient: boolean;
  headerColor2: string;
  headerText: HeaderTextChoice;
  /** Colour (logo and name on the header colour) or Image (a banner). The picked banner is kept in Colour. */
  headerMode: "colour" | "image";
  headerImageId: string | null;
  /** The look and its fonts (only shown and sent with `themes`). */
  theme: FormTheme;
}

/** Nothing saved yet: no logo, no name, today's near-black, solid, Auto text, the colour header, Classic. */
const BLANK: Draft = {
  logoId: null,
  companyName: "",
  headerColor: "#111111",
  accentColor: "#111111",
  gradient: false,
  headerColor2: "",
  headerText: "auto",
  headerMode: "colour",
  headerImageId: null,
  theme: presetTheme("classic"),
};

const HEADER_TEXT_LABELS: Record<HeaderTextChoice, string> = { auto: "Auto", white: "White", black: "Black" };

interface LogoSample {
  width: number;
  height: number;
  /** The average colour of the logo's opaque pixels; null when the canvas couldn't be read. */
  ink: string | null;
  /** Its corners are opaque white (the clean-up hint); null when not known, as for `ink`. */
  whiteBackground: boolean | null;
}

/**
 * `logos` (and `images`) is null when the list couldn't be loaded: the saved logo (or header
 * image) is kept, not taken as deleted. A saved header image that's since been deleted leaves
 * Image mode with none picked, so Save asks for one (or Colour).
 */
function toDraft(
  style: EmailStyleInput | null,
  logos: readonly EmailStyleLogoChoice[] | null,
  images: readonly EmailHeaderImageChoice[] | null,
): Draft {
  if (!style) return BLANK;
  const logoId = style.logo?.id ?? null;
  const imageId = style.headerImage?.id ?? null;
  return {
    logoId: logoId && (!logos || logos.some((l) => l.id === logoId)) ? logoId : null,
    companyName: style.companyName ?? "",
    headerColor: style.headerColor,
    accentColor: style.accentColor,
    gradient: !!style.headerGradientColor,
    headerColor2: style.headerGradientColor ?? "",
    headerText: style.headerText ?? "auto",
    headerMode: style.headerImage ? "image" : "colour",
    headerImageId: imageId && (!images || images.some((i) => i.id === imageId)) ? imageId : null,
    theme: themeForForm(style.theme),
  };
}

const sameDraft = (a: Draft, b: Draft) =>
  a.logoId === b.logoId &&
  cleanCompanyName(a.companyName) === cleanCompanyName(b.companyName) &&
  a.headerColor === b.headerColor &&
  a.accentColor === b.accentColor &&
  a.gradient === b.gradient &&
  (!a.gradient || a.headerColor2 === b.headerColor2) &&
  a.headerText === b.headerText &&
  a.headerMode === b.headerMode &&
  (a.headerMode !== "image" || a.headerImageId === b.headerImageId) &&
  sameTheme(a.theme, b.theme);

/**
 * Load a logo from its same-origin URL (the logo route sends no CORS headers, so a canvas
 * can only read it same-origin) for its display size, average colour and whether it has a
 * white background. Null if it won't load; `ink` and `whiteBackground` are null if the canvas
 * can't be read, which just skips their hints.
 */
function sampleLogo(src: string): Promise<LogoSample | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const size = fitLogoSize(img.naturalWidth, img.naturalHeight);
      resolve(size ? { ...size, ...readPixels(img) } : null);
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Both from one small (64px) read of the logo. */
function readPixels(img: HTMLImageElement): Pick<LogoSample, "ink" | "whiteBackground"> {
  try {
    const scale = Math.min(1, 64 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d");
    if (!g) return { ink: null, whiteBackground: null };
    g.drawImage(img, 0, 0, w, h);
    const rgba = g.getImageData(0, 0, w, h).data;
    return { ink: averageInk(rgba), whiteBackground: hasWhiteBackground(rgba, w, h) };
  } catch {
    return { ink: null, whiteBackground: null }; // a tainted or unsupported canvas: no hints, never an error
  }
}

/**
 * The logos the card works from: those cleaned up here (newest first) ahead of the page's,
 * each once (a refresh after a reviewed Save sends the new ones too), with a primary pinned
 * here flagged.
 */
function mergeLogos(
  added: readonly EmailStyleLogoChoice[],
  logos: readonly EmailStyleLogoChoice[],
  pinned: string | null,
): EmailStyleLogoChoice[] {
  const seen = new Set<string>();
  const out: EmailStyleLogoChoice[] = [];
  for (const l of [...added, ...logos]) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    out.push(pinned && l.isPrimary !== (l.id === pinned) ? { ...l, isPrimary: l.id === pinned } : l);
  }
  return out;
}

/** Load a header image from its same-origin URL, once, to confirm it loads (its size comes from the row). */
function checkBanner(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0);
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

/** The header images the card works from: those uploaded here (newest first) ahead of the page's, each once, minus those deleted here. */
function mergeImages(
  added: readonly EmailHeaderImageChoice[],
  images: readonly EmailHeaderImageChoice[],
  removed: readonly string[],
): EmailHeaderImageChoice[] {
  const seen = new Set<string>(removed);
  const out: EmailHeaderImageChoice[] = [];
  for (const i of [...added, ...images]) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    out.push(i);
  }
  return out;
}

/** A short welcome email, rendered as a real branded lifecycle email. */
const SAMPLE_ITEM = {
  subject: "Welcome",
  previewText: "Two quick steps to get started",
  format: "branded" as const,
  layout: null,
  body: "Hi {{user.first_name|there}},\n\nThanks for signing up. Here's how to get started:\n\n{{block.checklist}}\n\n{{block.next_step}}",
};

function sampleValues(brand: string): RenderValues {
  return {
    user: { id: "preview", first_name: "Alex", email: "alex@example.com" },
    product: { name: brand },
    traits: {},
    facts: [],
    nextStep: { label: "Finish setting up", url: "https://example.com/start" },
    checklist: [
      { label: "Create your account", done: true, url: null },
      { label: "Invite your team", done: false, url: "https://example.com/team" },
    ],
    insight: null,
    footer: { brand, unsubscribeUrl: "#", managePreferencesUrl: "#", privacyUrl: "#", postalAddress: null },
  };
}

export function EmailStyleCard({
  initial,
  pending,
  logos,
  fromBrandKit,
  palette,
  fallbackName,
  tenantId,
  logoOrigin,
  canEdit,
  logosUnavailable,
  headerOptions,
  headerImages,
  headerImagesUnavailable,
  headerImageOrigin,
  themes,
  webFonts,
  fontOrigin,
  fromBrandFonts,
  layouts = false,
}: {
  /** The saved style; null = none, so emails have today's look. */
  initial: EmailStyleInput | null;
  /**
   * Vizzy's pending suggestion. Read from props (not copied into state), so when a chat card
   * refreshes the page the banner updates without wiping unsaved edits.
   */
  pending: PendingEmailStyleSuggestion | null;
  /** This tenant's logos, newest first. The card adds any it cleans up. */
  logos: EmailStyleLogoChoice[];
  /** What "Use brand kit" fills in, before the logo is measured. */
  fromBrandKit: BrandKitEmailStyle;
  /** The brand's colours, as quick picks. */
  palette: PaletteChip[];
  /** The band's name when there's no logo and no company name (the footer's sender brand). */
  fallbackName: string;
  tenantId: string;
  /** The origin emails load the logo from; empty = the preview shows the name, as the send would. */
  logoOrigin: string;
  canEdit: boolean;
  /** Why there's no logo list — Logos is off, or it failed to load — so `logos` is empty but the saved logo may not be. */
  logosUnavailable: "off" | "failed" | false;
  /**
   * The header options (Gradient, Header text, logo clean-up, the Header choice) are on. Off,
   * the page is as without them: no controls, and Save sends none of their keys, so the server
   * keeps whatever is stored.
   */
  headerOptions: boolean;
  /** This tenant's usable header images, newest first (empty with the header options off). The card adds any uploaded here. */
  headerImages: EmailHeaderImageChoice[];
  /** The header images couldn't be loaded: the Header choice is locked, and Save leaves the stored one as it is. */
  headerImagesUnavailable: boolean;
  /** The origin emails load the header image from; empty = the preview shows the colour header, as the send would. */
  headerImageOrigin: string;
  /**
   * Themes are on (EMAIL_THEMES_ENABLED): the Theme section shows and Save sends `theme`. Off,
   * the page is as without them, and Save sends no theme key, so the server keeps what's stored.
   */
  themes: boolean;
  /** Web fonts are on too (EMAIL_WEB_FONTS_ENABLED): the preview can show them, and the tiles use them. */
  webFonts: boolean;
  /** The origin emails load web fonts from; empty = the preview shows the safe fonts, as the send would. */
  fontOrigin: string;
  /** What "Use brand fonts" fills in; null with themes off. */
  fromBrandFonts: BrandFontsForEmail | null;
  /** Layout buttons follow the Email style (EMAIL_LAYOUT_STYLE_ENABLED): only the Button colour hint changes. */
  layouts?: boolean;
}) {
  // Logos cleaned up here, and the primary the server kept in place when one was added.
  const [added, setAdded] = useState<EmailStyleLogoChoice[]>([]);
  const [pinned, setPinned] = useState<string | null>(null);
  const allLogos = useMemo(() => mergeLogos(added, logos, pinned), [added, logos, pinned]);
  const listed = logosUnavailable ? null : allLogos;
  // Header images uploaded or deleted here.
  const [addedImages, setAddedImages] = useState<EmailHeaderImageChoice[]>([]);
  const [removedImages, setRemovedImages] = useState<string[]>([]);
  const allImages = useMemo(
    () => mergeImages(addedImages, headerImages, removedImages),
    [addedImages, headerImages, removedImages],
  );
  // The Header choice works only with the list: without it, Save leaves the stored image alone.
  const imagesListed = headerOptions && !headerImagesUnavailable;
  const listedImages = headerImagesUnavailable ? null : allImages;
  const [saved, setSaved] = useState<EmailStyleInput | null>(initial);
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial, listed, listedImages));
  // With nothing saved, the preview shows today's look until the admin starts a style.
  const [started, setStarted] = useState(initial !== null);
  // The saved logo starts at its saved size, so the preview doesn't flicker while it's re-measured.
  const [samples, setSamples] = useState<Record<string, LogoSample | "failed">>(() =>
    initial?.logo
      ? { [initial.logo.id]: { width: initial.logo.width, height: initial.logo.height, ink: null, whiteBackground: null } }
      : {},
  );
  const sampling = useRef(new Map<string, Promise<LogoSample | null>>());
  // Header images loaded once each, to confirm they load.
  const [bannerChecks, setBannerChecks] = useState<Record<string, "ok" | "failed">>({});
  const bannerChecking = useRef(new Map<string, Promise<boolean>>());
  const [notes, setNotes] = useState<string[]>([]);
  // Why "Use brand fonts" left a font as it was, shown by its button.
  const [fontNotes, setFontNotes] = useState<string[]>([]);
  // The suggestion (by suggestedAt) loaded into the form, and the one applied or dismissed here.
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [handled, setHandled] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "kit" | "save" | "reset" | "dismiss" | "logo" | "image">(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The preview as Apple Mail sees it (web fonts loaded) or as Gmail and Outlook.com do.
  const [fontView, setFontView] = useState<"apple" | "gmail">("apple");

  const router = useRouter();
  const dirty = saved ? !sameDraft(draft, toDraft(saved, listed, listedImages)) : started;
  const suggestion = pending && pending.suggestedAt !== handled ? pending : null;

  // Save is explicit; warn before losing unsaved edits (as the Colours page does).
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  /** Measure a logo once; later calls share the first load. */
  const sample = useCallback(
    (logo: EmailStyleLogoChoice) => {
      let p = sampling.current.get(logo.id);
      if (!p) {
        p = sampleLogo(brandLogoPublicUrl(tenantId, logo.filename)).then((s) => {
          setSamples((prev) => ({ ...prev, [logo.id]: s ?? "failed" }));
          return s;
        });
        sampling.current.set(logo.id, p);
      }
      return p;
    },
    [tenantId],
  );

  /** Load a header image once; later calls share the first load. */
  const checkImage = useCallback(
    (image: { id: string; filename: string }) => {
      let p = bannerChecking.current.get(image.id);
      if (!p) {
        p = checkBanner(emailHeaderImagePublicUrl(tenantId, image.filename)).then((ok) => {
          setBannerChecks((prev) => ({ ...prev, [image.id]: ok ? "ok" : "failed" }));
          return ok;
        });
        bannerChecking.current.set(image.id, p);
      }
      return p;
    },
    [tenantId],
  );

  const selected = allLogos.find((l) => l.id === draft.logoId) ?? null;
  // With no list, the saved logo is offered as saved; Save sends it unchanged and the server re-checks it.
  const savedLogo = listed ? null : (saved?.logo ?? null);
  const kept = savedLogo && savedLogo.id === draft.logoId ? savedLogo : null;
  useEffect(() => {
    if (selected) void sample(selected);
  }, [selected, sample]);
  const measured = selected ? samples[selected.id] : undefined;
  const logoSample = measured && measured !== "failed" ? measured : null;
  const logoState = !selected ? "none" : !measured ? "checking" : measured === "failed" ? "failed" : "ready";

  // Image mode: the banner picked from the list, or, with no list, the saved one as it is.
  const imageMode = headerOptions && draft.headerMode === "image";
  const savedImage = saved?.headerImage ?? null;
  const pickedRow = imageMode ? (allImages.find((i) => i.id === draft.headerImageId) ?? null) : null;
  const pickedImage =
    pickedRow ?? (imageMode && !listedImages && savedImage && savedImage.id === draft.headerImageId ? savedImage : null);
  useEffect(() => {
    if (pickedImage) void checkImage(pickedImage);
  }, [pickedImage, checkImage]);
  const bannerCheck = pickedImage ? bannerChecks[pickedImage.id] : undefined;
  const imageState = !pickedImage ? "none" : !bannerCheck ? "checking" : bannerCheck === "failed" ? "failed" : "ready";
  const headerImage = pickedImage
    ? { id: pickedImage.id, filename: pickedImage.filename, width: pickedImage.width, height: pickedImage.height }
    : null;

  // The logo is kept for the colour header in Image mode too (logoForSave says how).
  const logoPlan = logoForSave({
    imageMode,
    logoState,
    measured:
      selected && logoSample
        ? { id: selected.id, filename: selected.filename, width: logoSample.width, height: logoSample.height }
        : null,
    kept,
    saved,
  });
  // The header options' keys, always, while they're on; with no image list, the image is left
  // out, so the server keeps it. The theme only while themes are on.
  const input = emailStyleSaveInput(draft, {
    logo: logoPlan.logo,
    headerOptions,
    headerImage: imagesListed ? headerImage : undefined,
    themes,
  });
  const check = EmailStyleInputSchema.safeParse(input);
  // Image mode holds Save until the picked banner has loaded (only when it's sent).
  const imageHold = imageMode && imagesListed && imageState !== "ready";
  // The header's colours as the band draws them, for the logo clean-up's tiles and hint.
  const stops = bandStops({ headerColor: draft.headerColor, headerGradientColor: input.headerGradientColor ?? undefined });
  const nameError = check.success ? null : (check.error.issues.find((i) => i.path[0] === "companyName")?.message ?? null);

  const previewStyle = started
    ? resolveStoredStyle(
        // The banner shows even when Save leaves it out (no list): it's the one stored.
        { ...input, headerImage, theme: compactTheme(draft.theme) },
        {
          logoUrlFor: (l) => {
            const url = logoOrigin ? brandLogoAbsoluteUrl(logoOrigin, tenantId, l.filename) : "";
            return url && isLogoUrlShape(url) ? url : null;
          },
          headerImageUrlFor: (i) => {
            const url = headerImageOrigin ? emailHeaderImageAbsoluteUrl(headerImageOrigin, tenantId, i.filename) : "";
            return url && isHeaderImageUrlShape(url) ? url : null;
          },
          fallbackName,
          headerOptions,
          themes,
          // "As Gmail & Outlook.com see it": no web fonts, as those inboxes show it.
          webFonts: webFonts && fontView === "apple",
          fontOrigin,
        },
      )
    : null;
  const previewHtml = renderLifecycleEmail({ item: SAMPLE_ITEM, values: sampleValues(fallbackName), style: previewStyle }).html;
  const header = !previewStyle
    ? "No header — today's look"
    : previewStyle.headerImage
      ? "Header: image"
      : previewStyle.logo
        ? previewStyle.name
          ? "Header: logo and name"
          : "Header: logo only"
        : "Header: name only";

  const hints = started
    ? emailStyleHints({
        logoBytes: selected?.byteSize ?? null,
        logoInk: logoSample?.ink ?? null,
        headerColor: draft.headerColor,
        accentColor: draft.accentColor,
        ...(headerOptions
          ? {
              headerGradientColor: input.headerGradientColor,
              headerText: draft.headerText,
              // As the band draws it: beside a logo only a company name shows; without one, the name.
              showsText: !!previewStyle && !!(previewStyle.logo ? previewStyle.name : previewStyle.altName),
            }
          : {}),
        // Image mode: the banner's hints in place of the logo and text ones.
        ...(imageMode
          ? {
              headerImage: pickedImage
                ? { width: pickedImage.width, height: pickedImage.height, byteSize: pickedRow?.byteSize ?? null }
                : null,
            }
          : {}),
        ...(themes
          ? { theme: { headingFont: draft.theme.headingFont, bodyFont: draft.theme.bodyFont, webFonts } }
          : {}),
      })
    : [];

  function edit(patch: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...patch }));
    setStarted(true);
    setStatus(null);
    setError(null);
  }

  async function applyBrandKit() {
    setBusy("kit");
    try {
      const logo = allLogos.find((l) => l.id === fromBrandKit.logoId) ?? null;
      const s = logo ? await sample(logo) : null;
      const kit = brandKitWithLogo(fromBrandKit, s?.ink ?? null);
      edit({
        // With no list, the logo stays as it is (and the kit's "No logos yet" note doesn't apply).
        ...(listed ? { logoId: kit.logoId } : {}),
        companyName: kit.companyName ?? "",
        headerColor: kit.headerColor,
        accentColor: kit.accentColor,
        // Brand has no gradient: back to solid, with Auto text.
        gradient: false,
        headerText: "auto",
        // Nor a banner: the colour header (left as it is when the image list couldn't be loaded).
        ...(imagesListed ? { headerMode: "colour" as const } : {}),
      });
      setNotes(listed ? kit.notes : []);
      setReviewing(null);
    } finally {
      setBusy(null);
    }
  }

  /** A look or font picked here: any "Use brand fonts" notes no longer apply. */
  function editTheme(theme: FormTheme) {
    edit({ theme });
    setFontNotes([]);
  }

  /** "Use brand fonts": the fonts Brand maps to, each only when email has it; the look stays as it is. */
  function applyBrandFonts() {
    if (!fromBrandFonts) return;
    const { headingFont, bodyFont, notes: why } = fromBrandFonts;
    if (headingFont || bodyFont) {
      edit({
        theme: {
          ...draft.theme,
          ...(headingFont ? { headingFont } : {}),
          ...(bodyFont ? { bodyFont } : {}),
        },
      });
      setStatus("Filled in your brand fonts. Save to use them in emails.");
    }
    setFontNotes(why);
  }

  /** A logo cleaned up here: it joins the list and is picked. The Email style changes on Save. */
  function addLogo(logo: BrandLogo) {
    const { id, filename, mimeType, isPrimary, createdAt, title, byteSize } = logo;
    setAdded((prev) => [{ id, filename, mimeType, isPrimary, createdAt, title, byteSize }, ...prev]);
    edit({ logoId: id });
    setStatus(`Added “${title}” to Brand › Logos and picked it. Save to use it in emails.`);
  }

  /** A banner uploaded here: it joins the list and is picked. The Email style changes on Save. */
  function addHeaderImage(image: EmailHeaderImageChoice) {
    setAddedImages((prev) => [image, ...prev]);
    edit({ headerMode: "image", headerImageId: image.id });
    setStatus(`Uploaded “${image.title}”. Save to use it in emails.`);
  }

  /**
   * A banner deleted here leaves the list. If the saved style used it, the server has put the
   * style back on its header colour (`cleared`), so the saved copy here follows; a form that
   * had it picked goes back to the saved header — Colour once cleared, else the saved banner
   * (headerAfterDelete).
   */
  function removeHeaderImage(id: string, cleared: boolean) {
    const title = allImages.find((i) => i.id === id)?.title;
    setRemovedImages((prev) => [...prev, id]);
    if (cleared) {
      setSaved((s) => {
        if (!s) return s;
        const { headerImage: _deleted, ...rest } = s;
        return rest;
      });
    }
    const savedHeader = toDraft(saved, listed, listedImages);
    setDraft((d) => headerAfterDelete(d, { id, cleared }, savedHeader));
    setError(null);
    setStatus(
      cleared ? "Deleted. Your emails use the header colour again." : title ? `Deleted “${title}”.` : "Deleted.",
    );
  }

  /**
   * Load Vizzy's suggestion into the form, as asked; the logo is measured and checked as usual.
   * Its header options too (the page only gets them with the options on): a solid suggestion
   * unticks Gradient and keeps Colour 2, as unticking does, and its header image picks Image
   * with that banner, or Colour with none (a deleted one is Colour, with a note). With themes
   * on, its theme as well: none picks Classic with the system font.
   */
  function review(s: PendingEmailStyleSuggestion) {
    const r = suggestionForReview(
      s,
      allLogos,
      listed ? undefined : { savedLogoId: savedLogo?.id ?? null, logosOff: logosUnavailable === "off" },
      headerOptions ? { images: listedImages, savedImageId: savedImage?.id ?? null } : undefined,
      themes,
    );
    edit({
      logoId: r.logoId,
      companyName: r.companyName ?? "",
      headerColor: r.headerColor,
      accentColor: r.accentColor,
      gradient: r.headerGradientColor !== null,
      ...(r.headerGradientColor ? { headerColor2: r.headerGradientColor } : {}),
      headerText: r.headerText,
      // Colour keeps the picked banner, as switching to Colour does.
      ...(r.headerImageId === undefined
        ? {}
        : r.headerImageId
          ? { headerMode: "image" as const, headerImageId: r.headerImageId }
          : { headerMode: "colour" as const }),
      ...(r.theme ? { theme: r.theme } : {}),
    });
    setNotes(r.notes);
    setFontNotes([]);
    setReviewing(s.suggestedAt);
  }

  async function dismiss(s: PendingEmailStyleSuggestion) {
    setBusy("dismiss");
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/admin/brand-kit/email-style/suggestion", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestedAt: s.suggestedAt }),
      });
      const data = (await res.json().catch(() => ({}))) as { cleared?: boolean };
      if (!res.ok) {
        setError(res.status === 403 ? "Only an admin can dismiss a suggestion." : "Couldn't dismiss — try again.");
        return;
      }
      setHandled(s.suggestedAt);
      if (reviewing === s.suggestedAt) {
        // Back to the saved style.
        setReviewing(null);
        setDraft(toDraft(saved, listed, listedImages));
        setStarted(saved !== null);
        setNotes([]);
      }
      if (data.cleared) {
        setStatus("Suggestion dismissed. Your Email style hasn't changed.");
      } else {
        // It had already gone or been replaced: fetch whatever is pending now.
        router.refresh();
      }
    } catch {
      setError("Couldn't dismiss — try again.");
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!check.success) return;
    setBusy("save");
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/admin/brand-kit/email-style", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // Saving a reviewed suggestion also clears it, if it's still the pending one.
        body: JSON.stringify(reviewing ? { ...check.data, fromSuggestion: reviewing } : check.data),
      });
      const data = (await res.json().catch(() => ({}))) as {
        emailStyle?: EmailStyleInput;
        error?: string;
        message?: string;
        issues?: Array<{ message: string }>;
      };
      if (!res.ok || !data.emailStyle) {
        setError(
          res.status === 403
            ? "Only an admin can change the Email style."
            : data.error === "invalid_logo" && imageMode
              ? // The Logo fieldset is hidden, so say where to fix it.
                "The logo kept for your colour header can't be used any more — switch to Colour and pick another, or No logo."
              : (data.message ?? data.issues?.[0]?.message ?? "Couldn't save — try again."),
        );
        return;
      }
      setSaved(data.emailStyle);
      setDraft(toDraft(data.emailStyle, listed, listedImages));
      setNotes([]);
      setFontNotes([]);
      if (reviewing) {
        setHandled(reviewing);
        // A newer suggestion survives the Save, and this page can't tell: fetch whatever is pending now.
        router.refresh();
      }
      setReviewing(null);
      setStatus("Saved. Branded emails use this style from now on.");
    } catch {
      setError("Couldn't save — try again.");
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    if (!window.confirm("Reset to default? Your emails go back to today's look, with no header.")) return;
    setBusy("reset");
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/admin/brand-kit/email-style", { method: "DELETE" });
      if (!res.ok) {
        setError(res.status === 403 ? "Only an admin can change the Email style." : "Couldn't reset — try again.");
        return;
      }
      setSaved(null);
      setDraft(BLANK);
      setStarted(false);
      setNotes([]);
      setFontNotes([]);
      setReviewing(null);
      setStatus("Reset. Your emails have today's look.");
    } catch {
      setError("Couldn't reset — try again.");
    } finally {
      setBusy(null);
    }
  }

  const disabled = !canEdit || busy !== null;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {suggestion ? (
        <SuggestionBanner
          suggestion={suggestion}
          logoTitle={
            allLogos.find((l) => l.id === suggestion.logoId)?.title ??
            (savedLogo && savedLogo.id === suggestion.logoId ? "Current logo" : null)
          }
          logosUnavailable={logosUnavailable}
          headerImageTitle={
            allImages.find((i) => i.id === suggestion.headerImageId)?.title ??
            (headerImagesUnavailable && savedImage && savedImage.id === suggestion.headerImageId ? "Current header image" : null)
          }
          headerImagesUnavailable={headerImagesUnavailable}
          theme={
            // Named when it has one, or would take the saved one away (the page only gets it with themes on).
            themes && (suggestion.theme || saved?.theme) ? themeLabel(suggestion.theme) : null
          }
          canEdit={canEdit}
          reviewing={reviewing === suggestion.suggestedAt}
          disabled={busy !== null}
          onReview={() => review(suggestion)}
          onDismiss={() => void dismiss(suggestion)}
        />
      ) : null}
      <div className="space-y-6">
        {canEdit ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-neutral-300 p-3 dark:border-neutral-700">
            <p className={HINT}>Fill it in from Brand: your logo and colours. Review, then Save.</p>
            <button type="button" onClick={applyBrandKit} disabled={disabled} className={`shrink-0 font-medium ${BTN}`}>
              {busy === "kit" ? "Filling in…" : "Use brand kit"}
            </button>
          </div>
        ) : (
          <p className="rounded-md border border-neutral-200 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
            Only admins can change the Email style.
          </p>
        )}
        {notes.length ? (
          <ul className="space-y-1 rounded-md border border-neutral-200 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
            {notes.map((n) => (
              <li key={n}>{n}.</li>
            ))}
          </ul>
        ) : null}

        {headerOptions ? (
          <fieldset className="space-y-2">
            <legend className={LABEL}>Header</legend>
            <p id="email-style-mode-hint" className={HINT}>
              {headerImagesUnavailable
                ? "Your header images couldn't be loaded — try again later."
                : "Colour: your logo and name on the header colour. Image: a banner of your own, full width."}
            </p>
            <div className="flex flex-wrap gap-4">
              {(["colour", "image"] as const).map((mode) => (
                <label
                  key={mode}
                  className={`flex items-center gap-2 text-sm ${
                    disabled || !imagesListed ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                  }`}
                >
                  <input
                    type="radio"
                    name="email-style-header-mode"
                    checked={draft.headerMode === mode}
                    disabled={disabled || !imagesListed}
                    aria-describedby="email-style-mode-hint"
                    onChange={() => edit({ headerMode: mode })}
                  />
                  {mode === "colour" ? "Colour" : "Image"}
                </label>
              ))}
            </div>
            {imageMode && imagesListed ? (
              <HeaderImagePicker
                images={allImages}
                selectedId={draft.headerImageId}
                inUseId={savedImage?.id ?? null}
                tenantId={tenantId}
                headerColor={draft.headerColor}
                canEdit={canEdit}
                disabled={disabled}
                onSelect={(id) => edit({ headerImageId: id })}
                onUploaded={addHeaderImage}
                onDeleted={removeHeaderImage}
                onBusy={(on) => setBusy(on ? "image" : null)}
              />
            ) : null}
            {imageMode && imagesListed && imageState === "none" ? (
              <p className={HINT}>Pick or upload a header image, or choose Colour.</p>
            ) : null}
            {imageMode && imagesListed && imageState === "checking" ? <p className={HINT}>Checking your image…</p> : null}
            {imageMode && imagesListed && imageState === "failed" ? (
              <p role="alert" className={ERROR}>
                We couldn&rsquo;t load this image. Pick another, or choose Colour.
              </p>
            ) : null}
          </fieldset>
        ) : null}

        {!imageMode ? (
          <fieldset className="space-y-2">
            <legend className={LABEL}>Logo</legend>
            <p className={HINT}>PNG or JPG. It sits on the header colour, up to 48 px tall.</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <LogoOption
                label="No logo"
                checked={!selected && !kept}
                disabled={disabled}
                onSelect={() => edit({ logoId: null })}
              />
              {savedLogo ? (
                <LogoOption
                  label="Current logo"
                  src={brandLogoPublicUrl(tenantId, savedLogo.filename)}
                  checked={kept !== null}
                  disabled={disabled}
                  onSelect={() => edit({ logoId: savedLogo.id })}
                />
              ) : null}
              {allLogos.map((l) => {
                const usable = isEmailLogo(l);
                return (
                  <LogoOption
                    key={l.id}
                    label={l.title}
                    src={brandLogoPublicUrl(tenantId, l.filename)}
                    badge={l.isPrimary ? "Primary" : undefined}
                    reason={usable ? undefined : l.mimeType === "image/webp" ? "WebP — Outlook can't show it" : "Email needs a PNG or JPG"}
                    checked={selected?.id === l.id}
                    disabled={disabled || !usable}
                    onSelect={() => edit({ logoId: l.id })}
                  />
                );
              })}
            </div>
            {logosUnavailable === "off" ? (
              <p className={HINT}>Logos aren&rsquo;t switched on in this environment, so emails show your name in the header.</p>
            ) : !listed ? (
              <p className={HINT}>Your logos couldn&rsquo;t be loaded, so you can&rsquo;t pick another right now. Try again later.</p>
            ) : allLogos.length === 0 ? (
              <p className={HINT}>
                No logos yet — add a PNG or JPG in{" "}
                <Link href={BRAND_KIT_LOGOS_ROUTE} className="underline underline-offset-2">
                  Brand › Logos
                </Link>
                .
              </p>
            ) : null}
            {logoState === "checking" ? <p className={HINT}>Checking your logo…</p> : null}
            {logoState === "failed" ? (
              <p role="alert" className={ERROR}>
                We couldn&rsquo;t load this logo. Pick another, or choose No logo.
              </p>
            ) : null}
            {headerOptions && canEdit && listed && selected && isEmailLogo(selected) && logoState !== "failed" ? (
              <LogoCleanupPanel
                key={selected.id}
                logo={selected}
                tenantId={tenantId}
                stops={stops}
                whiteBackground={logoSample?.whiteBackground ?? null}
                disabled={disabled}
                onBusy={(on) => setBusy(on ? "logo" : null)}
                onPrimaryPinned={setPinned}
                onAdded={addLogo}
              />
            ) : null}
          </fieldset>
        ) : null}

        <div className="space-y-1">
          <label htmlFor="email-style-name" className={LABEL}>
            Company name <span className="font-normal text-neutral-500">(optional)</span>
          </label>
          <p id="email-style-name-hint" className={HINT}>
            {imageMode
              ? `Shown in place of the image when images are off, or “${fallbackName}” if it's blank.`
              : selected
                ? "Shown beside your logo. Leave blank if your logo already shows your name."
                : `With no logo, the header shows this name, or “${fallbackName}” if it's blank.`}
          </p>
          <input
            id="email-style-name"
            className={INPUT}
            maxLength={80}
            value={draft.companyName}
            disabled={disabled}
            aria-describedby="email-style-name-hint"
            aria-invalid={nameError ? true : undefined}
            onChange={(e) => edit({ companyName: e.target.value })}
          />
          {nameError ? (
            <p role="alert" className={ERROR}>
              {nameError}
            </p>
          ) : null}
        </div>

        <div className="space-y-3">
          <ColourField
            id="email-style-header"
            label="Header colour"
            hint={
              imageMode
                ? "Behind your image, and what readers see when images are off."
                : "Behind your logo at the top of each email."
            }
            value={draft.headerColor}
            chips={palette}
            disabled={disabled}
            onChange={(headerColor) => edit({ headerColor })}
          />
          {headerOptions && !imageMode ? (
            <label
              className={`flex w-fit items-center gap-2 text-sm ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
            >
              <input
                type="checkbox"
                checked={draft.gradient}
                disabled={disabled}
                onChange={(e) =>
                  edit(
                    e.target.checked
                      ? {
                          gradient: true,
                          // Keep a Colour 2 picked earlier; otherwise start from the brand colours.
                          headerColor2:
                            draft.headerColor2 && draft.headerColor2 !== draft.headerColor
                              ? draft.headerColor2
                              : secondColourDefault(palette, draft.headerColor),
                        }
                      : { gradient: false },
                  )
                }
              />
              Gradient
            </label>
          ) : null}
          {headerOptions && !imageMode && draft.gradient ? (
            <ColourField
              id="email-style-header-2"
              label="Colour 2"
              hint="Fades from the header colour (top left) to this one (bottom right). Outlook and Gmail on Android show the header colour alone, so make sure it works by itself."
              value={draft.headerColor2}
              chips={palette}
              disabled={disabled}
              onChange={(headerColor2) => edit({ headerColor2 })}
            />
          ) : null}
        </div>
        {headerOptions && !imageMode ? (
          <fieldset className="space-y-2">
            <legend className={LABEL}>Header text</legend>
            <p id="email-style-text-hint" className={HINT}>
              For your company name, and the logo&rsquo;s name when images are off. Auto picks black or white,
              whichever reads better.
            </p>
            <div className="flex flex-wrap gap-4">
              {HEADER_TEXT_CHOICES.map((choice) => (
                <label
                  key={choice}
                  className={`flex items-center gap-2 text-sm ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
                >
                  <input
                    type="radio"
                    name="email-style-header-text"
                    checked={draft.headerText === choice}
                    disabled={disabled}
                    aria-describedby="email-style-text-hint"
                    onChange={() => edit({ headerText: choice })}
                  />
                  {HEADER_TEXT_LABELS[choice]}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <ColourField
          id="email-style-button"
          label="Button colour"
          hint={buttonColourHint(layouts)}
          value={draft.accentColor}
          chips={palette}
          disabled={disabled}
          onChange={(accentColor) => edit({ accentColor })}
        />

        {themes ? (
          <ThemeFields
            theme={draft.theme}
            accentColor={draft.accentColor}
            webFonts={webFonts}
            canEdit={canEdit}
            disabled={disabled}
            onPreset={(preset) => editTheme(presetTheme(preset))}
            onFont={(role, id) => editTheme({ ...draft.theme, [role]: id })}
            onBrandFonts={fromBrandFonts ? applyBrandFonts : null}
            brandFontNotes={fontNotes}
          />
        ) : null}

        {hints.length ? (
          <ul className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            {hints.map((h) => (
              <li key={h}>{h}.</li>
            ))}
          </ul>
        ) : null}

        {canEdit ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={disabled || !(dirty || reviewing) || !check.success || logoPlan.blocked !== null || imageHold}
              className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              {busy === "save" ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={reset} disabled={disabled || !saved} className={BTN}>
              {busy === "reset" ? "Resetting…" : "Reset to default"}
            </button>
            {imageMode && logoPlan.blocked === "checking" ? (
              <span className={HINT}>Checking the logo kept for your colour header…</span>
            ) : null}
            <span role="status" className="text-xs text-neutral-500">
              {status}
            </span>
            {error ? (
              <span role="alert" className={ERROR}>
                {error}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="space-y-2 lg:sticky lg:top-4 lg:self-start">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">Preview</h2>
          <span className={HINT}>
            {header}
            {dirty ? " · not saved yet" : ""}
          </span>
        </div>
        {themes && webFonts ? (
          <div role="group" aria-label="Preview as" className="flex flex-wrap gap-1.5">
            {(
              [
                ["apple", "As Apple Mail sees it"],
                ["gmail", "As Gmail & Outlook.com see it"],
              ] as const
            ).map(([view, label]) => (
              <button
                key={view}
                type="button"
                aria-pressed={fontView === view}
                onClick={() => setFontView(view)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  fontView === view
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                    : "border-neutral-300 dark:border-neutral-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
        <iframe
          title="Preview of a branded email"
          sandbox=""
          srcDoc={previewHtml}
          className="h-[480px] w-full rounded-md border border-neutral-200 bg-white dark:border-neutral-800"
        />
        <p className={HINT}>A sample welcome email. Letters stay plain, with no header.</p>
        {themes && webFonts && fontView === "gmail" ? (
          <p className={HINT}>Outlook for Windows also shows square corners.</p>
        ) : null}
      </div>
    </div>
  );
}

/** Vizzy's pending suggestion: what it would change, and (for admins) Review and Dismiss. */
function SuggestionBanner({
  suggestion,
  logoTitle,
  logosUnavailable,
  headerImageTitle,
  headerImagesUnavailable,
  theme,
  canEdit,
  reviewing,
  disabled,
  onReview,
  onDismiss,
}: {
  suggestion: PendingEmailStyleSuggestion;
  /** The suggested logo's name; null when there's none, or it's been deleted or couldn't be loaded. */
  logoTitle: string | null;
  /** Logos is off, or the list couldn't be loaded, so a logo missing from it isn't known to be deleted. */
  logosUnavailable: "off" | "failed" | false;
  /** The suggested header image's name; null when there's none, or it's been deleted or couldn't be loaded. */
  headerImageTitle: string | null;
  /** The header images couldn't be loaded, so one missing from the list isn't known to be deleted. */
  headerImagesUnavailable: boolean;
  /** The suggested theme by name ("Modern (Inter / Inter)"); null = not named (themes off, or no change from none). */
  theme: string | null;
  canEdit: boolean;
  /** It's loaded into the form. */
  reviewing: boolean;
  disabled: boolean;
  onReview: () => void;
  onDismiss: () => void;
}) {
  // A banner that's still there: it ignores the gradient and a forced text colour, so neither is
  // shown, as Vizzy's card has it. A deleted one reviews as Colour, where both apply.
  const banner = !!suggestion.headerImageId && (headerImageTitle !== null || headerImagesUnavailable);
  return (
    <section
      aria-label="Email style suggestion"
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-neutral-300 bg-neutral-50 px-4 py-3 text-sm text-neutral-700 lg:col-span-2 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
    >
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-neutral-900 dark:text-neutral-100">
          Vizzy suggested an Email style{suggestion.source === "brand_kit" ? " from your brand kit" : ""}
        </p>
        {suggestion.brief ? (
          <p className={`truncate ${HINT}`} title={suggestion.brief}>
            &ldquo;{suggestion.brief}&rdquo;
          </p>
        ) : null}
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {banner ? null : (
            <SwatchLabel hex={suggestion.headerColor} to={suggestion.headerGradientColor} label="Header" />
          )}
          {suggestion.headerImageId ? (
            <span>
              Header image:{" "}
              {headerImageTitle ?? (headerImagesUnavailable ? "one that couldn't be loaded" : "one that's been deleted")}
            </span>
          ) : null}
          {banner ? <SwatchLabel hex={suggestion.headerColor} label="Behind image" /> : null}
          {!banner && suggestion.headerText ? <span>Text: {suggestion.headerText}</span> : null}
          <SwatchLabel hex={suggestion.accentColor} label="Button" />
          {theme ? <span>Theme: {theme}</span> : null}
          <span>
            Logo:{" "}
            {suggestion.logoId
              ? (logoTitle ??
                (logosUnavailable === "off"
                  ? "not shown, as Logos isn't switched on"
                  : logosUnavailable
                    ? "one that couldn't be loaded"
                    : "one that's been deleted"))
              : "none"}
          </span>
          {suggestion.companyName ? <span>Name: {suggestion.companyName}</span> : null}
        </p>
      </div>
      {canEdit ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {reviewing ? (
            <span className={HINT}>Loaded below — Save to apply it.</span>
          ) : (
            <button type="button" onClick={onReview} disabled={disabled} className={`font-medium ${BTN}`}>
              Review
            </button>
          )}
          <button type="button" onClick={onDismiss} disabled={disabled} className={BTN}>
            Dismiss
          </button>
        </div>
      ) : (
        <p className={HINT}>Nothing changes until an admin reviews and applies it.</p>
      )}
    </section>
  );
}

/** A colour, or with `to` a gradient from `hex` to it (as the band fades), with its hex codes. */
function SwatchLabel({ hex, to, label }: { hex: string; to?: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="h-3.5 w-3.5 rounded-sm border border-neutral-300 dark:border-neutral-700"
        style={to ? { backgroundColor: hex, backgroundImage: `linear-gradient(135deg,${hex},${to})` } : { backgroundColor: hex }}
      />
      {label} <span className="font-mono">{to ? `${hex} → ${to}` : hex}</span>
    </span>
  );
}

/** What each look is, under its tile. */
const PRESET_NOTES: Record<EmailThemePreset, string> = {
  classic: "Today's look",
  modern: "Rounded card, pill buttons",
  editorial: "Serif, square corners",
  friendly: "Round, on a tint of your button colour",
};

/**
 * The Theme section: the four looks as tiles (each drawn in its page colour, card corners,
 * button shape and heading font, with the button colour), the two fonts, and "Use brand fonts".
 * Picking a look gives its own fonts; the pickers change either after.
 */
function ThemeFields({
  theme,
  accentColor,
  webFonts,
  canEdit,
  disabled,
  onPreset,
  onFont,
  onBrandFonts,
  brandFontNotes,
}: {
  theme: FormTheme;
  /** The button colour: the tiles' buttons, and Friendly's page tint. */
  accentColor: string;
  webFonts: boolean;
  canEdit: boolean;
  disabled: boolean;
  onPreset: (preset: EmailThemePreset) => void;
  onFont: (role: "headingFont" | "bodyFont", id: EmailFontId) => void;
  /** null = nothing to fill it in from (themes off). */
  onBrandFonts: (() => void) | null;
  /** Why "Use brand fonts" left a font as it was. */
  brandFontNotes: string[];
}) {
  // The web fonts' bold faces, so each tile's "Aa" is in its heading font (only with web fonts on, as in emails).
  const faces = useMemo(() => (webFonts ? pageWebFontFaces() : ""), [webFonts]);
  return (
    <fieldset className="space-y-3">
      <legend className={LABEL}>Theme</legend>
      {faces ? <style dangerouslySetInnerHTML={{ __html: faces }} /> : null}
      <p id="email-style-theme-hint" className={HINT}>
        The look of every branded email: the page around it, its corners, button shape, spacing and fonts.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {EMAIL_THEME_PRESETS.map((preset) => {
          const spec = EMAIL_THEME_PRESET_SPECS[preset];
          const checked = theme.preset === preset;
          return (
            <label
              key={preset}
              className={`flex flex-col gap-2 rounded-md border p-2 text-sm ${
                checked ? "border-neutral-900 dark:border-neutral-100" : "border-neutral-200 dark:border-neutral-800"
              } ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-neutral-400 dark:hover:border-neutral-600"}`}
            >
              {/* A small email, at half size: the page, the card, "Aa" in the heading font, a button. */}
              <span
                aria-hidden
                className="grid h-16 place-items-center overflow-hidden rounded"
                style={{ backgroundColor: spec.page === "tint" ? tint(accentColor, 0.94) : spec.page }}
              >
                <span
                  className="flex w-3/4 flex-col items-start gap-1.5 px-2 py-2"
                  style={{ backgroundColor: "#ffffff", borderRadius: spec.cardRadius / 2 }}
                >
                  <span
                    className="text-base font-bold leading-none"
                    style={{ color: "#111111", fontFamily: pageFontStack(spec.headingFont, webFonts) }}
                  >
                    Aa
                  </span>
                  <span
                    className="block h-2.5 w-10"
                    style={{
                      backgroundColor: accentColor,
                      borderRadius: spec.buttonRadius === PILL_RADIUS ? PILL_RADIUS : spec.buttonRadius / 2,
                    }}
                  />
                </span>
              </span>
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="email-style-theme"
                  checked={checked}
                  disabled={disabled}
                  aria-describedby="email-style-theme-hint"
                  onChange={() => onPreset(preset)}
                />
                <span className="min-w-0 flex-1 truncate">{spec.label}</span>
              </span>
              <span className={HINT}>{PRESET_NOTES[preset]}</span>
            </label>
          );
        })}
      </div>
      <FontSelect
        id="email-style-heading-font"
        label="Heading font"
        hint="Headings, and your name in the header."
        value={theme.headingFont}
        webFonts={webFonts}
        disabled={disabled}
        onChange={(id) => onFont("headingFont", id)}
      />
      <FontSelect
        id="email-style-body-font"
        label="Body font"
        hint="Text, buttons and the footer."
        value={theme.bodyFont}
        webFonts={webFonts}
        disabled={disabled}
        onChange={(id) => onFont("bodyFont", id)}
      />
      {canEdit && onBrandFonts ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-neutral-300 p-3 dark:border-neutral-700">
          <p className={HINT}>Use the heading and body fonts from Brand › Fonts, where email has them.</p>
          <button type="button" onClick={onBrandFonts} disabled={disabled} className={`shrink-0 font-medium ${BTN}`}>
            Use brand fonts
          </button>
        </div>
      ) : null}
      {brandFontNotes.length ? (
        <ul className="space-y-1 rounded-md border border-neutral-200 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
          {brandFontNotes.map((n) => (
            <li key={n}>{n}.</li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}

/** A font picker: every email font, each labelled with where it shows. */
function FontSelect({
  id,
  label,
  hint,
  value,
  webFonts,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  /** Where in the email the font shows. */
  hint: string;
  value: EmailFontId;
  webFonts: boolean;
  disabled: boolean;
  onChange: (id: EmailFontId) => void;
}) {
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <p id={hintId} className={HINT}>
        {hint}
      </p>
      <select
        id={id}
        className={INPUT}
        value={value}
        disabled={disabled}
        aria-describedby={hintId}
        onChange={(e) => {
          if (isEmailFontId(e.target.value)) onChange(e.target.value);
        }}
      >
        {EMAIL_FONT_LIST.map((f) => (
          <option key={f.id} value={f.id}>
            {emailFontOption(f.id, webFonts)}
          </option>
        ))}
      </select>
    </div>
  );
}

function LogoOption({
  label,
  src,
  badge,
  reason,
  checked,
  disabled,
  onSelect,
}: {
  label: string;
  src?: string;
  badge?: string;
  /** Why it can't be picked. */
  reason?: string;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`flex flex-col gap-2 rounded-md border p-2 text-sm ${
        checked ? "border-neutral-900 dark:border-neutral-100" : "border-neutral-200 dark:border-neutral-800"
      } ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-neutral-400 dark:hover:border-neutral-600"}`}
    >
      <span className="grid h-14 place-items-center overflow-hidden rounded bg-neutral-50 dark:bg-neutral-900" style={src ? CHECKER : undefined}>
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" className="max-h-10 max-w-full object-contain" />
        ) : (
          <span className={HINT}>Name only</span>
        )}
      </span>
      <span className="flex items-center gap-2">
        <input type="radio" name="email-style-logo" checked={checked} disabled={disabled} onChange={onSelect} />
        <span className="min-w-0 flex-1 truncate" title={label}>
          {label}
        </span>
        {badge ? (
          <span className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            {badge}
          </span>
        ) : null}
      </span>
      {reason ? <span className={HINT}>{reason}</span> : null}
    </label>
  );
}

function ColourField({
  id,
  label,
  hint,
  value,
  chips,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  chips: PaletteChip[];
  disabled: boolean;
  onChange: (hex: string) => void;
}) {
  // The hex box keeps what's typed; the colour only changes on a full #rrggbb.
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const hintId = `${id}-hint`;
  return (
    <fieldset className="space-y-2">
      <legend className={LABEL}>{label}</legend>
      <p id={hintId} className={HINT}>
        {hint}
      </p>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          className={SWATCH}
          aria-label={`${label} picker`}
          aria-describedby={hintId}
        />
        <input
          id={id}
          className={`${FIELD} w-32 font-mono`}
          value={text}
          maxLength={7}
          spellCheck={false}
          disabled={disabled}
          aria-label={`${label} hex code`}
          aria-describedby={hintId}
          onChange={(e) => {
            setText(e.target.value);
            const hex = HEX_TYPED.test(e.target.value.trim()) ? normalizeHex(e.target.value) : null;
            if (hex) onChange(hex);
          }}
          onBlur={() => setText(value)}
        />
      </div>
      {chips.length ? (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button
              key={c.hex}
              type="button"
              disabled={disabled}
              title={c.name === c.hex ? c.hex : `${c.name} · ${c.hex}`}
              aria-label={c.name === c.hex ? `Use ${c.hex}` : `Use ${c.name} (${c.hex})`}
              aria-pressed={c.hex === value}
              onClick={() => onChange(c.hex)}
              className={`h-7 w-7 rounded-full border border-neutral-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 ${
                c.hex === value ? "ring-2 ring-neutral-900 ring-offset-2 dark:ring-neutral-100 dark:ring-offset-neutral-950" : ""
              }`}
              style={{ backgroundColor: c.hex }}
            />
          ))}
        </div>
      ) : null}
    </fieldset>
  );
}
