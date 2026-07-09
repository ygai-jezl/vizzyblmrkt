"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Plus, ArrowUp } from "lucide-react";
import { MarkdownMessage } from "@/components/admin/chat/MarkdownMessage";
import { useAutoResizeTextarea } from "@/components/admin/chat/useAutoResizeTextarea";
import type { EbookDoc } from "@/lib/types/contentPlan";
import { useEbookChat } from "./useEbookChat";

/**
 * The eBook studio's left column: a chat that converses AND edits the book. Conversation
 * scrolls above a floating composer pill. The "+" is inert in 2a (image generation lands in
 * 2b). Edits the model makes come back as a persisted-draft snapshot, which the studio
 * applies via `onEbook`. Reuses `MarkdownMessage` + `useAutoResizeTextarea`.
 */
export function EbookChatColumn({
  workspaceId,
  planId,
  onEbook,
  onBeforeSend,
  onCreateImage,
}: {
  workspaceId: string;
  planId: string;
  onEbook: (ebook: EbookDoc) => void;
  onBeforeSend?: () => Promise<void>;
  onCreateImage?: () => void;
}) {
  const { messages, isLoading, isStreaming, sendMessage } = useEbookChat({ workspaceId, planId, onEbook, onBeforeSend });
  const [prompt, setPrompt] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { resetHeight } = useAutoResizeTextarea(textareaRef, { minHeight: 24, maxHeight: 160, value: prompt });

  // Close the "+" menu on outside click / Escape (mirrors ModelSelector).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Busy the whole turn (isLoading clears at the first token; isStreaming stays true until done),
  // so a mid-stream second submit can't interleave into the shared accumulator/message.
  const busy = isLoading || isStreaming;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const hasText = prompt.trim().length > 0;

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!hasText || busy) return;
    void sendMessage(prompt);
    setPrompt("");
    resetHeight();
  }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Conversation */}
      <div className="flex-1 space-y-3 overflow-y-auto p-4 text-sm">
        {messages.length === 0 ? (
          <div className="space-y-2 text-neutral-500">
            <p className="font-medium text-neutral-700 dark:text-neutral-300">Edit with chat</p>
            <p>Ask me to shape the book, e.g.:</p>
            <ul className="list-disc space-y-1 pl-4 text-xs">
              <li>&ldquo;rewrite chapter 2 to be punchier&rdquo;</li>
              <li>&ldquo;add a chapter on pricing after the intro&rdquo;</li>
              <li>&ldquo;rename chapter 3 to &lsquo;The Payoff&rsquo;&rdquo;</li>
              <li>&ldquo;drop the last chapter&rdquo;</li>
            </ul>
          </div>
        ) : (
          messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl bg-neutral-900 px-3 py-2 text-white dark:bg-white dark:text-neutral-900">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={i} className="max-w-[92%]">
                {m.text ? (
                  <MarkdownMessage content={m.text} />
                ) : (
                  <span className="inline-flex gap-1 text-neutral-400">
                    <Dot /> <Dot /> <Dot />
                  </span>
                )}
              </div>
            ),
          )
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="border-t border-neutral-200 p-3 dark:border-neutral-800">
        <form
          onSubmit={submit}
          className="flex items-end gap-2 rounded-[24px] border border-neutral-200 bg-white px-3 py-2 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
        >
          <div ref={menuRef} className="relative shrink-0">
            <button
              type="button"
              title="Create image"
              onClick={() => (onCreateImage ? setMenuOpen((o) => !o) : undefined)}
              disabled={!onCreateImage}
              className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-300 dark:hover:bg-neutral-800 dark:disabled:text-neutral-600"
            >
              <Plus size={18} />
            </button>
            {menuOpen ? (
              <div className="absolute bottom-full left-0 z-50 mb-2 w-44 overflow-hidden rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onCreateImage?.();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  <span aria-hidden>🖼</span> Create image
                </button>
              </div>
            ) : null}
          </div>
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Ask to edit the book…"
            disabled={busy}
            className="min-h-[24px] flex-1 resize-none self-center bg-transparent py-1 text-sm outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
          />
          <button
            type="submit"
            disabled={!hasText || busy}
            title="Send"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition-colors hover:bg-neutral-700 disabled:opacity-40 dark:bg-white dark:text-neutral-900"
          >
            <ArrowUp size={18} />
          </button>
        </form>
      </div>
    </div>
  );
}

function Dot() {
  return <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />;
}
