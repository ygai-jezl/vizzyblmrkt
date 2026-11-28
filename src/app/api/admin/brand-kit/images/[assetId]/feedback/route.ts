import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { setImageBrandVote, setImageVoteReason, type VoteReasonRefusal } from "@/lib/admin/brandKit";
import {
  refreshExemplarStyle,
  refreshLearnedImageStyle,
  refreshLearnedStyleBucket,
} from "@/lib/content/create/styleProfile";
import { canonicalStyleId } from "@/lib/content/imageStyle/catalogue";
import { learnsFromThumbs } from "@/lib/content/imageStyle/learning";
import { isBrandImageStyleEnabled, isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { isBrandKitEnabled } from "@/lib/content/brandKit";
import { VOTE_NOTE_CHARS } from "@/lib/loops/reasons";
import { NOTE_REFUSED_MESSAGE } from "@/lib/loops/textCheck";
import { profileImage } from "@/lib/loops/learners/votes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ assetId: string }> };

// vote: "up" | "down" | null (clear). rating (1–10) only meaningful on "up".
const BodySchema = z.object({
  vote: z.enum(["up", "down"]).nullable(),
  rating: z.number().int().min(1).max(10).optional(),
});

/**
 * The why behind a vote, sent after the vote has saved (learning loops step 4, 3.11): a reason
 * key for the vote's direction, or null to clear it, and an optional note. Only with image style
 * versions on; with them off a body like this is refused as before.
 */
const ReasonSchema = z
  .object({
    reason: z.string().min(1).max(40).nullable(),
    note: z.string().max(VOTE_NOTE_CHARS).nullable().optional(),
  })
  .strict();

const REASON_STATUS: Record<VoteReasonRefusal, number> = { not_found: 404, no_vote: 409, invalid_reason: 400, note_refused: 400 };

/**
 * Brand Kit feedback: record the operator's on-brand verdict on an image — 👍 (with a
 * 1–10 rating), 👎, or clear. A 👍 kicks off the L1 style distillation (extract this
 * image's aesthetic + re-synthesize the tenant's learned style); a 👎 / clear just
 * re-synthesizes from the remaining exemplars. The style work is fire-and-forget so the
 * vote returns instantly and never fails on a model blip. Tenant-scoped load + write.
 * FLAG-GATED (503 until BRAND_KIT_ENABLED).
 */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isBrandKitEnabled()) {
    return NextResponse.json({ error: "brand_kit_disabled" }, { status: 503 });
  }

  const { assetId } = await params;
  const body: unknown = await req.json().catch(() => null);

  // The why behind the vote, after it saved: kept on the image's row, and counted once.
  if (isImageStyleVersionsOn() && body && typeof body === "object" && !("vote" in body)) {
    const why = ReasonSchema.safeParse(body);
    if (!why.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    const kept = await setImageVoteReason(ctx, assetId, { reason: why.data.reason, note: why.data.note ?? null });
    if (kept.ok) return NextResponse.json({ image: kept.image });
    return NextResponse.json(
      kept.error === "note_refused" ? { error: kept.error, message: NOTE_REFUSED_MESSAGE } : { error: kept.error },
      { status: REASON_STATUS[kept.error] },
    );
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  // setImageBrandVote loads the row tenant-scoped and returns null if it doesn't exist for
  // this tenant, so it doubles as the 404 guard (no separate pre-read needed).
  const updated = await setImageBrandVote(ctx, assetId, {
    vote: parsed.data.vote,
    rating: parsed.data.rating ?? null,
  });
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // With image style versions on (learning loops step 4, decision 7), setImageBrandVote kept and
  // counted the vote, and no look is rewritten here: the votes learner runs in the loops lane. Any
  // vote, up or down, profiles its image if it has no profile yet (one call under loop_learn), so
  // the lane rarely has to; profileImage does nothing while image learning is paused.
  if (isImageStyleVersionsOn()) {
    if (parsed.data.vote) {
      await profileImage(ctx, assetId).catch((err) => {
        console.warn("[loops] profiling a voted image failed", err instanceof Error ? err.message.slice(0, 200) : "error");
      });
    }
    return NextResponse.json({ image: updated });
  }

  // Run style distillation INLINE (awaited), not as an after-response background task:
  // App Hosting / Cloud Run throttles CPU once the response is sent, so a fire-and-forget
  // vision+synthesis would frequently never complete and the loop would silently never
  // learn. It's fully fail-soft (each step swallows its own errors) so awaiting can't fail
  // the vote — which is already persisted above — and it no-ops instantly when the loop
  // flag is off (so prod adds no latency until enabled). A fresh 👍 analyses this image
  // first; a 👎 / clear only re-synthesizes from what remains.
  if (parsed.data.vote === "up") {
    await refreshExemplarStyle(ctx, assetId).catch(() => {});
  } else {
    await refreshLearnedImageStyle(ctx).catch(() => {});
  }
  // Learning per style (BRAND_IMAGE_STYLE_ENABLED): the vote also teaches the image's own style.
  const bucket = canonicalStyleId(updated.style);
  if (isBrandImageStyleEnabled() && bucket && learnsFromThumbs(bucket)) {
    await refreshLearnedStyleBucket(ctx, bucket).catch(() => {});
  }

  return NextResponse.json({ image: updated });
}
