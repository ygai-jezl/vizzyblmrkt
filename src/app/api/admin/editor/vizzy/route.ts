import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { readRequestTextCapped } from "@/lib/http/readBody";
import { forTenant, isRateLimited } from "@/lib/tenant";
import type { RateLimitConfig } from "@/lib/tenant/rateLimit";
import { generateTextStream, isGeminiConfigured } from "@/lib/agents/gemini";
import { activeBrandVoiceText } from "@/lib/content/create/activeBrandVoice";
import { isEditModeVizzyEnabled } from "@/lib/content/editor/flags";
import { VizzyRequestSchema, extractVizzyResult, replyBoundary, type VizzyEvent } from "@/lib/content/editor/vizzyOps";
import { reviewSelection, reviewWhole, vizzyPrompt } from "@/lib/content/editor/vizzyPrompt";
import { brandCanUse } from "@/lib/plans/brandAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per brand: a person asks a few times a minute at most; the hourly cap bounds the cost. */
const LIMIT: RateLimitConfig = { prefix: "edit_vizzy", burstLimit: 20, hourlyLimit: 300 };

/** The longest a request may run: a selection is quick, the whole piece takes longer. */
const DEADLINE_MS = { selection: 30_000, whole: 50_000 } as const;

/** Enough for a 50,000 character email with its tokens and the text around a selection. */
const MAX_BODY_BYTES = 256_000;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/**
 * Vizzy inside Edit mode (SSE). Streams Vizzy's one-sentence reply (the fenced ops block held
 * back), then the change for a selection or the edits for the whole piece, each checked for lost
 * or made-up merge values and links. Writes nothing: the editor shows each change for the person
 * to keep or undo, and only their Save saves. Switch, then sign-in, then the brand's access.
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isEditModeVizzyEnabled()) return NextResponse.json({ error: "edit_vizzy_disabled" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await brandCanUse(ctx, "edit_vizzy"))) return NextResponse.json({ error: "not_included" }, { status: 403 });
  if (!isGeminiConfigured()) return NextResponse.json({ error: "ai_not_configured" }, { status: 503 });

  const raw = await readRequestTextCapped(req, MAX_BODY_BYTES);
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  const parsed = VizzyRequestSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const body = parsed.data;

  if (await isRateLimited(`tenant:${ctx.tenantId}`, LIMIT)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let workspaceVoice: string | null | undefined;
  if (body.workspaceId) {
    const ws = await forTenant(ctx)
      .workspaces.getById(body.workspaceId)
      .catch(() => null);
    if (!ws) return NextResponse.json({ error: "workspace_not_found" }, { status: 404 });
    workspaceVoice = ws.brandVoice;
  }
  const brandVoice = await activeBrandVoiceText(ctx.tenantId, workspaceVoice);
  const prompt = vizzyPrompt(body, { brandVoice });

  const deadline = AbortSignal.timeout(DEADLINE_MS[body.mode]);
  const signal = AbortSignal.any([req.signal, deadline]);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: VizzyEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          // The page closed.
        }
      };
      let full = "";
      let shown = 0;
      let held = false;
      try {
        for await (const chunk of generateTextStream(prompt, {
          signal,
          thinkingBudget: body.mode === "selection" ? 512 : 2048,
        })) {
          full += chunk;
          if (held) continue;
          const boundary = replyBoundary(full);
          if (boundary >= 0) {
            if (boundary > shown) emit({ type: "text", text: full.slice(shown, boundary) });
            shown = boundary;
            held = true;
          } else {
            // Hold back two characters so a fence split across chunks isn't shown.
            const end = Math.max(shown, full.length - 2);
            if (end > shown) emit({ type: "text", text: full.slice(shown, end) });
            shown = end;
          }
        }
        if (!held && full.length > shown) emit({ type: "text", text: full.slice(shown) });

        if (req.signal.aborted) return;
        if (deadline.aborted) {
          emit({ type: "error", message: "Vizzy took too long. Try a shorter piece or a narrower ask." });
        } else if (!full.trim()) {
          emit({ type: "error", message: "Vizzy couldn't reach the model just now. Try again." });
        } else {
          const result = extractVizzyResult(full, body.mode);
          if (!result) {
            if (held) emit({ type: "error", message: "Vizzy's answer couldn't be read. Try asking again." });
          } else if (body.mode === "selection" && result.mode === "selection") {
            const reviewed = reviewSelection(body, result);
            if (reviewed && "error" in reviewed) emit({ type: "error", message: reviewed.error });
            else if (reviewed) emit({ type: "selection", replacement: reviewed.replacement, warnings: reviewed.warnings });
          } else if (body.mode === "whole" && result.mode === "whole") {
            const reviewed = reviewWhole(body, result);
            emit({ type: "whole", ops: reviewed.ops, skipped: reviewed.skipped });
          }
        }
        emit({ type: "done" });
      } catch (err) {
        console.warn("[edit-vizzy] stream failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
        emit({ type: "error", message: "Something went wrong. Try again." });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
