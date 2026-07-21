import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { setImageBrandVote } from "@/lib/admin/brandKit";
import { refreshExemplarStyle, refreshLearnedImageStyle } from "@/lib/content/create/styleProfile";
import { isBrandKitEnabled } from "@/lib/content/brandKit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ assetId: string }> };

// vote: "up" | "down" | null (clear). rating (1–10) only meaningful on "up".
const BodySchema = z.object({
  vote: z.enum(["up", "down"]).nullable(),
  rating: z.number().int().min(1).max(10).optional(),
});

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
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  // setImageBrandVote loads the row tenant-scoped and returns null if it doesn't exist for
  // this tenant, so it doubles as the 404 guard (no separate pre-read needed).
  const updated = await setImageBrandVote(ctx, assetId, {
    vote: parsed.data.vote,
    rating: parsed.data.rating ?? null,
  });
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

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

  return NextResponse.json({ image: updated });
}
