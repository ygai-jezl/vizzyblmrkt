import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import {
  isAgentRuntimeConfigured,
  getAccessToken,
  reasoningEngineUrl,
  contextEnvelope,
  compositeUserId,
  createAgentSession,
  mapVertexEvent,
  parseUpstreamRecords,
} from "@/lib/agents/agentRuntime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dashboard root-agent chat proxy. Authenticates via the same-origin admin
 * session, then streams from the deployed Agent Runtime reasoningEngine
 * (`:streamQuery?alt=sse`), injecting tenant/user context as a `[ctx:{…}]`
 * message prefix (Vertex rejects unknown root fields). The raw Vertex SSE is
 * re-framed into the normalized event vocabulary the client hook consumes
 * (`thought | text | tool_start | tool_result | done | error`).
 *
 * Before the agent is deployed (no ROOT_AGENT_RESOURCE_ID), it streams a clear
 * "not configured" message so the dashboard stays usable.
 */
const Body = z.object({
  message: z.string().min(1).max(8000),
  // nullish (not optional): the client hook starts sessionId as `null` and sends
  // it on the first turn — `optional()` would 400 on null.
  sessionId: z.string().nullish(),
  mode: z.enum(["thinking", "fast"]).default("thinking"),
});

const encoder = new TextEncoder();
const sse = (event: unknown) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;

  const ctx = await getAdminContext();
  if (!ctx || !ctx.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const { message, sessionId, mode } = parsed.data;

  if (!isAgentRuntimeConfigured()) {
    return new Response(unconfiguredStream(), { headers: SSE_HEADERS });
  }

  const traceId = randomUUID();
  const userId = compositeUserId(ctx);
  const text = contextEnvelope(ctx, traceId, mode) + message;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: unknown) => {
        try {
          controller.enqueue(sse(event));
        } catch {
          // controller closed (client disconnected)
        }
      };

      let resolvedSession = sessionId ?? null;
      try {
        // A stable session id is needed for multi-turn continuity. Mint one if
        // the client didn't supply it; degrade to runtime auto-create on failure.
        if (!resolvedSession) {
          try {
            resolvedSession = await createAgentSession(userId);
          } catch (err) {
            console.warn("[agent-chat] session create failed, auto-creating:", err);
          }
        }

        const token = await getAccessToken();
        const input: Record<string, unknown> = { user_id: userId, message: text };
        if (resolvedSession) input.session_id = resolvedSession;

        const upstream = await fetch(reasoningEngineUrl("streamQuery", true), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ class_method: "async_stream_query", input }),
        });

        if (!upstream.ok || !upstream.body) {
          const detail = await upstream.text().catch(() => "");
          emit({ type: "error", message: `Agent error (${upstream.status}).` });
          console.error("[agent-chat] upstream not ok:", upstream.status, detail);
          emit({ type: "done", sessionId: resolvedSession ?? undefined });
          return;
        }

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        const dedup = { sawPartialText: false };
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const evt of parseUpstreamRecords(lines)) {
            for (const normalized of mapVertexEvent(evt, dedup)) emit(normalized);
          }
        }
        // flush any trailing buffered record
        if (buffer.trim()) {
          for (const evt of parseUpstreamRecords([buffer])) {
            for (const normalized of mapVertexEvent(evt, dedup)) emit(normalized);
          }
        }

        emit({ type: "done", sessionId: resolvedSession ?? undefined });
      } catch (err) {
        console.error("[agent-chat] stream error:", err);
        emit({ type: "error", message: "Sorry — I hit an error. Please try again." });
        emit({ type: "done", sessionId: resolvedSession ?? undefined });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/** Pre-deploy fallback: explain that the agent isn't wired up yet. */
function unconfiguredStream(): ReadableStream<Uint8Array> {
  const lines = [
    "The root agent isn't deployed yet.",
    "",
    "Deploy `agents/root_agent` to Agent Runtime, then set **ROOT_AGENT_RESOURCE_ID** (and **ROOT_AGENT_LOCATION**) in the App Hosting config. The dashboard chat will connect automatically.",
  ].join("\n");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of lines.match(/\S+\s*/g) ?? [lines]) {
        controller.enqueue(sse({ type: "text", text: part }));
      }
      controller.enqueue(sse({ type: "done" }));
      controller.close();
    },
  });
}
