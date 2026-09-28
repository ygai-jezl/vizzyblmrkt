import { z } from "zod";
import { getTenantById, isRateLimited } from "@/lib/tenant";
import { setTenantEmailStyleSuggestion } from "@/lib/tenant/control";
import type { FirestoreLike } from "@/lib/tenant/types";
import {
  EMAIL_STYLE_SUGGESTION_LIMITS as LIMITS,
  EmailStyleSuggestionSchema,
  HeaderTextSchema,
  HexColorSchema,
  type EmailStyleSuggestion,
  type Tenant,
} from "@/lib/types/tenant";
import type { BrandLogo } from "@/lib/types/brandLogo";
import { BRAND_KIT_EMAIL_STYLE_ROUTE } from "@/lib/content/brandKit";
import { normalizeHex } from "@/lib/content/create/colorPalette";
import { cleanCompanyName, isEmailLogo, styleFromBrandKit } from "@/lib/email/emailStyle";
import { emailHeaderImages, emailStyleLogos, type EmailHeaderImageRow } from "@/lib/email/agentApi";
import { isEmailHeaderOptionsEnabled, isEmailStyleEnabled } from "@/lib/email/flags";
import type { CanvasAuthorArgs, CanvasAuthorOutcome, CanvasKind } from "../types";

/**
 * The `email_style` canvas kind — Vizzy suggests the Email style (logo, company name,
 * header and button colours) from chat. It writes ONLY `tenant.emailStyleSuggestion`:
 * sends never read it, and nothing changes until an admin Reviews and Saves it on
 * Brand › Email style. Brand-wide (the tenant comes from the signed token); admins only.
 *  - `brand_kit`: start from Brand, as the page's "Use brand kit" does (solid, Auto text);
 *  - `edit`: start from the pending suggestion, else the saved style, else Brand.
 * Any fields the agent sends go on top.
 *
 * Header options (EMAIL_HEADER_OPTIONS_ENABLED): a gradient's second colour, a forced header
 * text colour, and a header image an admin uploaded on the page (Vizzy can't upload one). Off, a
 * default (null = solid, "auto", "none" = the colour header) is today's look and is ignored, a
 * real option is refused, and nothing is carried over, so the kind is exactly as before.
 */

/** A colour as the agent may send it (#abc, #aabbccdd, rgb()), made #rrggbb. */
const Colour = z
  .string()
  .max(40)
  .transform((s) => normalizeHex(s) ?? s)
  .pipe(HexColorSchema);

const EmailStyleInput = z.object({
  mode: z.enum(["brand_kit", "edit"]),
  headerColor: Colour.optional(),
  /** The header fades from headerColor to this (top left to bottom right); null = solid. */
  headerGradientColor: Colour.nullable().optional(),
  /** "auto" = black or white, whichever reads better across the header. */
  headerText: HeaderTextSchema.optional(),
  buttonColor: Colour.optional(),
  /** "primary", "none", or one of the tenant's logo ids. */
  logo: z.string().trim().min(1).max(64).optional(),
  /** null (or blank) hides the name, so the logo shows alone. */
  companyName: z.string().max(400).nullable().optional(),
  /** One of the tenant's header images by id (a banner in place of the logo and name), or "none" for the colour header. */
  headerImage: z.string().trim().min(1).max(64).optional(),
});

const AUTHOR_LIMIT = { prefix: "email_style_author", burstLimit: 5, hourlyLimit: 20 };
const NOTE = "Suggestion — nothing changes until an admin applies it.";
const LOGO_GONE = "Your chosen logo is no longer available — pick another in Brand › Email style";
const OPTIONS_OFF =
  "headerGradientColor/headerText/headerImage: gradient headers, header text colour and header images aren't switched on here yet";
const IMAGE_GONE = "Your header image is no longer available — upload or pick one in Brand › Email style";

type HeaderOptions = Pick<EmailStyleSuggestion, "headerGradientColor" | "headerText" | "headerImageId">;
type StyleFields = Pick<EmailStyleSuggestion, "logoId" | "companyName" | "headerColor" | "accentColor" | "notes"> &
  HeaderOptions;

const issuesOf = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

/**
 * What `edit` starts from: the pending suggestion, else the saved style, else Brand. The
 * header options come along only with them on (`headerOptions`).
 */
function editBase(tenant: Tenant, fromBrandKit: StyleFields, headerOptions: boolean): StyleFields {
  const pending = tenant.emailStyleSuggestion;
  if (pending) {
    const { logoId, companyName, headerColor, accentColor, notes } = pending;
    return { logoId, companyName, headerColor, accentColor, notes, ...(headerOptions ? optionsOf(pending) : {}) };
  }
  const saved = tenant.emailStyle;
  if (saved) {
    const { companyName, headerColor, accentColor } = saved;
    return {
      logoId: saved.logo?.id ?? null,
      companyName,
      headerColor,
      accentColor,
      notes: [],
      ...(headerOptions ? optionsOf({ ...saved, headerImageId: saved.headerImage?.id }) : {}),
    };
  }
  return fromBrandKit;
}

/**
 * The real header options only, as keys: absent = solid / Auto / the colour header. A colour 2
 * equal to its own header colour draws solid (as the resolver has it), so it isn't carried to a
 * new one.
 */
function optionsOf(s: HeaderOptions & Pick<EmailStyleSuggestion, "headerColor">): HeaderOptions {
  const gradient = s.headerGradientColor !== s.headerColor ? s.headerGradientColor : undefined;
  return {
    ...(gradient ? { headerGradientColor: gradient } : {}),
    ...(s.headerText ? { headerText: s.headerText } : {}),
    ...(s.headerImageId ? { headerImageId: s.headerImageId } : {}),
  };
}

/** The logo asked for: "none", the primary, or one of the tenant's logos by id — a PNG or JPEG either way. */
function pickLogo(asked: string, logos: BrandLogo[]): { ok: true; logoId: string | null } | { ok: false; issue: string } {
  if (asked === "none") return { ok: true, logoId: null };
  const logo = asked === "primary" ? (logos.find((l) => l.isPrimary) ?? logos[0]) : logos.find((l) => l.id === asked);
  if (!logo) {
    return {
      ok: false,
      issue: asked === "primary" ? "logo: No logos yet — add a PNG or JPG in Brand › Logos" : "logo: not one of your logos",
    };
  }
  if (!isEmailLogo(logo)) return { ok: false, issue: "logo: that logo isn't a PNG or JPG, which Outlook needs — pick another" };
  return { ok: true, logoId: logo.id };
}

/** The header asked for: "none" (the colour header), or one of the tenant's header images by id (PNG/JPEG, as listed). */
function pickHeaderImage(
  asked: string,
  images: readonly EmailHeaderImageRow[],
): { ok: true; headerImageId: string | null } | { ok: false; issue: string } {
  if (asked === "none") return { ok: true, headerImageId: null };
  const image = images.find((i) => i.id === asked);
  if (!image) return { ok: false, issue: "headerImage: not one of your header images — upload one in Brand › Email style" };
  return { ok: true, headerImageId: image.id };
}

function outcome(s: EmailStyleSuggestion, images: readonly EmailHeaderImageRow[]): CanvasAuthorOutcome {
  const url = BRAND_KIT_EMAIL_STYLE_ROUTE;
  // Only set with the header options on, and only to one of `images`.
  const image = s.headerImageId ? images.find((i) => i.id === s.headerImageId) : undefined;
  // The banner ignores the gradient, a forced text colour and the logo (they're kept for the
  // colour header), so none is claimed with one, and the name shows only as its alt text.
  const text = image ? undefined : s.headerText;
  // With no header options, the words and the card are exactly as they were without them.
  const look = [
    image
      ? `the header image "${image.title}" (${s.headerColor} behind it)`
      : s.headerGradientColor
        ? `header ${s.headerColor} fading to ${s.headerGradientColor}`
        : `header ${s.headerColor}`,
    ...(text ? [`${text} header text`] : []),
    `button ${s.accentColor}`,
    ...(image ? [] : [s.logoId ? "your logo" : "no logo"]),
    ...(s.companyName
      ? [image ? `the name "${s.companyName}" when images are off` : `the name "${s.companyName}"`]
      : []),
  ].join(", ");
  return {
    ok: true,
    id: "email_style",
    status: "suggested",
    url,
    summary:
      `Suggested an Email style (${look}). It's only a suggestion: nothing changes until an admin ` +
      `reviews and saves it in Brand › Email style.`,
    warnings: s.notes,
    card: {
      kind: "email_style",
      // One suggestion per brand: a newer one replaces this card.
      id: "email_style",
      title: "Email style suggestion",
      url,
      stats: [
        {
          label: "header",
          value: image
            ? `image "${image.title}"`
            : s.headerGradientColor
              ? `${s.headerColor} → ${s.headerGradientColor}`
              : s.headerColor,
        },
        ...(text ? [{ label: "text", value: text }] : []),
        { label: "button", value: s.accentColor },
      ],
      warnings: s.notes.length,
      note: NOTE,
      cta: "Review and apply",
    },
  };
}

export async function authorEmailStyleSuggestion(
  { ctx, input, brief }: CanvasAuthorArgs,
  deps: { db?: FirestoreLike } = {},
): Promise<CanvasAuthorOutcome> {
  if (!isEmailStyleEnabled()) return { ok: false, status: 503, error: "unavailable" };
  // Saving is admin-only, so suggesting is too. A token without a role fails closed.
  if (ctx.role !== "admin") return { ok: false, status: 403, error: "forbidden" };
  const req = EmailStyleInput.safeParse(input);
  if (!req.success) return { ok: false, status: 400, error: "invalid_input", issues: issuesOf(req.error) };
  const headerOptions = isEmailHeaderOptionsEnabled();
  // Off, only a real option is refused: null (solid), "auto" and "none" (the colour header) are today's look anyway.
  if (
    !headerOptions &&
    (req.data.headerGradientColor ||
      (req.data.headerText && req.data.headerText !== "auto") ||
      (req.data.headerImage && req.data.headerImage !== "none"))
  ) {
    return { ok: false, status: 400, error: "header_options_unavailable", issues: [OPTIONS_OFF] };
  }
  if (await isRateLimited(`tenant:${ctx.tenantId}`, AUTHOR_LIMIT, { db: deps.db })) {
    return { ok: false, status: 429, error: "rate_limited" };
  }

  const [tenant, logos, images] = await Promise.all([
    getTenantById(ctx.tenantId, deps.db).catch(() => null),
    emailStyleLogos(ctx).catch(() => null),
    // None (and nothing read) with the header options off.
    emailHeaderImages(ctx).catch(() => null),
  ]);
  if (!tenant) return { ok: false, status: 404, error: "tenant_not_found" };
  if (!logos) return { ok: false, status: 503, error: "logos_unavailable" };
  if (!images) return { ok: false, status: 503, error: "header_images_unavailable" };

  const { mode, headerColor, headerGradientColor, headerText, buttonColor, logo, companyName, headerImage } = req.data;
  const fromBrandKit = styleFromBrandKit(tenant.brandKit, logos);
  // Brand has no header options: brand_kit starts solid, with Auto text, on the colour header.
  const base: StyleFields = mode === "brand_kit" ? fromBrandKit : editBase(tenant, fromBrandKit, headerOptions);
  // The notes are about the logo, bar the header image's, so they go when the agent picks one.
  let { logoId, notes } = base;
  if (logo !== undefined) {
    const picked = pickLogo(logo, logos);
    if (!picked.ok) return { ok: false, status: 400, error: "invalid_logo", issues: [picked.issue] };
    logoId = picked.logoId;
    notes = notes.filter((n) => n === IMAGE_GONE);
  } else if (logoId && !logos.some((l) => l.id === logoId && isEmailLogo(l))) {
    // A carried-over logo that's since been deleted (or Logos is off) isn't claimed.
    logoId = null;
    notes = [LOGO_GONE, ...notes];
  }

  // The given header options go on top; null (solid) and "auto" remove them. A colour 2 equal
  // to the header colour draws solid, so it isn't kept either.
  const header = headerColor ?? base.headerColor;
  const gradient = headerGradientColor === undefined ? base.headerGradientColor : headerGradientColor;
  const text = headerText === undefined ? base.headerText : headerText === "auto" ? undefined : headerText;

  // The header image: one asked for ("none" = the colour header; ignored with the options off),
  // else the one carried over. The gradient and text stay alongside: they apply again on Colour.
  let headerImageId = base.headerImageId;
  if (headerImage !== undefined && headerOptions) {
    const picked = pickHeaderImage(headerImage, images);
    if (!picked.ok) return { ok: false, status: 400, error: "invalid_header_image", issues: [picked.issue] };
    headerImageId = picked.headerImageId ?? undefined;
    notes = notes.filter((n) => n !== IMAGE_GONE);
  } else if (headerImageId && !images.some((i) => i.id === headerImageId)) {
    // A carried-over header image that's since been deleted isn't claimed.
    headerImageId = undefined;
    notes = [IMAGE_GONE, ...notes];
  }

  // Run the strict schema the stored value is read back with, so a success is never
  // reported for a suggestion that would read back as none.
  const checked = EmailStyleSuggestionSchema.safeParse({
    logoId,
    companyName: companyName === undefined ? base.companyName : cleanCompanyName(companyName),
    headerColor: header,
    accentColor: buttonColor ?? base.accentColor,
    ...(gradient && gradient !== header ? { headerGradientColor: gradient } : {}),
    ...(text ? { headerText: text } : {}),
    ...(headerImageId ? { headerImageId } : {}),
    source: mode === "brand_kit" ? "brand_kit" : "chat",
    brief: brief.trim().slice(0, LIMITS.brief),
    notes: notes.slice(0, LIMITS.notes).map((n) => n.slice(0, LIMITS.note)),
    suggestedBy: ctx.userId || "agent",
    suggestedAt: new Date().toISOString(),
  });
  if (!checked.success) return { ok: false, status: 400, error: "invalid_input", issues: issuesOf(checked.error) };

  // Only the suggestion: `emailStyle` (what sends use) is never touched here.
  return outcome(await setTenantEmailStyleSuggestion(ctx.tenantId, checked.data, deps.db), images);
}

export const emailStyleCanvasKind: CanvasKind = {
  kind: "email_style",
  label: "email style suggestion",
  authorDraft: (args) => authorEmailStyleSuggestion(args),
};
