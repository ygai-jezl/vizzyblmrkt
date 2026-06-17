"use client";

import { useEffect, useRef } from "react";
import { ChatPill } from "./ChatPill";
import { MessageThread } from "./MessageThread";
import { useDashboardChat } from "./useDashboardChat";

/**
 * The dashboard's centerpiece: a Gemini-style chat that is the root/orchestrator
 * agent's front-end. Shows a centered greeting until the first message, then a
 * transcript, with the input pill floating (sticky) at the bottom of the column.
 * Owns all chat state via useDashboardChat.
 */
export function DashboardChat({ userName }: { userName?: string }) {
  const chat = useDashboardChat();
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasMessages = chat.exchange.length > 0;

  useEffect(() => {
    if (hasMessages) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [chat.exchange, chat.isStreaming, chat.toolStatus, hasMessages]);

  return (
    <div className="flex flex-1 flex-col">
      {hasMessages ? (
        <MessageThread
          exchange={chat.exchange}
          isThinking={chat.isThinking}
          currentThought={chat.currentThought}
          toolStatus={chat.toolStatus}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <h1 className="text-3xl font-medium text-neutral-700 dark:text-neutral-200 sm:text-4xl">
            What&apos;s the vibe{userName ? `, ${userName}` : ""}?
          </h1>
          <p className="mt-3 text-sm text-neutral-500">
            Ask anything, or tell me what to launch next.
          </p>
        </div>
      )}

      <div ref={bottomRef} />

      <div className="sticky bottom-6 z-10 mx-auto w-full max-w-3xl pt-2">
        <ChatPill
          onSubmit={chat.sendMessage}
          isLoading={chat.isLoading}
          mode={chat.mode}
          onModeChange={chat.setMode}
        />
        <p className="mt-2 text-center text-xs text-neutral-400">
          Vizzybl can make mistakes. Verify important actions before approving.
        </p>
      </div>
    </div>
  );
}
