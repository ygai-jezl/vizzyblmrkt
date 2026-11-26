import { NextResponse } from "next/server";
import { z } from "zod";
import { imageStyleAdmin, imageStyleMember } from "@/lib/content/imageStyle/admin";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { forgetReviewCount } from "@/lib/review/summary";
import {
  editLook,
  forgetLook,
  forgetPreview,
  forgetUndone,
  goBackLook,
  keepLook,
  resumeSuggestions,
  setHelpCheck,
  setImageLearningPaused,
  undoLook,
  type ActionError,
  type ActionResult,
} from "@/lib/loops/actions";
import { IMAGE_STYLE_SCOPES } from "@/lib/loops/registry";
import { imageVoteView, learnedCardView } from "@/lib/loops/learnedView";
import { FORGOTTEN_MESSAGE, WORDS_REMOVED_MESSAGE } from "@/lib/loops/learnedWords";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What image style learned (learning loops step 4).
 * - GET, for any member: the What it learned card (screen 1); or, with `image` (a filename) or
 *   `asset` (an id) and an optional `style`, one image's vote, its reason and note, how it was made
 *   and the new look notice (screens 1b and 2). Image style versions on, then sign in.
 * - POST, admins only, changed by a person (3.5): Undo, Pause and Resume, Forget (and its counts for
 *   the confirm, and Forget of the look an Undo just left), Edit the words, Keep this look, Go back,
 *   Resume suggestions, and the learning setting (help_check). Origin, image style versions on
 *   (which needs the image style on), sign in and admin (imageStyleAdmin), then a strict body.
 * The member comes from the session, never the body or the query.
 */

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export async function GET(req: Request) {
  if (!isImageStyleVersionsOn()) return NextResponse.json({ error: "image_style_versions_disabled" }, { status: 503 });
  const g = await imageStyleMember();
  if (!g.ok) return g.response;
  const url = new URL(req.url);
  const file = url.searchParams.get("image");
  const asset = url.searchParams.get("asset");
  const style = url.searchParams.get("style");
  const headers = { "cache-control": "no-store" };
  if (file !== null || asset !== null || style !== null) {
    if ((file !== null && !ID.test(file)) || (asset !== null && !ID.test(asset)) || (style !== null && !/^[a-z0-9_]{1,40}$/.test(style))) {
      return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    }
    const view = await imageVoteView(g.ctx, { ...(asset ? { assetId: asset } : file ? { file } : {}), style });
    return NextResponse.json(view, { headers });
  }
  return NextResponse.json(await learnedCardView(g.ctx), { headers });
}

const Scope = z.enum(IMAGE_STYLE_SCOPES);
const CardOrScope = z.union([z.object({ cardId: z.string().min(1).max(64) }).strict(), z.object({ scope: Scope }).strict()]);

const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("undo"), scope: Scope }).strict(),
  z.object({ op: z.literal("pause") }).strict(),
  z.object({ op: z.literal("resume") }).strict(),
  z.object({ op: z.literal("resume_suggestions") }).strict(),
  z.object({ op: z.literal("forget"), scope: Scope, alsoBrand: z.boolean().optional() }).strict(),
  z.object({ op: z.literal("forget_preview"), scope: Scope }).strict(),
  z.object({ op: z.literal("forget_undone"), scope: Scope }).strict(),
  z.object({ op: z.literal("help_check"), on: z.boolean() }).strict(),
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

/** Refusals a person can't fix by trying again, said plainly instead of the card's retry line. */
const MESSAGES: Partial<Record<ActionError, string>> = {
  words_removed: WORDS_REMOVED_MESSAGE,
  forgotten: FORGOTTEN_MESSAGE,
};

function answer(r: ActionResult, tenantId: string): NextResponse {
  // A change to a look can close a Go back card, so Review's cached count is read afresh.
  if (r.ok) {
    forgetReviewCount(tenantId);
    return NextResponse.json(r);
  }
  const message = r.message ?? MESSAGES[r.error];
  return NextResponse.json({ error: r.error, ...(message ? { message } : {}) }, { status: STATUS[r.error] });
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
    case "forget_undone":
      return answer(await forgetUndone(ctx, body.scope), ctx.tenantId);
    case "help_check":
      return answer(await setHelpCheck(ctx, body.on), ctx.tenantId);
    case "edit":
      return answer(await editLook(ctx, body.scope, body.text), ctx.tenantId);
    case "keep":
    case "go_back":
      return answer(body.op === "keep" ? await keepLook(ctx, body.target) : await goBackLook(ctx, body.target), ctx.tenantId);
  }
}
