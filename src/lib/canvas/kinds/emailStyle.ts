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
import { emailStyleLogos } from "@/lib/email/agentApi";
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
 * Header options (EMAIL_HEADER_OPTIONS_ENABLED): a gradient's second colour and a forced
 * header text colour. Off, a default (null = solid, "auto") is today's look and is ignored,
 * a real option is refused, and nothing is carried over, so the kind is exactly as before.
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
});

const AUTHOR_LIMIT = { prefix: "email_style_author", burstLimit: 5, hourlyLimit: 20 };
const NOTE = "Suggestion — nothing changes until an admin applies it.";
const LOGO_GONE = "Your chosen logo is no longer available — pick another in Brand › Email style";
const OPTIONS_OFF =
  "headerGradientColor/headerText: gradient headers and header text colour aren't switched on here yet";

type HeaderOptions = Pick<EmailStyleSuggestion, "headerGradientColor" | "headerText">;
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
      ...(headerOptions ? optionsOf(saved) : {}),
    };
  }
  return fromBrandKit;
}

/**
 * The real header options only, as keys: absent = solid / Auto. A colour 2 equal to its own
 * header colour draws solid (as the resolver has it), so it isn't carried to a new one.
 */
function optionsOf(s: HeaderOptions & Pick<EmailStyleSuggestion, "headerColor">): HeaderOptions {
  const gradient = s.headerGradientColor !== s.headerColor ? s.headerGradientColor : undefined;
  return {
    ...(gradient ? { headerGradientColor: gradient } : {}),
    ...(s.headerText ? { headerText: s.headerText } : {}),
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

function outcome(s: EmailStyleSuggestion): CanvasAuthorOutcome {
  const url = BRAND_KIT_EMAIL_STYLE_ROUTE;
  // With no header options, the words and the card are exactly as they were without them.
  const look = [
    s.headerGradientColor ? `header ${s.headerColor} fading to ${s.headerGradientColor}` : `header ${s.headerColor}`,
    ...(s.headerText ? [`${s.headerText} header text`] : []),
    `button ${s.accentColor}`,
    s.logoId ? "your logo" : "no logo",
    ...(s.companyName ? [`the name "${s.companyName}"`] : []),
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
        { label: "header", value: s.headerGradientColor ? `${s.headerColor} → ${s.headerGradientColor}` : s.headerColor },
        ...(s.headerText ? [{ label: "text", value: s.headerText }] : []),
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
  // Off, only a real option is refused: null (solid) and "auto" are today's look anyway.
  if (!headerOptions && (req.data.headerGradientColor || (req.data.headerText && req.data.headerText !== "auto"))) {
    return { ok: false, status: 400, error: "header_options_unavailable", issues: [OPTIONS_OFF] };
  }
  if (await isRateLimited(`tenant:${ctx.tenantId}`, AUTHOR_LIMIT, { db: deps.db })) {
    return { ok: false, status: 429, error: "rate_limited" };
  }

  const [tenant, logos] = await Promise.all([
    getTenantById(ctx.tenantId, deps.db).catch(() => null),
    emailStyleLogos(ctx).catch(() => null),
  ]);
  if (!tenant) return { ok: false, status: 404, error: "tenant_not_found" };
  if (!logos) return { ok: false, status: 503, error: "logos_unavailable" };

  const { mode, headerColor, headerGradientColor, headerText, buttonColor, logo, companyName } = req.data;
  const fromBrandKit = styleFromBrandKit(tenant.brandKit, logos);
  // Brand has no header options: brand_kit starts solid, with Auto text.
  const base: StyleFields = mode === "brand_kit" ? fromBrandKit : editBase(tenant, fromBrandKit, headerOptions);
  // The notes are about the logo, so they go when the agent picks one.
  let { logoId, notes } = base;
  if (logo !== undefined) {
    const picked = pickLogo(logo, logos);
    if (!picked.ok) return { ok: false, status: 400, error: "invalid_logo", issues: [picked.issue] };
    logoId = picked.logoId;
    notes = [];
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

  // Run the strict schema the stored value is read back with, so a success is never
  // reported for a suggestion that would read back as none.
  const checked = EmailStyleSuggestionSchema.safeParse({
    logoId,
    companyName: companyName === undefined ? base.companyName : cleanCompanyName(companyName),
    headerColor: header,
    accentColor: buttonColor ?? base.accentColor,
    ...(gradient && gradient !== header ? { headerGradientColor: gradient } : {}),
    ...(text ? { headerText: text } : {}),
    source: mode === "brand_kit" ? "brand_kit" : "chat",
    brief: brief.trim().slice(0, LIMITS.brief),
    notes: notes.slice(0, LIMITS.notes).map((n) => n.slice(0, LIMITS.note)),
    suggestedBy: ctx.userId || "agent",
    suggestedAt: new Date().toISOString(),
  });
  if (!checked.success) return { ok: false, status: 400, error: "invalid_input", issues: issuesOf(checked.error) };

  // Only the suggestion: `emailStyle` (what sends use) is never touched here.
  return outcome(await setTenantEmailStyleSuggestion(ctx.tenantId, checked.data, deps.db));
}

export const emailStyleCanvasKind: CanvasKind = {
  kind: "email_style",
  label: "email style suggestion",
  authorDraft: (args) => authorEmailStyleSuggestion(args),
};
