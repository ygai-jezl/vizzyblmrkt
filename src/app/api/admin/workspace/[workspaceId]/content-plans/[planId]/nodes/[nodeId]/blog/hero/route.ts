import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, getTenantById, isRateLimited } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { isBlogHeroEnabled } from "@/lib/content/imageStyle/flags";
import { makeBlogHero, setHeroAlt } from "@/lib/content/blog/hero";
import { assembleBrandContext, resolveBrandVoiceText } from "@/lib/content/create/brandContext";
import { FormatInputsSchema, ImageFormatIdSchema } from "@/lib/types/imageStyle";
import { isImageFormatsEnabled } from "@/lib/content/imageStyle/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string; nodeId: string }> };

/** Each run is an image model call at most twice: keep it bounded per tenant. */
const HERO_LIMIT = { prefix: "blog_hero", burstLimit: 6, hourlyLimit: 40 };
/** The whole run, inside the request: two 40 s tries, the fallback and storage. */
const BUDGET_MS = 140_000;

const MakeSchema = z.strictObject({
  /** This article's own style; "brand" = back to the brand's; absent = keep the article's pick. */
  styleId: z.string().min(1).max(40).optional(),
  /** A format for the hero and what it draws (IMAGE_FORMATS_ENABLED); absent = keep the article's. */
  format: ImageFormatIdSchema.optional(),
  formatInputs: FormatInputsSchema.optional(),
});
const AltSchema = z.strictObject({ alt: z.string().max(250) });

async function scope(req: Request, params: RouteParams["params"]) {
  const fail = (response: NextResponse) => ({ ok: false as const, response });
  const blocked = sameOriginGuard(req);
  if (blocked) return fail(blocked);
  if (!isBlogHeroEnabled()) return fail(NextResponse.json({ error: "unavailable" }, { status: 503 }));
  const ctx = await getAdminContext();
  if (!ctx) return fail(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
  const { workspaceId, planId, nodeId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return fail(NextResponse.json({ error: "not_found" }, { status: 404 }));
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return fail(NextResponse.json({ error: "not_found" }, { status: 404 }));
  return { ok: true as const, ctx, ws, plan, workspaceId, planId, nodeId };
}

/**
 * Make (or make again) a blog article's hero image and share card (BLOG_HERO_ENABLED). One
 * run at a time: 409 hero_running while another is under way. Saved on the hub's meta,
 * server-owned, so a canvas save or a fact check can't wipe it. See src/lib/content/blog/hero.ts.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const s = await scope(req, params);
  if (!s.ok) return s.response;
  const parsed = MakeSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  if (await isRateLimited(`tenant:${s.ctx.tenantId}`, HERO_LIMIT)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const { format, formatInputs } = parsed.data;
  const formats = isImageFormatsEnabled();
  if (formats && format === "portrait" && !formatInputs?.quote?.trim()) {
    return NextResponse.json({ error: "invalid_input", message: "Add the quote for the portrait card." }, { status: 400 });
  }
  const tenant = await getTenantById(s.ctx.tenantId);
  const styleId = parsed.data.styleId;
  const r = await makeBlogHero({
    ctx: s.ctx,
    tenant,
    workspaceId: s.workspaceId,
    planId: s.planId,
    nodeId: s.nodeId,
    ...(styleId !== undefined ? { styleOverride: styleId === "brand" ? null : styleId } : {}),
    budgetMs: BUDGET_MS,
    retry: true,
    ...(formats && format !== undefined ? { format, ...(formatInputs ? { formatInputs } : {}) } : {}),
    brief: s.plan.blog ?? null,
    brandContextFor: (learned) =>
      assembleBrandContext({
        brandVoice: resolveBrandVoiceText({ tenantBrandVoice: tenant?.brandVoice, workspaceBrandVoice: s.ws.brandVoice }),
        audience: s.ws.audience ?? null,
        brandKit: tenant?.brandKit ?? null,
        typography: tenant?.brandTypography ?? null,
        // What was learned for the hero's own style (learning per style).
        learnedImageStyle: learned,
      }),
  });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ hero: r.hero });
}

/** A person's own alt text for the hero. */
export async function PATCH(req: Request, { params }: RouteParams) {
  const s = await scope(req, params);
  if (!s.ok) return s.response;
  const parsed = AltSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const node = await setHeroAlt(s.ctx, s, parsed.data.alt);
  if (!node) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ hero: node.blog?.hero ?? null });
}
