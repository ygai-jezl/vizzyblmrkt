"use client";

import { useEffect, useRef, useState } from "react";
import { Brain, Zap, ChevronDown, Check } from "lucide-react";
import { CHAT_MODES, getChatMode, type ChatMode, type ChatModeConfig } from "./chatModes";

/**
 * Reasoning-mode picker ("Thinking" / "Fast"), modeled on the sibling portal's
 * ChatModeSelector but restyled in this app's plain-Tailwind neutral palette.
 * The dropdown opens upward because the pill floats at the bottom of the screen.
 */
const MODE_ICONS: Record<ChatMode, typeof Zap> = {
  thinking: Brain,
  fast: Zap,
};

interface ModelSelectorProps {
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
}

export function ModelSelector({ mode, onModeChange }: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const current = getChatMode(mode);
  const CurrentIcon = MODE_ICONS[current.id];

  useEffect(() => {
    if (!isOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [isOpen]);

  const handleSelect = (m: ChatModeConfig) => {
    onModeChange(m.id);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        <CurrentIcon size={14} />
        <span>{current.label}</span>
        <ChevronDown
          size={14}
          className={`transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {isOpen ? (
        <div
          role="listbox"
          className="absolute bottom-full right-0 z-50 mb-2 w-64 overflow-hidden rounded-xl border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
        >
          {CHAT_MODES.map((m) => {
            const Icon = MODE_ICONS[m.id];
            const selected = m.id === mode;
            return (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => handleSelect(m)}
                className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <Icon size={16} className="mt-0.5 shrink-0 text-neutral-500" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{m.label}</span>
                  <span className="block text-xs text-neutral-500">
                    {m.description}
                  </span>
                </span>
                {selected ? (
                  <Check size={16} className="mt-0.5 shrink-0 text-neutral-900 dark:text-neutral-100" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
