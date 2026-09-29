import { z } from "zod";
import { forTenant, getTenantById, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import type { LifecycleJourney } from "@/lib/types/lifecycle";
import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { BRAND_KIT_EMAIL_STYLE_ROUTE } from "@/lib/content/brandKit";
import { resolveEmailStyle } from "@/lib/email/resolveEmailStyle";
import { isEmailHeaderOptionsEnabled, isEmailJourneyStyleEnabled, isEmailStyleEnabled } from "@/lib/email/flags";
import { paletteChips } from "@/components/admin/brand-kit/emailStyleForm";
import { readJourneyStyle, sameJourneyStyle } from "@/components/admin/lifecycle/journeyStyleForm";
import { waitlistJourneyId } from "./waitlist/ids";

/**
 * What Vizzy may READ to talk about and set one lifecycle journey's own Email style (a product
 * journey, or a launch's welcome journey on the new engine), and how it finds that journey: by its
 * id (the journey page in view), or by a launch (its welcome journey). The brand's style for
 * comparison, the draft's and the live style, and whether the asker may change it. No people or
 * addresses. Auth is the signed canvas capability token (the tenant comes from it), gated by the
 * Email style and journey style flags. The gradient and header text are in it only with
 * EMAIL_HEADER_OPTIONS_ENABLED on, as they only draw then.
 */

export type ApiResult = { status: number; body: unknown };

/** Brace-free doc ids only: they come from the chat's envelope, and a slash isn't a document. */
const DocId = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/);

/** Which journey: exactly one of the journey's id or a launch's id (its welcome journey). */
export const JourneyRefSchema = z.object({ journeyId: DocId(64).optional(), campaignId: DocId(200).optional() });
export type JourneyRef = z.infer<typeof JourneyRefSchema>;
export const ONE_JOURNEY = "journeyId/campaignId: give exactly one";

const NOT_MOVED =
  "This launch's welcome emails haven't moved to the new journey engine, so they wear the brand's Email style (Brand › Email style).";
const ON_ORIGINAL_ENGINE =
  "This launch's welcome emails still send from the original engine, which wears the brand's Email style: this style applies once the launch moves to the new engine.";

const NOTE =
  "mode brand = the brand's Email style (Brand › Email style). custom = this journey's own header and button colours, " +
  "on the colour header with the brand's logo, name and theme, never its header image. Vizzy sets the draft only: the " +
  "journey's emails change when an admin publishes it, and from then on every email it sends wears it.";
const OPTIONS_NOTE =
  " headerGradientColor fades the header from headerColor to it (null = solid; Outlook and Gmail on Android show " +
  "headerColor alone), and headerText is auto (black or white, whichever reads better), white or black.";

export function journeyStyleAgentGate(req: Request): { ok: true; ctx: TenantContext } | { ok: false; result: ApiResult } {
  if (!isEmailStyleEnabled() || !isEmailJourneyStyleEnabled()) {
    return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  }
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  return { ok: true, ctx: tenantContextFromCanvasToken(verified.claims) };
}

export type FoundJourney =
  | { ok: true; journey: LifecycleJourney; launch: Campaign | null }
  | { ok: false; status: number; error: string; issues?: string[] };

/**
 * The journey `ref` names, in the token's tenant (another tenant's id simply isn't found), with its
 * launch for a welcome journey. Archived journeys aren't found either.
 */
export async function findStyledJourney(ctx: TenantContext, ref: JourneyRef, db?: FirestoreLike): Promise<FoundJourney> {
  const repo = forTenant(ctx, db);
  if (ref.campaignId) {
    const launch = await repo.campaigns.getById(ref.campaignId);
    if (!launch) return { ok: false, status: 404, error: "launch_not_found" };
    const journey = await repo.lifecycleJourneys.getById(waitlistJourneyId(launch.id));
    if (!journey || journey.status === "archived") return { ok: false, status: 404, error: "journey_not_found", issues: [NOT_MOVED] };
    return { ok: true, journey, launch };
  }
  const journey = ref.journeyId ? await repo.lifecycleJourneys.getById(ref.journeyId) : null;
  if (!journey || journey.status === "archived") return { ok: false, status: 404, error: "journey_not_found" };
  const launch = journey.audience?.kind === "waitlist" ? await repo.campaigns.getById(journey.audience.campaignId) : null;
  return { ok: true, journey, launch };
}

/** Said about a welcome journey whose launch doesn't send from the new engine yet (a rehearsal's shadow mail does). */
export function launchEngineNote(launch: Campaign | null): string | null {
  return launch && launch.waitlistEngine !== "lifecycle" && launch.waitlistEngine !== "rehearsal" ? ON_ORIGINAL_ENGINE : null;
}

/**
 * A journey style as Vizzy reads it: the brand's, or Custom with its colours (the gradient and
 * header text spelled out, null = solid and "auto", only with header options on).
 */
function journeyStyleRead(value: unknown, headerOptions: boolean) {
  const style = readJourneyStyle(value);
  if (!style) return { mode: "brand" as const };
  return {
    mode: "custom" as const,
    headerColor: style.headerColor,
    buttonColor: style.accentColor,
    ...(headerOptions
      ? {
          headerGradientColor:
            style.headerGradientColor && style.headerGradientColor !== style.headerColor ? style.headerGradientColor : null,
          headerText: style.headerText ?? "auto",
        }
      : {}),
  };
}

export async function agentJourneyStyle(
  ctx: TenantContext,
  query: { journeyId?: string | null; campaignId?: string | null },
  db?: FirestoreLike,
): Promise<ApiResult> {
  const ref = JourneyRefSchema.safeParse({ journeyId: query.journeyId || undefined, campaignId: query.campaignId || undefined });
  if (!ref.success) return { status: 400, body: { error: "invalid_input", issues: ref.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
  if (Boolean(ref.data.journeyId) === Boolean(ref.data.campaignId)) return { status: 400, body: { error: "invalid_input", issues: [ONE_JOURNEY] } };
  const found = await findStyledJourney(ctx, ref.data, db);
  if (!found.ok) return { status: found.status, body: { error: found.error, ...(found.issues ? { issues: found.issues } : {}) } };

  const { journey, launch } = found;
  const headerOptions = isEmailHeaderOptionsEnabled();
  const tenant = await getTenantById(ctx.tenantId, db).catch(() => null);
  const brand = resolveEmailStyle(tenant);
  const draft = journey.draft.settings.emailStyle;
  const engineNote = launchEngineNote(launch);
  return {
    status: 200,
    body: {
      journey: {
        id: journey.id,
        name: journey.name,
        kind: journey.audience?.kind === "waitlist" ? "launch_welcome" : "product",
        status: journey.status,
        publishedVersion: journey.publishedVersion,
        url: `/admin/lifecycle/${journey.id}`,
        ...(launch ? { launch: { id: launch.id, name: launch.waitlistName || launch.id } } : {}),
      },
      // Only an admin may set it; members can still ask what it is.
      canEdit: ctx.role === "admin",
      // Vizzy may set a gradient and the header text colour too.
      ...(headerOptions ? { headerOptions: true } : {}),
      // What the brand's emails wear (null = today's plain look, with no header band).
      brand: brand
        ? {
            url: BRAND_KIT_EMAIL_STYLE_ROUTE,
            headerColor: brand.headerColor,
            buttonColor: brand.accentColor,
            ...(headerOptions
              ? { headerGradientColor: brand.headerGradientColor ?? null, headerText: brand.headerText ?? "auto" }
              : {}),
            logo: Boolean(brand.logo),
            name: brand.name,
            // A Custom journey never shows it: its emails show the logo (or name) on the header colour.
            headerImage: Boolean(brand.headerImage),
          }
        : null,
      // The brand's colours, to pick from.
      palette: paletteChips(tenant?.brandKit),
      // What the draft holds, and what the journey's emails wear now (null = not published yet).
      draft: journeyStyleRead(draft, headerOptions),
      live: journey.publishedVersion ? journeyStyleRead(journey.emailStyle, headerOptions) : null,
      changedSincePublish: Boolean(journey.publishedVersion) && !sameJourneyStyle(draft, journey.emailStyle),
      note: (headerOptions ? NOTE + OPTIONS_NOTE : NOTE) + (engineNote ? ` ${engineNote}` : ""),
    },
  };
}
