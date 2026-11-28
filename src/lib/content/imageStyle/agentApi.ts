import { getTenantById, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { BRAND_KIT_IMAGE_STYLE_ROUTE } from "@/lib/content/brandKit";
import { IMAGE_STYLE_CHANNELS } from "@/lib/types/imageStyle";
import { IMAGE_STYLES, imageStyleById, isStyleAvailable } from "./catalogue";
import { isBlogHeroEnabled, isBrandImageStyleEnabled, isImageStyleVersionsOn, isMoreStylesEnabled } from "./flags";
import { learnedForVizzy, type LearnedViewDeps } from "@/lib/loops/learnedView";

/**
 * For Vizzy: the brand's image style (saved, pending suggestion, the styles it can pick from), so
 * it can answer "what's my image style?" and suggest one. Brand-wide; no person's data. Auth: the
 * signed canvas capability token; gated by BRAND_IMAGE_STYLE_ENABLED.
 *
 * With image style versions on (IMAGE_STYLE_VERSIONS_ENABLED, learning loops step 4, 3.10) it also
 * returns `learned`: each style's look, who set it, where it came from, how its images did, its
 * checks and History in words, the reasons given with votes and the newest notes, quoted as data.
 * Read only: Vizzy never changes a look. With versions off the answer is as before.
 */

export type ApiResult = { status: number; body: unknown };

export function imageStyleAgentGate(req: Request): { ok: true; ctx: TenantContext } | { ok: false; result: ApiResult } {
  if (!isBrandImageStyleEnabled()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  return { ok: true, ctx: tenantContextFromCanvasToken(verified.claims) };
}

const label = (id: string | null | undefined) => (id ? (imageStyleById(id)?.label ?? id) : null);

export async function agentImageStyle(ctx: TenantContext, db?: FirestoreLike, learnedDeps: LearnedViewDeps = {}): Promise<ApiResult> {
  const tenant = await getTenantById(ctx.tenantId, db).catch(() => null);
  // A read of what was learned that fails leaves it out, never the rest of the answer.
  const learned = isImageStyleVersionsOn()
    ? await learnedForVizzy(ctx, { db, ...learnedDeps }).catch((err: unknown) => {
        console.warn("[image style] Vizzy's read of what was learned failed", err instanceof Error ? err.message.slice(0, 200) : "error");
        return null;
      })
    : undefined;
  if (!tenant) return { status: 404, body: { error: "tenant_not_found" } };
  const saved = tenant.imageStyle;
  const pending = tenant.imageStyleSuggestion;
  return {
    status: 200,
    body: {
      // null = the brand hasn't picked: images look as they always did.
      current: saved?.defaultStyleId
        ? {
            defaultStyleId: saved.defaultStyleId,
            defaultLabel: label(saved.defaultStyleId),
            channels: Object.fromEntries(Object.entries(saved.channels ?? {}).filter(([, v]) => v)),
            logoOnSocial: saved.logoOnSocial !== false,
            headlineOnSocial: saved.headlineOnSocial !== false,
          }
        : null,
      pending: pending
        ? { defaultStyleId: pending.defaultStyleId, defaultLabel: label(pending.defaultStyleId), channels: pending.channels ?? {}, reason: pending.reason }
        : null,
      // What can be picked; a style that isn't `built` yet can't be.
      styles: IMAGE_STYLES.map((s) => ({
        id: s.id,
        label: s.label,
        hint: s.hint,
        built: isStyleAvailable(s, isMoreStylesEnabled()),
        kind: s.engine === "template" ? "drawn: exact words and numbers" : "painted: no words in the art",
        ...(s.requires.length ? { needs: s.requires } : {}),
      })),
      channels: IMAGE_STYLE_CHANNELS,
      blogHero: isBlogHeroEnabled(),
      canSuggest: ctx.role === "admin",
      url: BRAND_KIT_IMAGE_STYLE_ROUTE,
      // learned[]: one entry per style shown on What it learned; null when its read failed.
      ...(learned === undefined ? {} : learned === null ? { learned: null } : { learned: learned.looks, learningPaused: learned.paused, learningSetUp: !learned.notSetUp }),
    },
  };
}
