"use client";

import { useEffect, useRef, useState } from "react";

/** Copy `text` to the clipboard (Phase-1 manual publishing: copy each tweet). */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable (insecure context / denied) — no-op */
        }
      }}
      className="text-[11px] text-neutral-400 underline-offset-2 hover:underline"
    >
      {copied ? "Copied" : label}
    </button>
  );
}
