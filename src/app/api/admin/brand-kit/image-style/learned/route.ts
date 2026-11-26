import { NextResponse } from "next/server";
import { z } from "zod";
import { imageStyleAdmin } from "@/lib/content/imageStyle/admin";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { forgetReviewCount } from "@/lib/review/summary";
import {
  editLook,
  forgetLook,
  forgetPreview,
  goBackLook,
  keepLook,
  resumeSuggestions,
  setImageLearningPaused,
  undoLook,
  type ActionError,
  type ActionResult,
} from "@/lib/loops/actions";
import { IMAGE_STYLE_SCOPES } from "@/lib/loops/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What image style learned, changed by a person (learning loops step 4, 3.5): Undo, Pause and
 * Resume, Forget (and its counts for the confirm), Edit the words, Keep this look, Go back and
 * Resume suggestions, on Brand › Image style's What it learned card and Review's Go back cards.
 * Origin, image style versions on (which needs the image style on), sign in and admin
 * (imageStyleAdmin), then a strict body. The member comes from the session, never the body.
 */

const Scope = z.enum(IMAGE_STYLE_SCOPES);
const CardOrScope = z.union([z.object({ cardId: z.string().min(1).max(64) }).strict(), z.object({ scope: Scope }).strict()]);

const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("undo"), scope: Scope }).strict(),
  z.object({ op: z.literal("pause") }).strict(),
  z.object({ op: z.literal("resume") }).strict(),
  z.object({ op: z.literal("resume_suggestions") }).strict(),
  z.object({ op: z.literal("forget"), scope: Scope, alsoBrand: z.boolean().optional() }).strict(),
  z.object({ op: z.literal("forget_preview"), scope: Scope }).strict(),
  z.object({ op: z.literal("edit"), scope: Scope, text: z.string().max(4000) }).strict(),
  z.object({ op: z.literal("keep"), target: CardOrScope }).strict(),
  z.object({ op: z.literal("go_back"), target: CardOrScope }).strict(),
]);

const STATUS: Record<ActionError, number> = {
  switch: 503,
  scope: 400,
  nothing_to_undo: 409,
  nothing_to_forget: 409,
  forgotten: 409,
  words_removed: 409,
  moved: 409,
  not_found: 404,
  not_worse: 409,
  text_refused: 400,
  write_failed: 503,
};

function answer(r: ActionResult, tenantId: string): NextResponse {
  // A change to a look can close a Go back card, so Review's cached count is read afresh.
  if (r.ok) {
    forgetReviewCount(tenantId);
    return NextResponse.json(r);
  }
  return NextResponse.json({ error: r.error, ...(r.message ? { message: r.message } : {}) }, { status: STATUS[r.error] });
}

export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  // Versions need the image style itself on, so this switch answers first.
  if (!isImageStyleVersionsOn()) return NextResponse.json({ error: "image_style_versions_disabled" }, { status: 503 });
  const g = await imageStyleAdmin(req);
  if (!g.ok) return g.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const ctx = g.ctx;
  const body = parsed.data;
  switch (body.op) {
    case "undo":
      return answer(await undoLook(ctx, body.scope), ctx.tenantId);
    case "pause":
    case "resume":
      return answer(await setImageLearningPaused(ctx, body.op === "pause"), ctx.tenantId);
    case "resume_suggestions":
      return answer(await resumeSuggestions(ctx), ctx.tenantId);
    case "forget":
      return answer(await forgetLook(ctx, body.scope, { alsoBrand: body.alsoBrand === true }), ctx.tenantId);
    case "forget_preview": {
      const r = await forgetPreview(ctx, body.scope);
      return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: STATUS[r.error] });
    }
    case "edit":
      return answer(await editLook(ctx, body.scope, body.text), ctx.tenantId);
    case "keep":
    case "go_back":
      return answer(body.op === "keep" ? await keepLook(ctx, body.target) : await goBackLook(ctx, body.target), ctx.tenantId);
  }
}
