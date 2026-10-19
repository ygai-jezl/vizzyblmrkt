import { z } from "zod";
import { isRateLimited } from "@/lib/tenant";
import { setTenantImageStyleSuggestion } from "@/lib/tenant/control";
import type { FirestoreLike } from "@/lib/tenant/types";
import { IMAGE_STYLE_CHANNELS, IMAGE_STYLE_SUGGESTION_LIMITS, ImageStyleIdSchema, ImageStyleSuggestionSchema } from "@/lib/types/imageStyle";
import { BRAND_KIT_IMAGE_STYLE_ROUTE } from "@/lib/content/brandKit";
import { imageStyleById } from "@/lib/content/imageStyle/catalogue";
import { isBrandImageStyleEnabled } from "@/lib/content/imageStyle/flags";
import type { CanvasAuthorArgs, CanvasAuthorOutcome, CanvasKind } from "../types";

/**
 * The `image_style` canvas kind: Vizzy suggests the brand's image style (a default, and any
 * channel's own) from chat. It writes ONLY `tenant.imageStyleSuggestion`: no image reads it,
 * and nothing changes until an admin Reviews and Saves it on Brand › Image style. Brand-wide
 * (the tenant comes from the signed token); admins only. Only styles that are built can be
 * suggested.
 */

const ImageStyleInput = z.object({
  defaultStyleId: ImageStyleIdSchema,
  /** A channel's own style, where it should differ from the default. */
  channels: z.partialRecord(z.enum(IMAGE_STYLE_CHANNELS), ImageStyleIdSchema).optional(),
  /** Why, in a sentence: shown on the page beside the suggestion. */
  reason: z.string().trim().min(1).max(IMAGE_STYLE_SUGGESTION_LIMITS.reason),
});

const AUTHOR_LIMIT = { prefix: "image_style_author", burstLimit: 5, hourlyLimit: 20 };
const NOTE = "Suggestion: nothing changes until an admin applies it.";

const issuesOf = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
const labelOf = (id: string) => imageStyleById(id)?.label ?? id;

export async function authorImageStyleSuggestion(
  { ctx, input }: CanvasAuthorArgs,
  deps: { db?: FirestoreLike } = {},
): Promise<CanvasAuthorOutcome> {
  if (!isBrandImageStyleEnabled()) return { ok: false, status: 503, error: "unavailable" };
  // Saving is admin-only, so suggesting is too. A token without a role fails closed.
  if (ctx.role !== "admin") return { ok: false, status: 403, error: "forbidden" };
  const req = ImageStyleInput.safeParse(input);
  if (!req.success) return { ok: false, status: 400, error: "invalid_input", issues: issuesOf(req.error) };
  const { defaultStyleId, reason } = req.data;
  const channels = Object.fromEntries(Object.entries(req.data.channels ?? {}).filter(([, v]) => v));
  const unbuilt = [["default", defaultStyleId], ...Object.entries(channels)]
    .filter(([, id]) => !imageStyleById(id as string)?.built)
    .map(([where, id]) => `${where}: ${labelOf(id as string)} isn't available yet`);
  if (unbuilt.length) return { ok: false, status: 400, error: "style_not_built", issues: unbuilt };
  if (await isRateLimited(`tenant:${ctx.tenantId}`, AUTHOR_LIMIT, { db: deps.db })) {
    return { ok: false, status: 429, error: "rate_limited" };
  }

  const checked = ImageStyleSuggestionSchema.safeParse({
    defaultStyleId,
    ...(Object.keys(channels).length ? { channels } : {}),
    reason,
    suggestedBy: ctx.userId || "agent",
    suggestedAt: new Date().toISOString(),
  });
  if (!checked.success) return { ok: false, status: 400, error: "invalid_input", issues: issuesOf(checked.error) };
  // Only the suggestion: `imageStyle` (what images use) is never touched here.
  const s = await setTenantImageStyleSuggestion(ctx.tenantId, checked.data, deps.db);
  const perChannel = Object.entries(s.channels ?? {}).filter(([, v]) => v);
  const url = BRAND_KIT_IMAGE_STYLE_ROUTE;
  return {
    ok: true,
    id: "image_style",
    status: "suggested",
    url,
    summary:
      `Suggested ${labelOf(s.defaultStyleId)} as the brand's image style` +
      (perChannel.length ? `, with ${perChannel.map(([c, id]) => `${labelOf(id!)} for ${c}`).join(", ")}` : "") +
      ". It's only a suggestion: nothing changes until an admin reviews and saves it in Brand › Image style.",
    warnings: [],
    card: {
      kind: "image_style",
      // One suggestion per brand: a newer one replaces this card.
      id: "image_style",
      title: "Image style suggestion",
      url,
      stats: [{ label: "default", value: labelOf(s.defaultStyleId) }, ...(perChannel.length ? [{ label: "channels", value: perChannel.length }] : [])],
      warnings: 0,
      note: NOTE,
      cta: "Review and apply",
    },
  };
}

export const imageStyleCanvasKind: CanvasKind = {
  kind: "image_style",
  label: "image style suggestion",
  authorDraft: (args) => authorImageStyleSuggestion(args),
};
