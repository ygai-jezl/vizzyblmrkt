"use client";

import { Sparkles } from "lucide-react";
import { useShell } from "../nav/ShellProvider";

/** One-click questions for Vizzy (Home). They land in the chat below. */
export function AskChips({ prompts }: { prompts: string[] }) {
  const shell = useShell();
  if (!shell) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Sparkles size={15} aria-hidden className="text-shell-accent" />
      {prompts.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => shell.ask(p)}
          className="rounded-full border border-shell-line bg-shell-card px-3 py-1.5 text-sm text-shell-ink hover:bg-shell-hover"
        >
          {p}
        </button>
      ))}
    </div>
  );
}
