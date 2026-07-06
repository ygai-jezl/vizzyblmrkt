"use client";

import { useEffect, useRef, useState } from "react";
import { channelLabel } from "@/lib/content/channels";
import type { ContentNode } from "@/lib/types/contentPlan";
import { ContentPreview } from "./ContentPreview";
import { backdropClass, frameWidth, previewKind, type PreviewView } from "./contentPreviewHelpers";

const FOCUSABLE =
  'button, [href], input, select, textarea, iframe, [tabindex]:not([tabindex="-1"])';

/**
 * Full-screen lightbox that renders a Create node as its destination surface at the
 * native dimensions the network uses, with an In-feed / Opened toggle:
 *   • In feed — as seen scrolling past (truncated at the platform cutoff)
 *   • Opened  — clicked into it (full copy + detail chrome)
 * Esc or a click outside the frame closes it. Because it declares aria-modal, it moves
 * focus inside on open, traps Tab (so the still-mounted inspector behind it can't be
 * reached and accidentally actioned), and restores focus to the trigger on close.
 */
export function ContentPreviewModal({
  node,
  brandName,
  workspaceId,
  onClose,
}: {
  node: ContentNode;
  brandName?: string;
  workspaceId?: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<PreviewView>("feed");
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const root = dialogRef.current;
    root?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !root) return;
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!focusables.length) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  const kind = previewKind(node);
  const width = frameWidth(kind, view);

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${node.role}`}
      className="fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-sm focus:outline-none"
    >
      {/* Chrome */}
      <div className="flex items-center gap-3 border-b border-white/10 bg-neutral-950/80 px-4 py-3 text-neutral-100">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{node.role}</div>
          <div className="truncate text-xs text-neutral-400">{channelLabel(node.channel)} · preview</div>
        </div>
        <div className="mx-auto inline-flex rounded-full border border-white/15 bg-white/5 p-0.5 text-xs">
          {(["feed", "opened"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`rounded-full px-3.5 py-1.5 font-medium transition ${
                view === v ? "bg-white text-neutral-900" : "text-neutral-300 hover:text-white"
              }`}
            >
              {v === "feed" ? "In feed" : "Opened"}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white"
        >
          ✕
        </button>
      </div>

      {/* Stage — click the surround (not the frame) to close. Padding lives on this
          wrapper so the frame's content box equals the native width the caption reports. */}
      <div className={`flex-1 overflow-auto px-4 py-8 ${backdropClass(kind)}`} onClick={onClose}>
        <div
          className="mx-auto"
          style={{ maxWidth: width, width: "100%" }}
          onClick={(e) => e.stopPropagation()}
        >
          <ContentPreview node={node} view={view} brandName={brandName} workspaceId={workspaceId} />
          <p className="mt-3 text-center text-[11px] text-neutral-600 dark:text-neutral-400">
            Approximate {channelLabel(node.channel)} rendering · ~{width}px ·{" "}
            {view === "feed" ? "as seen in the feed" : "opened / full view"}
          </p>
        </div>
      </div>
    </div>
  );
}
