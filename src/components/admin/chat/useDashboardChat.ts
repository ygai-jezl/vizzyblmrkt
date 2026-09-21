"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseSSE } from "./streamTypes";
import { type ChatMode, DEFAULT_CHAT_MODE } from "./chatModes";

/**
 * Client state machine for the dashboard root-agent chat. Ported from the
 * sibling portal's useStreamingChat, stripped of its Firebase-client auth and
 * tenant hooks: this app authenticates the proxy via the same-origin `__session`
 * cookie, so the fetch carries no Authorization header. Reads the normalized SSE
 * stream emitted by /api/admin/agent/chat and batches token flushes with
 * requestAnimationFrame to avoid re-rendering on every chunk.
 */
const CHAT_ENDPOINT = "/api/admin/agent/chat";
const GENERIC_ERROR = "Sorry — I hit an error. Please try again.";

/** A draft an agent saved on a canvas during this turn (shown as a card). */
export interface CanvasCardData {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  url: string;
  stats: Array<{ label: string; value: string | number }>;
  warnings: number;
}

export interface ChatExchange {
  role: "user" | "agent";
  text: string;
  thoughtText?: string;
  isStreaming?: boolean;
  artifacts?: CanvasCardData[];
}

export interface DashboardChatOptions {
  /** The page the operator is chatting from (e.g. a lifecycle journey). */
  context?: { connectionId?: string | null; journeyId?: string | null };
  /** Called when an agent saves a canvas draft during a turn. */
  onCanvasSaved?: (card: CanvasCardData) => void;
}

function asCard(result: Record<string, unknown> | undefined): CanvasCardData | null {
  const card = result?.card as Partial<CanvasCardData> | undefined;
  if (!card || typeof card !== "object" || typeof card.url !== "string" || typeof card.id !== "string") return null;
  // Only same-app links: a card can never point the operator off-site.
  if (!card.url.startsWith("/admin/")) return null;
  return {
    kind: String(card.kind ?? "canvas"),
    id: card.id,
    title: String(card.title ?? "Draft"),
    subtitle: typeof card.subtitle === "string" ? card.subtitle : undefined,
    url: card.url,
    stats: Array.isArray(card.stats) ? card.stats.slice(0, 6) : [],
    warnings: typeof card.warnings === "number" ? card.warnings : 0,
  };
}

export interface UseDashboardChatReturn {
  exchange: ChatExchange[];
  sessionId: string | null;
  isLoading: boolean;
  isStreaming: boolean;
  isThinking: boolean;
  currentThought: string;
  toolStatus: string | null;
  mode: ChatMode;
  setMode: (mode: ChatMode) => void;
  sendMessage: (prompt: string) => Promise<void>;
}

export function useDashboardChat(options: DashboardChatOptions = {}): UseDashboardChatReturn {
  // Latest options without re-creating sendMessage on every render.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const [exchange, setExchange] = useState<ChatExchange[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [currentThought, setCurrentThought] = useState("");
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [mode, setMode] = useState<ChatMode>(DEFAULT_CHAT_MODE);

  // Refs accumulate streamed text to dodge stale-closure issues during the loop.
  const accumulatedTextRef = useRef("");
  const accumulatedThoughtRef = useRef("");
  const rafRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);

  const flushTextUpdate = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const text = accumulatedTextRef.current;
      setExchange((prev) => {
        const updated = [...prev];
        const last = updated.length - 1;
        const target = updated[last];
        if (target && target.role === "agent") {
          updated[last] = { ...target, text, isStreaming: true };
        }
        return updated;
      });
      rafRef.current = null;
    });
  }, []);

  const sendMessage = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed || isLoading) return;

      setIsLoading(true);
      setIsStreaming(false);
      setIsThinking(false);
      setCurrentThought("");
      setToolStatus(null);
      accumulatedTextRef.current = "";
      accumulatedThoughtRef.current = "";

      setExchange((prev) => [...prev, { role: "user", text: trimmed }]);

      try {
        const response = await fetch(CHAT_ENDPOINT, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmed,
            sessionId,
            mode,
            connectionId: optionsRef.current.context?.connectionId ?? null,
            journeyId: optionsRef.current.context?.journeyId ?? null,
          }),
        });
        if (!response.ok || !response.body) {
          throw new Error(`agent_request_failed_${response.status}`);
        }

        setIsStreaming(true);
        setExchange((prev) => [
          ...prev,
          { role: "agent", text: "", isStreaming: true },
        ]);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            const event = parseSSE(part);
            if (!event) continue;

            switch (event.type) {
              case "thought":
                setIsThinking(true);
                setToolStatus(null);
                accumulatedThoughtRef.current += event.text;
                setCurrentThought(accumulatedThoughtRef.current);
                break;
              case "text":
                setIsThinking(false);
                setToolStatus(null);
                setIsLoading(false);
                accumulatedTextRef.current += event.text;
                flushTextUpdate();
                break;
              case "tool_start":
                setIsThinking(false);
                setToolStatus(`Running ${event.toolName}…`);
                break;
              case "tool_result": {
                setToolStatus("Processing…");
                const card = asCard(event.result);
                if (card) {
                  setExchange((prev) => {
                    const updated = [...prev];
                    const last = updated.findLastIndex((m) => m.role === "agent");
                    const target = last >= 0 ? updated[last] : undefined;
                    if (target) {
                      const others = (target.artifacts ?? []).filter((a) => a.id !== card.id);
                      updated[last] = { ...target, artifacts: [...others, card] };
                    }
                    return updated;
                  });
                  optionsRef.current.onCanvasSaved?.(card);
                }
                break;
              }
              case "done":
                if (event.sessionId) setSessionId(event.sessionId);
                setExchange((prev) => {
                  const updated = [...prev];
                  const last = updated.findLastIndex((m) => m.role === "agent");
                  const target = last >= 0 ? updated[last] : undefined;
                  if (target) {
                    updated[last] = {
                      ...target,
                      text: accumulatedTextRef.current || target.text,
                      thoughtText:
                        event.thoughtText || accumulatedThoughtRef.current || undefined,
                      isStreaming: false,
                    };
                  }
                  return updated;
                });
                break;
              case "error":
                setExchange((prev) => {
                  const updated = [...prev];
                  const last = updated.findLastIndex((m) => m.role === "agent");
                  const target = last >= 0 ? updated[last] : undefined;
                  if (target) {
                    updated[last] = {
                      ...target,
                      text: event.message || GENERIC_ERROR,
                      isStreaming: false,
                    };
                  }
                  return updated;
                });
                break;
            }
          }
        }
      } catch (err) {
        console.error("[dashboard-chat] stream error:", err);
        setExchange((prev) => {
          const updated = [...prev];
          const last = updated.findLastIndex((m) => m.role === "agent");
          const target = last >= 0 ? updated[last] : undefined;
          if (target && target.text === "") {
            updated[last] = { ...target, text: GENERIC_ERROR, isStreaming: false };
            return updated;
          }
          return [...prev, { role: "agent", text: GENERIC_ERROR }];
        });
      } finally {
        setIsLoading(false);
        setIsStreaming(false);
        setIsThinking(false);
        setToolStatus(null);
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      }
    },
    [isLoading, sessionId, mode, flushTextUpdate],
  );

  return {
    exchange,
    sessionId,
    isLoading,
    isStreaming,
    isThinking,
    currentThought,
    toolStatus,
    mode,
    setMode,
    sendMessage,
  };
}
