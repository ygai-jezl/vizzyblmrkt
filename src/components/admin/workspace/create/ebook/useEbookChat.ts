"use client";

import { useCallback, useRef, useState } from "react";
import type { EbookDoc } from "@/lib/types/contentPlan";

/**
 * Client state machine for the eBook studio chat. Forks the dashboard chat's SSE-read +
 * requestAnimationFrame-batched flush (src/components/admin/chat/useDashboardChat.ts) but
 * points at the eBook chat route and understands its event vocabulary: `text` (streamed
 * reply, with the ops fence already withheld server-side), `ebook` (a persisted-draft
 * snapshot → handed to `onEbook` so the studio replaces its authoritative state), `error`,
 * `done`. Same-origin `__session` cookie auth (no Authorization header).
 *
 * `onBeforeSend` (if given) is awaited before the request so the studio can persist any
 * un-saved local edits first — the chat route mutates the PERSISTED draft, so without this
 * a chat edit would return a snapshot that wipes un-confirmed inline reading-pane edits.
 */
const GENERIC_ERROR = "Sorry — I hit an error. Please try again.";

export interface EbookChatMessage {
  role: "user" | "agent";
  text: string;
  isStreaming?: boolean;
}

interface EbookChatEvent {
  type: "text" | "ebook" | "error" | "done";
  text?: string;
  ebook?: EbookDoc;
  message?: string;
}

export function useEbookChat({
  workspaceId,
  planId,
  onEbook,
  onBeforeSend,
}: {
  workspaceId: string;
  planId: string;
  onEbook: (ebook: EbookDoc) => void;
  onBeforeSend?: () => Promise<void>;
}) {
  const [messages, setMessages] = useState<EbookChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  const accumulatedRef = useRef("");
  const errorRef = useRef<string | null>(null);
  const rafRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  // Robust reentrancy latch — state (isLoading/isStreaming) lags a render, so a fast second
  // submit could otherwise interleave two streams into the one shared accumulator/message.
  const inFlightRef = useRef(false);

  const flush = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const text = accumulatedRef.current;
      setMessages((prev) => {
        const updated = [...prev];
        const target = updated[updated.length - 1];
        if (target?.role === "agent") updated[updated.length - 1] = { ...target, text, isStreaming: true };
        return updated;
      });
      rafRef.current = null;
    });
  }, []);

  const finalizeAgent = useCallback((text: string) => {
    setMessages((prev) => {
      const updated = [...prev];
      const last = updated.findLastIndex((m) => m.role === "agent");
      const target = last >= 0 ? updated[last] : undefined;
      if (!target) return prev;
      updated[last] = { ...target, text, isStreaming: false };
      return updated;
    });
  }, []);

  const sendMessage = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed || inFlightRef.current) return;
      inFlightRef.current = true;

      setIsLoading(true);
      setIsStreaming(false);
      accumulatedRef.current = "";
      errorRef.current = null;
      setMessages((prev) => [...prev, { role: "user", text: trimmed }, { role: "agent", text: "", isStreaming: true }]);

      try {
        // Persist any un-saved local edits so the server mutates a current draft.
        if (onBeforeSend) await onBeforeSend().catch(() => {});

        const res = await fetch(
          `/api/admin/workspace/${workspaceId}/content-plans/${planId}/ebook/chat`,
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: trimmed }),
          },
        );
        if (!res.ok || !res.body) throw new Error(`ebook_chat_${res.status}`);
        setIsStreaming(true);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            let ev: EbookChatEvent;
            try {
              ev = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            if (ev.type === "text" && ev.text) {
              setIsLoading(false);
              accumulatedRef.current += ev.text;
              flush();
            } else if (ev.type === "ebook" && ev.ebook) {
              onEbook(ev.ebook);
            } else if (ev.type === "error") {
              // Record — the finalize below surfaces it ALONGSIDE any reply, so a failed save
              // is never masked as success (the reply may cheerfully say "renamed it!").
              errorRef.current = ev.message || GENERIC_ERROR;
            }
          }
        }
        finalizeAgent(composeFinal(accumulatedRef.current, errorRef.current));
      } catch (err) {
        console.error("[ebook-chat] stream error:", err);
        finalizeAgent(composeFinal(accumulatedRef.current, GENERIC_ERROR));
      } finally {
        setIsLoading(false);
        setIsStreaming(false);
        inFlightRef.current = false;
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      }
    },
    [workspaceId, planId, onEbook, onBeforeSend, flush, finalizeAgent],
  );

  return { messages, isLoading, isStreaming, sendMessage };
}

/** Show the reply, and — when the save failed — append the error so it's never masked. */
function composeFinal(reply: string, error: string | null): string {
  if (error) return reply.trim() ? `${reply}\n\n⚠️ ${error}` : error;
  return reply.trim() ? reply : "Done.";
}
