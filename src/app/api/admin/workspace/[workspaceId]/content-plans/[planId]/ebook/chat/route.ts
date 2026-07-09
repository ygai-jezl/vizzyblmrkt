import { NextResponse } from "next/server";
import { z } from "zod";
import { guardEbookRoute } from "@/lib/content/create/ebookRoute";
import { mutateContentPlanEbookDraft } from "@/lib/tenant/workspaceContent";
import { applyEbookOps, extractEbookOps } from "@/lib/content/create/ebookOps";
import { generateTextStream } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import type { EbookDoc } from "@/lib/types/contentPlan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string }> };

const BodySchema = z.object({ message: z.string().min(1).max(2000) });

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/** Earliest index where the machine-only ops block begins: a ``` fence or a bare `{"ops"`. */
function opsBoundary(s: string): number {
  const fence = s.indexOf("```");
  const bare = s.search(/\{\s*"ops"/);
  if (fence < 0) return bare;
  if (bare < 0) return fence;
  return Math.min(fence, bare);
}

/** A compact, id-labelled outline the chat prompt edits against (never expose raw bodyHtml). */
function outlineFor(ebook: EbookDoc): string {
  const chapters = ebook.chapters.length
    ? ebook.chapters
        .map((c, i) => {
          const imgs = c.images.length ? ` [image slots: ${c.images.map((s) => s.id).join(", ")}]` : "";
          return `${i + 1}. (id: ${c.id}) ${c.title} — ${c.summary || "(no summary)"} [status: ${c.status}]${imgs}`;
        })
        .join("\n")
    : "(no chapters yet)";
  return [
    `Title: ${ebook.title}`,
    `Subtitle: ${ebook.subtitle || "(none)"}`,
    `Industry lens: ${ebook.industryLens || "(none)"}`,
    `Table of contents confirmed: ${ebook.tocConfirmed}`,
    "",
    "Chapters:",
    chapters,
  ].join("\n");
}

/**
 * The eBook studio chat (SSE). Streams the assistant's conversational reply (with the fenced
 * `ops` block withheld from the display), then extracts + validates any edit ops and applies
 * them server-authoritatively via the transactional draft mutator (never a blind whole-doc
 * write — so a concurrent edit isn't clobbered). Emits a terminal `{type:"ebook"}` snapshot
 * when the doc changed, then `{type:"done"}`. Flag-gated via guardEbookRoute.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId, planId } = await params;
  const guard = await guardEbookRoute(req, workspaceId, planId);
  if (guard.error) return guard.error;
  const { ctx, plan } = guard.ok;

  if (!plan.ebookDraft) return NextResponse.json({ error: "ebook_not_authored" }, { status: 400 });

  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const prompt = renderPrompt("content.ebook_chat", {
    outline: outlineFor(plan.ebookDraft),
    message: parsed.data.message,
  });

  const encoder = new TextEncoder();
  const sse = (e: unknown) => encoder.encode(`data: ${JSON.stringify(e)}\n\n`);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: unknown) => controller.enqueue(sse(e));
      let full = "";
      let displayed = 0; // chars of `full` already streamed to the UI
      let fenceHit = false;
      try {
        for await (const chunk of generateTextStream(prompt)) {
          full += chunk;
          if (fenceHit) continue; // everything from the ops block on is machine-only
          // Boundary = the ```ops fence OR a bare `{"ops"` object (the model sometimes skips
          // the fence — extractEbookOps handles that, so the display must too).
          const boundary = opsBoundary(full);
          if (boundary >= 0) {
            if (boundary > displayed) emit({ type: "text", text: full.slice(displayed, boundary) });
            displayed = boundary;
            fenceHit = true;
          } else {
            // Hold back the last 2 chars so a fence split across chunks ("``" + "`") isn't shown.
            const safeEnd = Math.max(displayed, full.length - 2);
            if (safeEnd > displayed) {
              emit({ type: "text", text: full.slice(displayed, safeEnd) });
              displayed = safeEnd;
            }
          }
        }
        if (!fenceHit && full.length > displayed) emit({ type: "text", text: full.slice(displayed) });
        if (!full.trim()) emit({ type: "text", text: "I couldn't reach the model right now — try again." });

        const ops = extractEbookOps(full);
        if (ops.length) {
          const saved = await mutateContentPlanEbookDraft(ctx, workspaceId, planId, (draft) =>
            applyEbookOps(draft, ops),
          ).catch(() => null);
          if (saved) emit({ type: "ebook", ebook: saved });
          else emit({ type: "error", message: "I couldn't save that change — try again." });
        }
        emit({ type: "done" });
      } catch (err) {
        console.warn("[ebook] chat stream failed:", err);
        emit({ type: "error", message: "Something went wrong — try again." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
