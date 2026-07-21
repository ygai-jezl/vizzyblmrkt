import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getTenantById } from "@/lib/tenant";
import { guardEbookRoute } from "@/lib/content/create/ebookRoute";
import { mutateContentPlanEbookDraft } from "@/lib/tenant/workspaceContent";
import { generateEbookSlotImage } from "@/lib/agents/creative";
import { assembleBrandContext } from "@/lib/content/create/brandContext";
import { applyGeneratedImage, draftHasImageRef } from "@/lib/content/create/ebookOps";
import { EBOOK_IMAGE_STYLE_IDS } from "@/lib/content/create/ebook";
import { deleteWorkspaceAsset } from "@/lib/workspace/assetStore";
import { deleteImageAsset } from "@/lib/admin/brandKit";
import { EbookAspect } from "@/lib/types/contentPlan";
import { htmlToText } from "@/lib/email/emailRender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string }> };

const TargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("slot"), chapterId: z.string().min(1).max(64), slotId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("new"), chapterId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("cover") }),
]);

const BodySchema = z.object({
  target: TargetSchema,
  brief: z.string().max(1000).default(""),
  aspect: EbookAspect,
  style: z.enum(EBOOK_IMAGE_STYLE_IDS),
  mode: z.enum(["create", "edit"]).default("create"),
  instruction: z.string().max(1000).optional(),
  /** Brand-style loop override (default true = apply learned style + references). */
  useBrandStyle: z.boolean().optional(),
});

const IMAGE_ERRORS: Record<string, string> = {
  image_model_unavailable: "The image model isn't available right now.",
  no_asset_bucket: "Image storage isn't configured.",
  store_failed: "Couldn't save the image — try again.",
  bad_type: "The model returned an unsupported image type.",
  too_large: "The generated image was too large.",
  prior_too_large: "The image to edit is too large (max 7 MB).",
  prior_unreadable: "Couldn't load the image to edit — try again.",
};

/**
 * Generate OR iteratively edit an on-brand eBook image and persist it onto the draft. Target
 * is a `slot` (existing placeholder / regenerate), `new` (append a fresh slot to a chapter),
 * or `cover`. mode:"edit" feeds the current image back with `instruction`. Persists via the
 * transactional draft mutator. Flag-gated via guardEbookRoute. Returns the updated draft.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId, planId } = await params;
  const guard = await guardEbookRoute(req, workspaceId, planId);
  if (guard.error) return guard.error;
  const { ctx, ws, plan } = guard.ok;

  const ebook = plan.ebookDraft;
  if (!ebook) return NextResponse.json({ error: "ebook_not_authored" }, { status: 400 });

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const { target, brief, aspect, style, mode, instruction } = parsed.data;

  // Resolve target context (validate ids up front) + the prior image/aspect for an edit.
  let priorImageRef: string | null = null;
  let priorAspect: z.infer<typeof EbookAspect> | null = null;
  let copyExcerpt = "";
  if (target.kind === "slot" || target.kind === "new") {
    const chapter = ebook.chapters.find((c) => c.id === target.chapterId);
    if (!chapter) return NextResponse.json({ error: "chapter_not_found" }, { status: 404 });
    copyExcerpt = htmlToText(chapter.bodyHtml || "");
    if (target.kind === "slot") {
      const slot = chapter.images.find((s) => s.id === target.slotId);
      if (!slot) return NextResponse.json({ error: "slot_not_found" }, { status: 404 });
      priorImageRef = slot.imageAssetRef ?? null;
      priorAspect = slot.aspect;
    }
  } else {
    priorImageRef = ebook.coverImage?.imageAssetRef ?? null;
    priorAspect = ebook.coverImage?.aspect ?? null;
    copyExcerpt = ebook.subtitle || ebook.chapters[0]?.summary || "";
  }

  if (mode === "edit") {
    if (!instruction?.trim()) return NextResponse.json({ error: "missing_instruction" }, { status: 400 });
    if (!priorImageRef) return NextResponse.json({ error: "no_prior_image" }, { status: 400 });
  }

  // An EDIT must keep the existing image's aspect (the client can't change it via a colour
  // tweak) — server-authoritative so a 1:4 slot/cover isn't silently squashed to 1:1.
  const effectiveAspect: z.infer<typeof EbookAspect> = mode === "edit" && priorAspect ? priorAspect : aspect;

  const tenant = await getTenantById(ctx.tenantId);
  const useBrandStyle = parsed.data.useBrandStyle !== false;
  const result = await generateEbookSlotImage({
    tenantId: ctx.tenantId,
    workspaceId,
    brief: mode === "edit" ? instruction!.trim() : brief,
    aspect: effectiveAspect,
    style,
    copyExcerpt,
    priorImageRef: mode === "edit" ? priorImageRef : null,
    // Register the generated image in the Brand Kit library (best-effort).
    region: ctx.region,
    planId,
    chapterId: target.kind === "cover" ? undefined : target.chapterId,
    useBrandStyle,
    // Best-of-N is reserved for the hero surface (cover) to bound cost on long eBooks.
    heroSurface: target.kind === "cover",
    brandContext: assembleBrandContext({
      brandVoice: ws.brandVoice ?? null,
      audience: ws.audience ?? null,
      brandKit: tenant?.brandKit ?? null,
      learnedImageStyle: useBrandStyle ? undefined : null,
    }),
  });

  if (!result.imageAssetRef) {
    const status = result.reason === "prior_too_large" ? 400 : 502;
    return NextResponse.json(
      { error: result.reason, message: IMAGE_ERRORS[result.reason ?? ""] ?? "Image generation failed." },
      { status },
    );
  }
  const ref = result.imageAssetRef;

  const saved = await mutateContentPlanEbookDraft(ctx, workspaceId, planId, (draft) =>
    applyGeneratedImage(
      draft,
      target,
      { imageAssetRef: ref, imagePrompt: result.imagePrompt, aspect: effectiveAspect, contextPrompt: mode === "edit" ? undefined : brief },
      () => `img_${randomUUID()}`,
    ),
  );
  if (!saved) return NextResponse.json({ error: "save_failed" }, { status: 500 });
  // If the mutate no-op'd (target full / removed concurrently), the just-stored asset is an
  // orphan — clean it up and tell the operator rather than reporting a false success.
  if (!draftHasImageRef(saved, target, ref)) {
    await deleteWorkspaceAsset(ctx.tenantId, workspaceId, ref).catch(() => {});
    // The best-effort Brand Kit registry row (if one was written) now points at deleted
    // bytes — remove it so the gallery doesn't show a permanent broken tile.
    if (result.imageAssetId) await deleteImageAsset(ctx, result.imageAssetId).catch(() => {});
    return NextResponse.json(
      { error: "not_applied", message: "Couldn't attach the image — the chapter may be full or was changed. Try again." },
      { status: 409 },
    );
  }
  return NextResponse.json({ ebook: saved, imageAssetRef: ref });
}
