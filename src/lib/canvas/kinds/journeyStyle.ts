import { z } from "zod";
import { getTenantById, isRateLimited } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { HeaderTextSchema, HexColorSchema, type JourneyEmailStyle, type StoredJourneyStyle } from "@/lib/types/tenant";
import type { LifecycleJourney } from "@/lib/types/lifecycle";
import { normalizeHex } from "@/lib/content/create/colorPalette";
import type { ResolvedEmailStyle } from "@/lib/email/emailStyle";
import { resolveEmailStyle } from "@/lib/email/resolveEmailStyle";
import { isEmailHeaderOptionsEnabled, isEmailJourneyStyleEnabled, isEmailStyleEnabled } from "@/lib/email/flags";
import { setLifecycleDraftEmailStyle } from "@/lib/lifecycle/service";
import {
  findStyledJourney,
  JourneyRefSchema,
  launchEngineNote,
  ONE_JOURNEY,
} from "@/lib/lifecycle/journeyStyleAgentApi";
import {
  customJourneyStyle,
  journeyBannerNote,
  readJourneyStyle,
  withJourneyHeaderText,
} from "@/components/admin/lifecycle/journeyStyleForm";
import type { CanvasAuthorArgs, CanvasAuthorOutcome, CanvasKind } from "../types";

/**
 * The `journey_style` canvas kind — Vizzy sets one lifecycle journey's own Email style (a product
 * journey, or a launch's welcome journey on the new engine) from chat, as the journey's Settings
 * do: the brand's Email style (`brand`), or Custom header and button colours (`custom`), on the
 * colour header with the brand's logo, name and theme. It writes ONLY the draft's
 * `settings.emailStyle`, in a transaction; the journey's emails change when an admin publishes it.
 * Admins only; needs EMAIL_STYLE_ENABLED and EMAIL_JOURNEY_STYLE_ENABLED.
 *
 * The journey is the one in view (`journeyId`) or a launch's welcome journey (`campaignId`),
 * exactly one, in the token's tenant. `custom` starts from the draft's Custom colours, else the
 * brand's, and any colours given go on top. A gradient and header text need
 * EMAIL_HEADER_OPTIONS_ENABLED: off, a real one is refused, null and "auto" are ignored, and what's
 * stored is kept (it doesn't draw).
 *
 * The outcome and card ids are the journey's, so the journey editor reloads when it's in view.
 */

/** A colour as the agent may send it (#abc, #aabbccdd, rgb()), made #rrggbb. */
const Colour = z
  .string()
  .max(40)
  .transform((s) => normalizeHex(s) ?? s)
  .pipe(HexColorSchema);

const JourneyStyleInput = JourneyRefSchema.extend({
  mode: z.enum(["brand", "custom"]),
  headerColor: Colour.optional(),
  buttonColor: Colour.optional(),
  /** The header fades from headerColor to this (top left to bottom right); null = solid. */
  headerGradientColor: Colour.nullable().optional(),
  /** "auto" = black or white, whichever reads better across the header. */
  headerText: HeaderTextSchema.optional(),
}).strict();

const AUTHOR_LIMIT = { prefix: "journey_style_author", burstLimit: 5, hourlyLimit: 20 };
const NOTE = "Saved to the draft — publish the journey to apply it.";
const OPTIONS_OFF = "headerGradientColor/headerText: gradient headers and header text colour aren't switched on here yet";
const BRAND_TAKES_NO_COLOURS = "mode: brand uses the brand's Email style, so it takes no colours (use custom)";

const issuesOf = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

type Fields = z.infer<typeof JourneyStyleInput>;

/**
 * The Custom style to store, over the one stored now (`stored`): its colours, else the brand's
 * (as picking Custom in Settings starts), then the colours given. A colour 2 equal to the header
 * colour draws solid, so it isn't kept.
 */
function customStyle(
  stored: StoredJourneyStyle | null,
  given: Fields,
  brand: ResolvedEmailStyle | null,
  headerOptions: boolean,
): JourneyEmailStyle {
  let style: JourneyEmailStyle = { ...customJourneyStyle(stored, brand, headerOptions) };
  if (given.headerColor) style.headerColor = given.headerColor;
  if (given.buttonColor) style.accentColor = given.buttonColor;
  if (headerOptions && given.headerGradientColor !== undefined) {
    const { headerGradientColor: _dropped, ...solid } = style;
    style = given.headerGradientColor ? { ...solid, headerGradientColor: given.headerGradientColor } : solid;
  }
  if (headerOptions && given.headerText !== undefined) style = withJourneyHeaderText(style, given.headerText);
  if (style.headerGradientColor === style.headerColor) {
    const { headerGradientColor: _same, ...solid } = style;
    style = solid;
  }
  return style;
}

/** The answer and its card, for the style the draft now holds (`style`, null = the brand's). */
function outcome(
  journey: LifecycleJourney,
  style: StoredJourneyStyle | null,
  opts: { brand: ResolvedEmailStyle | null; headerOptions: boolean; warnings: string[] },
): CanvasAuthorOutcome {
  const url = `/admin/lifecycle/${journey.id}`;
  // The gradient and header text only draw with header options on, so only then are they claimed.
  const gradient = opts.headerOptions ? style?.headerGradientColor : undefined;
  const text = opts.headerOptions ? style?.headerText : undefined;
  const applies = journey.publishedVersion
    ? "Its emails keep their current look until you publish the journey; then every email it sends from then on wears it."
    : "It applies once the journey is published.";
  const banner = style ? journeyBannerNote(opts.brand) : null;
  const summary = style
    ? `I set "${journey.name}" to its own email style in its draft: ` +
      [
        gradient ? `header ${style.headerColor} fading to ${gradient}` : `header ${style.headerColor}`,
        ...(text ? [`${text} header text`] : []),
        `button ${style.accentColor}`,
      ].join(", ") +
      `, with your logo, name and theme. ${applies}${banner ? ` ${banner}` : ""}`
    : `I set "${journey.name}" back to your brand's Email style in its draft. ${applies}`;
  return {
    ok: true,
    id: journey.id,
    status: journey.status,
    url,
    summary,
    warnings: opts.warnings,
    card: {
      kind: "journey_style",
      // The journey's id, so its editor (in view) reloads.
      id: journey.id,
      title: journey.name,
      subtitle: "Email style",
      url,
      stats: style
        ? [
            { label: "header", value: gradient ? `${style.headerColor} → ${gradient}` : style.headerColor },
            ...(text ? [{ label: "text", value: text }] : []),
            { label: "button", value: style.accentColor },
          ]
        : [{ label: "style", value: "brand's Email style" }],
      warnings: opts.warnings.length,
      note: NOTE,
      cta: "Open journey",
    },
  };
}

export async function authorJourneyStyle(
  { ctx, input }: CanvasAuthorArgs,
  deps: { db?: FirestoreLike } = {},
): Promise<CanvasAuthorOutcome> {
  if (!isEmailStyleEnabled() || !isEmailJourneyStyleEnabled()) return { ok: false, status: 503, error: "unavailable" };
  // Publishing is admin-only, so setting what it publishes is too. A token without a role fails closed.
  if (ctx.role !== "admin") return { ok: false, status: 403, error: "forbidden" };
  // The canvas request's own keys aren't the kind's.
  const { kind: _kind, action: _action, brief: _brief, ...fields } = input;
  const req = JourneyStyleInput.safeParse(fields);
  if (!req.success) return { ok: false, status: 400, error: "invalid_input", issues: issuesOf(req.error) };
  const given = req.data;
  if (Boolean(given.journeyId) === Boolean(given.campaignId)) {
    return { ok: false, status: 400, error: "invalid_input", issues: [ONE_JOURNEY] };
  }
  if (
    given.mode === "brand" &&
    [given.headerColor, given.buttonColor, given.headerGradientColor, given.headerText].some((v) => v !== undefined)
  ) {
    return { ok: false, status: 400, error: "invalid_input", issues: [BRAND_TAKES_NO_COLOURS] };
  }
  const headerOptions = isEmailHeaderOptionsEnabled();
  // Off, only a real option is refused: null (solid) and "auto" are the look it draws anyway.
  if (!headerOptions && (given.headerGradientColor || (given.headerText && given.headerText !== "auto"))) {
    return { ok: false, status: 400, error: "header_options_unavailable", issues: [OPTIONS_OFF] };
  }
  if (await isRateLimited(`tenant:${ctx.tenantId}`, AUTHOR_LIMIT, { db: deps.db })) {
    return { ok: false, status: 429, error: "rate_limited" };
  }

  const found = await findStyledJourney(ctx, given, deps.db);
  if (!found.ok) return { ok: false, status: found.status, error: found.error, ...(found.issues ? { issues: found.issues } : {}) };
  const brand = resolveEmailStyle(await getTenantById(ctx.tenantId, deps.db).catch(() => null));
  // Only the draft's style, on the fresh doc: the rest of the draft, the live style and the
  // published version stay as they are.
  const saved = await setLifecycleDraftEmailStyle(
    ctx,
    found.journey.id,
    (stored) => (given.mode === "brand" ? null : customStyle(stored, given, brand, headerOptions)),
    { db: deps.db, authoredBy: "agent" },
  );
  if (!saved.ok) {
    return {
      ok: false,
      status: saved.status,
      error: saved.status === 404 ? "journey_not_found" : saved.error,
      ...(saved.detail ? { issues: [String(saved.detail)] } : {}),
    };
  }
  const engineNote = launchEngineNote(found.launch);
  return outcome(saved.value, readJourneyStyle(saved.value.draft.settings.emailStyle), {
    brand,
    headerOptions,
    warnings: engineNote ? [engineNote] : [],
  });
}

export const journeyStyleCanvasKind: CanvasKind = {
  kind: "journey_style",
  label: "journey email style",
  authorDraft: (args) => authorJourneyStyle(args),
};
