"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { ChatPill } from "../chat/ChatPill";
import { MessageThread } from "../chat/MessageThread";
import { useDashboardChat, type CanvasCardData } from "../chat/useDashboardChat";

/**
 * Vizzy, docked beside a lifecycle journey. Messages carry this journey's
 * connection + id, so "make the last reminder shorter" edits THIS draft; when
 * Vizzy saves it, the editor reloads the canvas. Drafts only — publishing stays
 * a button on the page.
 */

const SUGGESTIONS = [
  "Make the last reminder shorter and friendlier",
  "Only send on weekdays at 10am",
  "Add a branch for people on the free plan",
];

export function LifecycleChatPanel({
  connectionId,
  journeyId,
  onClose,
  onDraftSaved,
}: {
  connectionId: string;
  journeyId: string;
  onClose: () => void;
  onDraftSaved: (card: CanvasCardData) => void;
}) {
  const chat = useDashboardChat({
    context: { connectionId, journeyId },
    onCanvasSaved: (card) => {
      if (card.kind === "lifecycle") onDraftSaved(card);
    },
  });
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat.exchange, chat.toolStatus]);

  return (
    <aside className="flex h-[640px] w-full shrink-0 flex-col rounded-lg border border-neutral-200 bg-white lg:w-96 dark:border-neutral-800 dark:bg-neutral-950">
      <header className="flex items-center justify-between border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <div>
          <div className="text-sm font-semibold">Ask Vizzy</div>
          <div className="text-xs text-neutral-500">Edits this draft. You publish.</div>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-neutral-400 hover:text-neutral-700" aria-label="Close chat">
          <X size={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3">
        {chat.exchange.length === 0 ? (
          <div className="space-y-2 py-4">
            <p className="text-sm text-neutral-500">Tell Vizzy what to change. For example:</p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void chat.sendMessage(s)}
                className="block w-full rounded-md border border-neutral-200 px-3 py-2 text-left text-sm hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
              >
                {s}
              </button>
            ))}
          </div>
        ) : (
          <MessageThread
            exchange={chat.exchange}
            isThinking={chat.isThinking}
            currentThought={chat.currentThought}
            toolStatus={chat.toolStatus}
            compact
          />
        )}
        <div ref={bottom} />
      </div>
      <div className="border-t border-neutral-200 p-2 dark:border-neutral-800">
        <ChatPill onSubmit={chat.sendMessage} isLoading={chat.isLoading} mode={chat.mode} onModeChange={chat.setMode} />
      </div>
    </aside>
  );
}
