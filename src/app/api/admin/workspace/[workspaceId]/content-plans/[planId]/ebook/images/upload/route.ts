import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { guardEbookRoute } from "@/lib/content/create/ebookRoute";
import { mutateContentPlanEbookDraft } from "@/lib/tenant/workspaceContent";
import { applyGeneratedImage, draftHasImageRef } from "@/lib/content/create/ebookOps";
import {
  storeWorkspaceImage,
  deleteWorkspaceAsset,
  isAllowedScreenshotType,
  MAX_SCREENSHOT_BYTES,
} from "@/lib/workspace/assetStore";
import { EbookAspect } from "@/lib/types/contentPlan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string }> };

const TargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("slot"), chapterId: z.string().min(1).max(64), slotId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("new"), chapterId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("cover") }),
]);

const UPLOAD_ERRORS: Record<string, string> = {
  no_asset_bucket: "Image storage isn't configured.",
  store_failed: "Couldn't save the image — try again.",
  bad_type: "Unsupported image type — use PNG, JPEG, or WebP.",
  too_large: "That image is too large (max 8 MB).",
};

/**
 * Upload an operator-provided image and attach it to an eBook slot / new slot / cover (an
 * alternative to AI generation). Reuses storeWorkspaceImage (magic-byte sniff + size cap) and
 * persists via the transactional draft mutator. Flag-gated via guardEbookRoute.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId, planId } = await params;
  const guard = await guardEbookRoute(req, workspaceId, planId);
  if (guard.error) return guard.error;
  const { ctx, plan } = guard.ok;

  const ebook = plan.ebookDraft;
  if (!ebook) return NextResponse.json({ error: "ebook_not_authored" }, { status: 400 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const file = form.get("file");
  if (!file || typeof file === "string") return NextResponse.json({ error: "no_file" }, { status: 400 });
  // Guard size/type BEFORE buffering the body (matches the sibling upload routes).
  if (file.size > MAX_SCREENSHOT_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });
  if (!isAllowedScreenshotType(file.type)) return NextResponse.json({ error: "bad_type" }, { status: 400 });

  let target: z.infer<typeof TargetSchema>;
  try {
    target = TargetSchema.parse(JSON.parse(String(form.get("target") ?? "")));
  } catch {
    return NextResponse.json({ error: "invalid_target" }, { status: 400 });
  }
  const aspectParsed = EbookAspect.safeParse(form.get("aspect"));
  const aspect = aspectParsed.success ? aspectParsed.data : "1:1";

  // Validate target ids so we don't store an orphan asset for a bad target.
  if (target.kind === "slot" || target.kind === "new") {
    const chapter = ebook.chapters.find((c) => c.id === target.chapterId);
    if (!chapter) return NextResponse.json({ error: "chapter_not_found" }, { status: 404 });
    if (target.kind === "slot" && !chapter.images.some((s) => s.id === target.slotId)) {
      return NextResponse.json({ error: "slot_not_found" }, { status: 404 });
    }
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const stored = await storeWorkspaceImage(ctx.tenantId, workspaceId, bytes, file.type);
  if (!stored.ok) {
    return NextResponse.json(
      { error: stored.reason, message: UPLOAD_ERRORS[stored.reason] ?? "Upload failed." },
      { status: stored.reason === "too_large" || stored.reason === "bad_type" ? 400 : 502 },
    );
  }

  const saved = await mutateContentPlanEbookDraft(ctx, workspaceId, planId, (draft) =>
    applyGeneratedImage(
      draft,
      target,
      { imageAssetRef: stored.filename, imagePrompt: null, aspect, contextPrompt: "" },
      () => `img_${randomUUID()}`,
    ),
  );
  if (!saved) return NextResponse.json({ error: "save_failed" }, { status: 500 });
  // Clean up an orphan if the mutate no-op'd (target full / removed concurrently).
  if (!draftHasImageRef(saved, target, stored.filename)) {
    await deleteWorkspaceAsset(ctx.tenantId, workspaceId, stored.filename).catch(() => {});
    return NextResponse.json(
      { error: "not_applied", message: "Couldn't attach the image — the chapter may be full or was changed." },
      { status: 409 },
    );
  }
  return NextResponse.json({ ebook: saved, imageAssetRef: stored.filename });
}
