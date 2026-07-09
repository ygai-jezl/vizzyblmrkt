import { NextResponse } from "next/server";
import { guardEbookRoute } from "@/lib/content/create/ebookRoute";
import { updateContentPlanChapter } from "@/lib/tenant/workspaceContent";
import {
  buildChapterPrompt,
  parseChapterImagePlaceholders,
  fallbackChapterHtml,
} from "@/lib/content/create/ebookChapter";
import { generateTextStream } from "@/lib/agents/gemini";
import { retrieveSemanticKnowledgeContext } from "@/lib/agents/knowledgeRetrieval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ workspaceId: string; planId: string; chapterId: string }>;
};

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/**
 * Stream one eBook chapter as it's written (SSE). Emits `{type:"text"}` chunks for the live
 * preview, then on completion parses `[[image: …]]` placeholders into image SLOTS, persists
 * the chapter (status:"generated") onto the plan's ebookDraft, and emits a terminal
 * `{type:"chapter"}` + `{type:"done"}`. Falls back to a deterministic chapter if the stream
 * is empty (Gemini off / errored). Flag-gated via guardEbookRoute (503 when off).
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId, planId, chapterId } = await params;
  const guard = await guardEbookRoute(req, workspaceId, planId);
  if (guard.error) return guard.error;
  const { ctx, ws, plan } = guard.ok;

  const ebook = plan.ebookDraft;
  if (!ebook) return NextResponse.json({ error: "ebook_not_authored" }, { status: 400 });
  if (!ebook.tocConfirmed) return NextResponse.json({ error: "toc_not_confirmed" }, { status: 400 });
  const idx = ebook.chapters.findIndex((c) => c.id === chapterId);
  if (idx < 0) return NextResponse.json({ error: "chapter_not_found" }, { status: 404 });
  const chapter = ebook.chapters[idx]!;

  // Ground the chapter: query = book title + chapter title/summary; scoped → first topic.
  const scopedTopic =
    plan.knowledge.groundingScope === "scoped" ? plan.scope.topics[0] : undefined;
  const queryText = [ebook.title, chapter.title, chapter.summary, plan.scope.industryLens]
    .filter(Boolean)
    .join(" — ");
  const rag = await retrieveSemanticKnowledgeContext({
    ctx,
    ownerKind: "workspace",
    ownerId: workspaceId,
    queryText,
    limit: 8,
    bypassEnabledFlag: true,
    ...(scopedTopic ? { filter: { topic: scopedTopic } } : {}),
  }).catch(() => null);

  const prompt = buildChapterPrompt({
    bookTitle: ebook.title,
    spark: plan.scope.spark,
    industryLens: ebook.industryLens || plan.scope.industryLens,
    priorChapterTitles: ebook.chapters.slice(0, idx).map((c) => c.title),
    chapterTitle: chapter.title,
    chapterSummary: chapter.summary,
    knowledgeContext: rag?.formatted ?? "",
    proofAssets: plan.knowledge.proofAssets,
    brandVoice: ws.brandVoice ?? null,
    audience: ws.audience ?? null,
  });

  const encoder = new TextEncoder();
  const sse = (e: unknown) => encoder.encode(`data: ${JSON.stringify(e)}\n\n`);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: unknown) => controller.enqueue(sse(e));
      let full = "";
      try {
        for await (const chunk of generateTextStream(prompt)) {
          full += chunk;
          emit({ type: "text", text: chunk });
        }

        const hasText = full.trim().length > 0;
        const parsed = hasText
          ? parseChapterImagePlaceholders(full)
          : { bodyHtml: fallbackChapterHtml(chapter.title, chapter.summary), images: [] };

        // Patch ONLY this chapter transactionally (re-reads the current draft inside the tx),
        // so a concurrent edit to another chapter isn't clobbered by a request-start snapshot.
        const savedChapter = await updateContentPlanChapter(ctx, workspaceId, planId, chapterId, {
          bodyHtml: parsed.bodyHtml,
          images: parsed.images,
          status: "generated",
        }).catch(() => null);

        if (!savedChapter) {
          // Persist failed (plan/chapter gone, or a transient write error) — surface it
          // rather than reporting a success the reload would silently drop.
          emit({ type: "error", message: "Chapter generated but couldn't be saved — try again." });
        } else {
          emit({ type: "chapter", chapter: savedChapter });
        }
        emit({ type: "done" });
      } catch (err) {
        console.warn("[ebook] chapter stream failed:", err);
        emit({ type: "error", message: "Chapter generation failed — try again." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
