"use client";

import { useState } from "react";
import { Loader2, ChevronRight, Sparkles } from "lucide-react";
import { MarkdownMessage } from "./MarkdownMessage";
import type { ChatExchange } from "./useDashboardChat";

/**
 * Renders the chat transcript: user turns right-aligned, agent turns left with
 * markdown + a streaming indicator, an optional collapsible "thought" block, and
 * a live tool-status line. Presentational — all state comes from useDashboardChat.
 */
interface MessageThreadProps {
  exchange: ChatExchange[];
  isThinking: boolean;
  currentThought: string;
  toolStatus: string | null;
}

export function MessageThread({
  exchange,
  isThinking,
  currentThought,
  toolStatus,
}: MessageThreadProps) {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 py-6">
      {exchange.map((msg, idx) =>
        msg.role === "user" ? (
          <div key={idx} className="flex justify-end">
            <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-neutral-100 px-4 py-2 text-sm dark:bg-neutral-800">
              {msg.text}
            </div>
          </div>
        ) : (
          <div key={idx} className="flex gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-neutral-800">
              <Sparkles size={15} />
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              {msg.thoughtText ? <ThoughtBlock text={msg.thoughtText} /> : null}
              {msg.text ? (
                <MarkdownMessage content={msg.text} />
              ) : msg.isStreaming ? (
                <TypingDots />
              ) : null}
            </div>
          </div>
        ),
      )}

      {isThinking && currentThought ? (
        <div className="flex gap-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-neutral-800">
            <Loader2 size={15} className="animate-spin" />
          </div>
          <div className="min-w-0 flex-1 pt-1 text-sm italic text-neutral-500">
            {currentThought}
          </div>
        </div>
      ) : null}

      {toolStatus ? (
        <div className="flex items-center gap-2 pl-10 text-xs text-neutral-500">
          <Loader2 size={13} className="animate-spin" />
          {toolStatus}
        </div>
      ) : null}
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-1.5" aria-label="Assistant is typing">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  );
}

function ThoughtBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
      >
        <ChevronRight
          size={13}
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        />
        Thoughts
      </button>
      {open ? (
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-neutral-200 pl-3 text-xs italic text-neutral-500 dark:border-neutral-800">
          {text}
        </div>
      ) : null}
    </div>
  );
}
