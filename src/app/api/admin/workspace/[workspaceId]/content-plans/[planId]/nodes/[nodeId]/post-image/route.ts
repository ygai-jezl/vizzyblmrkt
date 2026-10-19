import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, getTenantById } from "@/lib/tenant";
import { getContentPlan, updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import { generateSocialPostImage } from "@/lib/agents/creative";
import { assembleBrandContext, resolveBrandVoiceText } from "@/lib/content/create/brandContext";
import {
  DEFAULT_SOCIAL_IMAGE_STYLE,
  SOCIAL_ASPECT_TO_GEMINI,
  socialImageStyle,
  isSocialImageEnabled,
  isSocialImageChannel,
  SOCIAL_IMAGE_STYLE_IDS,
} from "@/lib/content/create/socialImage";
import { styleForImage } from "@/lib/content/imageStyle/forImage";
import { countBrandAssetsUpTo } from "@/lib/admin/brandAssets";
import { canonicalStyleId } from "@/lib/content/imageStyle/catalogue";
import { learnedDirectiveFor } from "@/lib/content/imageStyle/learning";
import { isBrandImageStyleEnabled as isBrandImageStyleOn } from "@/lib/content/imageStyle/flags";
import { IMAGE_MODEL_SLUGS } from "@/lib/content/create/imageModels";
import { resolveImageModel } from "@/lib/agents/modelConfig";
import { htmlToText } from "@/lib/email/emailRender";
import { formatTemplate, renderStyleImage, templateFor, type StyleImageResult } from "@/lib/content/imageStyle/render/styleImage";
import { paintFormatScene } from "@/lib/content/imageStyle/formatScene";
import { isImageFormatsEnabled } from "@/lib/content/imageStyle/flags";
import { chartFromCopy, figureFromCopy } from "@/lib/content/imageStyle/chartFromCopy";
import { seedFor } from "@/lib/content/imageStyle/render/templates/lineArt";
import { ChartSchema, FigureSchema, FormatInputsSchema, ImageFormatIdSchema, type Chart, type Figure } from "@/lib/types/imageStyle";
import { headlineFrom, SOCIAL_RENDER_SIZE } from "@/lib/content/imageStyle/render/socialText";
import { storeWorkspaceImage } from "@/lib/workspace/assetStore";
import { recordImageAsset } from "@/lib/admin/brandKit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string; nodeId: string }> };

const BodySchema = z.object({
  /** What to picture. Required, except for a template style, which draws words, not a scene. */
  brief: z.string().max(1000).optional(),
  aspect: z.enum(["1:1", "4:5", "1.91:1"]),
  /** An old preset (the pre-image-style menu). */
  style: z.enum(SOCIAL_IMAGE_STYLE_IDS).optional(),
  /** This image's own style (BRAND_IMAGE_STYLE_ENABLED): a style id, an old preset id, or "brand". */
  styleId: z.string().min(1).max(40).optional(),
  /** The words on the image (template styles, or type over art). Empty = the post's first line. */
  headline: z.string().max(160).optional(),
  /** Make a screenshot style without one (the person chose "Make it without a screenshot"). */
  withoutScreenshot: z.boolean().optional(),
  /** Data story: the person's own numbers (else the post's, checked). */
  chart: ChartSchema.optional(),
  /** Type poster: the person's big number (else the post's first figure). */
  figure: FigureSchema.optional(),
  /** How many times this image has been made: Line art draws anew each time. */
  attempt: z.number().int().min(0).max(1000).optional(),
  /** A format (IMAGE_FORMATS_ENABLED): portrait card, partner lockup, report cover, or standard. */
  format: ImageFormatIdSchema.optional(),
  formatInputs: FormatInputsSchema.optional(),
  /** Brand-style loop override (default true = apply learned style + references). */
  useBrandStyle: z.boolean().optional(),
  /** Operator-selected image model slug (lite | full). Omit to use the surface default. */
  model: z.enum(IMAGE_MODEL_SLUGS).optional(),
});

const IMAGE_ERRORS: Record<string, string> = {
  image_model_unavailable: "The image model isn't available right now.",
  no_asset_bucket: "Image storage isn't configured.",
  store_failed: "Couldn't save the image — try again.",
  bad_type: "The model returned an unsupported image type.",
  too_large: "The generated image was too large.",
};

/**
 * Generate an ON-BRAND image for a social post node (linkedin/x/instagram), STORE it as a
 * private workspace asset, and PERSIST its filename (+ aspect + prompt) onto the node —
 * mirroring the text generate route so the image survives a reload without a manual canvas
 * Save. Returns the persisted ref; the inspector also applies it via onUpdate for an instant
 * thumbnail. FLAG-GATED (503 until CREATE_SOCIAL_IMAGE_ENABLED). Grounded server-side by the
 * workspace + Brand Kit.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isSocialImageEnabled()) {
    return NextResponse.json({ error: "social_image_disabled" }, { status: 503 });
  }

  const { workspaceId, planId, nodeId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const node = plan.graph.nodes.find((n) => n.id === nodeId);
  if (!node) return NextResponse.json({ error: "node_not_found" }, { status: 404 });
  if (!isSocialImageChannel(node.channel)) {
    return NextResponse.json({ error: "unsupported_channel" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const tenant = await getTenantById(ctx.tenantId);
  const useBrandStyle = parsed.data.useBrandStyle !== false;
  // The image's own pick, else the brand's style for this channel, else its default. With the
  // image style off, only the old preset counts: exactly as before.
  const choice = styleForImage({
    surface: "social",
    channel: node.channel,
    tenant,
    override: isBrandImageStyleOn() ? (parsed.data.styleId ?? parsed.data.style ?? null) : (parsed.data.style ?? null),
  });
  // A style built from product screens asks for them the first time, at the moment it's used,
  // unless the person chose to make it without one. They're kept in Brand › Screenshots.
  if (
    choice.resolved.engine === "template" &&
    choice.resolved.requires.includes("screenshots") &&
    parsed.data.withoutScreenshot !== true
  ) {
    const count = await countBrandAssetsUpTo(ctx, "screenshot", 1).catch(() => null);
    if (count === 0) {
      return NextResponse.json(
        {
          error: "needs_screenshots",
          message: `${choice.resolved.label} is built from screens of your product. Add one or two screenshots, or make it without one.`,
        },
        { status: 409 },
      );
    }
  }
  const brief = parsed.data.brief?.trim() ?? "";
  // The words a template draws, or that go over the art: the person's, else the post's first line.
  const words = (parsed.data.headline?.trim() || headlineFrom(htmlToText(node.body || "")) || brief).slice(0, 160);
  const ownWords = parsed.data.headline?.trim() ? parsed.data.headline.trim() : null;

  // What the v2 drawn styles draw: Data story's numbers (the person's, else the post's, checked;
  // too few and the person is asked), Type poster's big number, Line art's pattern.
  const resolved = choice.resolved;
  const drawnId = choice.enabled && resolved.engine === "template" ? resolved.id : null;
  // The style a format is skinned by (before the brand picks one, the Headline card).
  const skinId = resolved.engine === "legacy" ? "headline_card" : resolved.id;
  const postText = htmlToText(node.body || "");
  let chart: Chart | null = null;
  if (drawnId === "data_story") {
    chart = parsed.data.chart ?? (await chartFromCopy({ text: postText }));
    if (!chart) {
      return NextResponse.json(
        {
          error: "needs_numbers",
          message: "Data story draws a chart from numbers in your post, and found fewer than two. Add your numbers, or make it a Type poster.",
        },
        { status: 409 },
      );
    }
  }
  const figure: Figure | null =
    drawnId === "type_poster" ? (parsed.data.figure ?? figureFromCopy({ text: `${words}\n${postText}` })) : null;
  const seed = drawnId === "line_art" ? seedFor(words, parsed.data.attempt ?? 0) : undefined;

  /** Store a drawn image as this post's, with what it drew (and, for a format, which). */
  const saveDrawn = async (drawn: StyleImageResult, asFormat?: { format: string; inputs: Record<string, unknown> }) => {
    const stored = await storeWorkspaceImage(ctx.tenantId, workspaceId, drawn.png, "image/png");
    if (!stored.ok) return null;
    const label = resolved.engine === "legacy" ? "" : resolved.label;
    await recordImageAsset(
      { tenantId: ctx.tenantId, region: ctx.region },
      {
        workspaceId,
        filename: stored.filename,
        mimeType: "image/png",
        kind: "social",
        prompt: `${label}: ${words}`.slice(0, 1000),
        brief: (brief || words).slice(0, 1000),
        aspect: parsed.data.aspect,
        style: asFormat ? `${asFormat.format}:${skinId}` : (drawnId ?? ""),
        channel: node.channel,
        source: { planId, nodeId },
        parentAssetId: null,
        byteSize: drawn.png.length,
      },
    ).catch((e) => console.warn("[brandKit] record social image failed:", e));
    const updated = await updateContentPlanNode(ctx, workspaceId, planId, nodeId, {
      imageAssetRef: stored.filename,
      imageAspect: parsed.data.aspect,
      imagePrompt: null,
      imageStyleId: choice.ownPick,
      imageHeadline: ownWords,
      ...(chart ? { imageChart: chart } : {}),
      ...(figure && parsed.data.figure ? { imageFormatInputs: { ...(node.imageFormatInputs ?? {}), figure } } : {}),
      ...(asFormat ? { imageFormat: asFormat.format as never, imageFormatInputs: asFormat.inputs } : {}),
    });
    if (!updated) return NextResponse.json({ error: "node_not_found" }, { status: 404 });
    return NextResponse.json({
      imageAssetRef: updated.imageAssetRef,
      imagePrompt: null,
      imageStyleId: choice.ownPick,
      styleId: drawnId,
      ...(asFormat ? { imageFormat: asFormat.format } : {}),
      ...(chart ? { chart } : {}),
      ...(figure ? { figure } : {}),
      ...(drawn.note ? { note: drawn.note } : {}),
    });
  };
  const draw = (art?: Buffer) =>
    renderStyleImage({
      ctx,
      tenant,
      template: templateFor(drawnId!)!,
      size: SOCIAL_RENDER_SIZE[parsed.data.aspect],
      headline: words,
      showLogo: tenant?.imageStyle?.logoOnSocial !== false,
      chart,
      figure,
      ...(seed !== undefined ? { seed } : {}),
      ...(art ? { art } : {}),
    });

  // A format (portrait card, partner lockup, report cover): drawn in the style's skin, around a
  // scene painted in the style (portrait and partner always; a report cover in a painted
  // style). Never a person, never the partner's logo: they're named in type.
  const format = choice.enabled && isImageFormatsEnabled() ? formatTemplate(parsed.data.format) : null;
  if (format) {
    const inputs = parsed.data.formatInputs ?? {};
    if (format === "portrait" && !inputs.quote?.trim()) {
      return NextResponse.json({ error: "invalid_input", message: "Add the quote for the portrait card." }, { status: 400 });
    }
    if (format === "partner" && !inputs.partner?.trim()) {
      return NextResponse.json({ error: "invalid_input", message: "Add the partner's name." }, { status: 400 });
    }
    const painted = resolved.engine === "model" || resolved.engine === "legacy";
    const direction = choice.model.direction ?? {
      label: socialImageStyle(choice.model.styleId ?? DEFAULT_SOCIAL_IMAGE_STYLE).label,
      keywords: socialImageStyle(choice.model.styleId ?? DEFAULT_SOCIAL_IMAGE_STYLE).keywords,
    };
    const scene =
      format !== "report_cover" || painted
        ? await paintFormatScene({
            format,
            inputs,
            headline: words,
            direction,
            aspectRatio: SOCIAL_ASPECT_TO_GEMINI[parsed.data.aspect],
            timeoutMs: 60_000,
          })
        : null;
    const drawn = await renderStyleImage({
      ctx,
      tenant,
      template: format,
      size: SOCIAL_RENDER_SIZE[parsed.data.aspect],
      headline: words,
      showLogo: tenant?.imageStyle?.logoOnSocial !== false,
      formatInputs: inputs,
      skin: skinId,
      ...(scene ? { art: scene.bytes } : {}),
    });
    const saved = drawn ? await saveDrawn(drawn, { format, inputs }) : null;
    if (saved) return saved;
    return NextResponse.json({ error: "render_failed", message: "Couldn't make the card. Try again." }, { status: 502 });
  }

  // A template style is drawn, not painted: exact words, the brand's fonts, logo and screens.
  // If the render fails, the style's painted twin below still makes an image. Split card is
  // drawn around painted art, so it's painted first (below).
  if (drawnId && drawnId !== "split_card" && words) {
    const drawn = await draw();
    if (drawn) {
      const saved = await saveDrawn(drawn);
      if (saved) return saved;
    }
  }
  const split = drawnId === "split_card";
  // Split card's photo pictures the post's words when no brief was given.
  const paintBrief = brief || (split ? words : "");
  if (!paintBrief) return NextResponse.json({ error: "invalid_input", message: "Describe the image first." }, { status: 400 });

  // A painted style: the brand's headline and logo go over the art when it asked for them.
  const saved = choice.enabled && resolved.engine === "model" ? tenant?.imageStyle : undefined;
  const overlay =
    saved && (saved.headlineOnSocial !== false || saved.logoOnSocial !== false)
      ? { showHeadline: saved.headlineOnSocial !== false && !!words, showLogo: saved.logoOnSocial !== false }
      : null;

  const learnBucket = choice.enabled ? canonicalStyleId(choice.model.styleId) : null;
  const result = await generateSocialPostImage({
    tenantId: ctx.tenantId,
    workspaceId,
    channel: node.channel,
    brief: paintBrief,
    aspect: parsed.data.aspect,
    style: split ? "split_card" : (choice.model.styleId ?? DEFAULT_SOCIAL_IMAGE_STYLE),
    direction: choice.model.direction,
    ...(choice.enabled ? { learningStyleId: learnBucket } : {}),
    copyExcerpt: htmlToText(node.body || ""),
    // Register the generated image in the Brand Kit library (best-effort).
    region: ctx.region,
    planId,
    nodeId,
    useBrandStyle,
    imageModel: parsed.data.model ? resolveImageModel(parsed.data.model) : undefined,
    ...(split
      ? {
          // The painted photo becomes the split card's half.
          finish: async (art) => {
            const drawn = await draw(art.bytes);
            return drawn ? { bytes: drawn.png, mimeType: "image/png" } : art;
          },
        }
      : overlay
      ? {
          finish: async (art) => {
            const drawn = await renderStyleImage({
              ctx,
              tenant,
              template: "art_overlay",
              size: SOCIAL_RENDER_SIZE[parsed.data.aspect],
              headline: words,
              art: art.bytes,
              showHeadline: overlay.showHeadline,
              showLogo: overlay.showLogo,
            });
            return drawn ? { bytes: drawn.png, mimeType: "image/png" } : art;
          },
        }
      : {}),
    brandContext: assembleBrandContext({
      brandVoice: resolveBrandVoiceText({
        tenantBrandVoice: tenant?.brandVoice,
        workspaceBrandVoice: ws.brandVoice,
      }),
      audience: ws.audience ?? null,
      brandKit: tenant?.brandKit ?? null,
      typography: tenant?.brandTypography ?? null,
      // Suppress the learned text directive too when the override is off (explicit null);
      // otherwise fall back to the kit's learned style (automatic apply).
      // Learning per style (image style on): what was learned for this image's style.
      learnedImageStyle: useBrandStyle ? (choice.enabled ? learnedDirectiveFor(tenant?.imageStyle, learnBucket) : undefined) : null,
    }),
  });

  // Split card without its photo (painting failed): the panel fills the frame.
  if (!result.imageAssetRef && split && words) {
    const drawn = await draw();
    const saved = drawn ? await saveDrawn(drawn) : null;
    if (saved) return saved;
  }
  if (!result.imageAssetRef) {
    return NextResponse.json(
      { error: result.reason, message: IMAGE_ERRORS[result.reason ?? ""] ?? "Image generation failed." },
      { status: 502 },
    );
  }

  // Persist the ref onto the node (transactional per-node write) so it's durable the moment
  // it's generated — no dependence on the operator clicking Save. A later whole-graph Save
  // re-writes the same values from local state.
  const updated = await updateContentPlanNode(ctx, workspaceId, planId, nodeId, {
    imageAssetRef: result.imageAssetRef,
    imageAspect: parsed.data.aspect,
    imagePrompt: result.imagePrompt ?? null,
    // Saved with the post, so a regenerate keeps this image's own style (and words).
    ...(choice.enabled ? { imageStyleId: choice.ownPick, imageHeadline: ownWords } : {}),
  });
  if (!updated) return NextResponse.json({ error: "node_not_found" }, { status: 404 });
  return NextResponse.json({
    imageAssetRef: updated.imageAssetRef,
    imagePrompt: updated.imagePrompt ?? null,
    ...(choice.enabled ? { imageStyleId: choice.ownPick, styleId: choice.model.styleId } : {}),
  });
}

/**
 * Clear a social post node's image — unset the node's image fields durably (so Remove
 * survives a reload, like generate). The inspector also clears local state via onUpdate.
 * We deliberately do NOT delete the stored asset: a scheduled Distribute post copies the
 * node's imageAssetRef by FILENAME (scheduler reads it at publish time), and Regenerate
 * likewise orphans-without-deleting — so the asset must outlive the node reference.
 * FLAG-GATED to match generation.
 */
export async function DELETE(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isSocialImageEnabled()) {
    return NextResponse.json({ error: "social_image_disabled" }, { status: 503 });
  }

  const { workspaceId, planId, nodeId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const node = plan.graph.nodes.find((n) => n.id === nodeId);
  if (!node) return NextResponse.json({ error: "node_not_found" }, { status: 404 });

  const updated = await updateContentPlanNode(ctx, workspaceId, planId, nodeId, {
    imageAssetRef: null,
    imageAspect: null,
    imagePrompt: null,
  });
  if (!updated) return NextResponse.json({ error: "node_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
