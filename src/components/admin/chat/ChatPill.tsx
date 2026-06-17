"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Plus, Mic, ArrowUp } from "lucide-react";
import { ModelSelector } from "./ModelSelector";
import { useAutoResizeTextarea } from "./useAutoResizeTextarea";
import type { ChatMode } from "./chatModes";

/**
 * The floating Gemini-style input pill: "+" (left), auto-resizing textarea,
 * reasoning-mode selector, mic (stubbed), and send. Submits on Enter (Shift+Enter
 * inserts a newline). Styling follows the app's neutral/dark Tailwind palette.
 */
interface ChatPillProps {
  onSubmit: (prompt: string) => void;
  isLoading?: boolean;
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
}

export function ChatPill({ onSubmit, isLoading, mode, onModeChange }: ChatPillProps) {
  const [prompt, setPrompt] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { resetHeight } = useAutoResizeTextarea(textareaRef, {
    minHeight: 24,
    maxHeight: 200,
    value: prompt,
  });

  const hasText = prompt.trim().length > 0;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!hasText || isLoading) return;
    onSubmit(prompt);
    setPrompt("");
    resetHeight();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      onSubmit={submit}
      className={`flex items-end gap-2 rounded-[28px] border border-neutral-200 bg-white px-3 py-2 shadow-lg transition-colors focus-within:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:focus-within:border-neutral-700 ${
        isLoading ? "opacity-70" : ""
      }`}
    >
      <button
        type="button"
        title="Add context (coming soon)"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        <Plus size={20} />
      </button>

      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder="Ask Vizzybl"
        disabled={isLoading}
        className="min-h-[24px] flex-1 resize-none self-center bg-transparent py-1.5 text-base outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
      />

      <ModelSelector mode={mode} onModeChange={onModeChange} />

      {hasText ? (
        <button
          type="submit"
          disabled={isLoading}
          title="Send"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition-colors hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          <ArrowUp size={20} />
        </button>
      ) : (
        <button
          type="button"
          title="Voice coming soon"
          disabled
          className="flex h-9 w-9 shrink-0 cursor-not-allowed items-center justify-center rounded-full text-neutral-400 dark:text-neutral-500"
        >
          <Mic size={20} />
        </button>
      )}
    </form>
  );
}
