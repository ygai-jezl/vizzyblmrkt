import { NextResponse } from "next/server";
import { z } from "zod";
import { guardEbookRoute } from "@/lib/content/create/ebookRoute";
import { updateContentPlanEbook } from "@/lib/tenant/workspaceContent";
import { sanitizeEbookHtmlCapped } from "@/lib/content/create/ebookHtml";
import { CONTENT_PLAN_LIMITS, EbookDocSchema } from "@/lib/types/contentPlan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string }> };

const BodySchema = z.object({ ebook: EbookDocSchema });

/**
 * Persist the eBook draft (the studio's single write path for manual edits, ToC confirm,
 * chapter confirm, reorder, and — in v2 — image slot/resize/remove). The client sends the
 * whole doc; the server re-validates the SHAPE (schema caps) and re-SANITIZES every chapter
 * body server-side so stored HTML is always safe regardless of source. Flag-gated (503).
 */
export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId, planId } = await params;
  const guard = await guardEbookRoute(req, workspaceId, planId);
  if (guard.error) return guard.error;
  const { ctx } = guard.ok;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  // Server-authoritative HTML safety: sanitize every chapter body (capped so the escaped
  // output can never exceed MAX_CHAPTER_CHARS and throw on the schema parse) so a manual/chat
  // edit can never store unsafe or oversized markup.
  const ebook = {
    ...parsed.data.ebook,
    chapters: parsed.data.ebook.chapters.map((c) => ({
      ...c,
      bodyHtml: sanitizeEbookHtmlCapped(c.bodyHtml, CONTENT_PLAN_LIMITS.MAX_CHAPTER_CHARS),
    })),
  };

  const saved = await updateContentPlanEbook(ctx, workspaceId, planId, ebook);
  if (!saved) return NextResponse.json({ error: "save_failed" }, { status: 500 });
  return NextResponse.json({ ebook: saved });
}
