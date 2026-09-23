"use client";

import { useState } from "react";
import { Bot, Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { api, errorText } from "./api";
import { Button } from "./ui";

/**
 * One click to hand the whole integration to a coding agent (Claude Code,
 * Cursor, …): copies a prompt built from this product's catalog and what we
 * found in its code — what to build, where, in priority order. No secrets.
 */
export function CopyAgentPrompt({ connectionId, prompt: given }: { connectionId: string; prompt?: string }) {
  const [prompt, setPrompt] = useState<string | null>(given ?? null);
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = async (): Promise<string | null> => {
    if (prompt) return prompt;
    const r = await api<{ guide: { agentPrompt: string } }>(`/api/admin/connections/${connectionId}/guide`);
    if (!r.ok) {
      setErr(errorText(r.data));
      return null;
    }
    setPrompt(r.data.guide.agentPrompt);
    return r.data.guide.agentPrompt;
  };

  const copy = async () => {
    const p = await load();
    if (!p) return setState("error");
    try {
      await navigator.clipboard.writeText(p);
      setState("copied");
      setTimeout(() => setState("idle"), 2500);
    } catch {
      setOpen(true); // clipboard blocked — show it so they can copy by hand
      setState("error");
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-violet-200 bg-violet-50/60 p-3 dark:border-violet-900 dark:bg-violet-950/30">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-start gap-2 text-sm">
          <Bot size={16} className="mt-0.5 shrink-0 text-violet-600" />
          <div>
            <div className="font-medium">Hand this to your coding agent</div>
            <div className="text-xs text-neutral-600 dark:text-neutral-400">
              A ready-made prompt for Claude Code, Cursor or similar: every task below, where it goes in your code, and how
              to check it works. It contains no secrets.
            </div>
          </div>
        </div>
        <Button tone="primary" onClick={() => void copy()}>
          {state === "copied" ? <Check size={14} /> : <Copy size={14} />} {state === "copied" ? "Copied" : "Copy prompt"}
        </Button>
      </div>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-800"
        onClick={() => {
          setOpen(!open);
          if (!prompt) void load();
        }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Preview the prompt
      </button>
      {err ? <p className="text-xs text-red-600">{err}</p> : null}
      {open && prompt ? (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-neutral-200 bg-white p-3 text-xs dark:border-neutral-800 dark:bg-neutral-950">
          {prompt}
        </pre>
      ) : null}
    </div>
  );
}
