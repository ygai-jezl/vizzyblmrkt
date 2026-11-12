"use client";

import { useRef } from "react";
import { BubbleMenu, type Editor } from "@tiptap/react";
import { VizzyMark } from "./VizzyPanel";

/**
 * The small bar over a selection in Edit mode: Ask Vizzy (opens the Vizzy tab with the
 * selection) and quick asks that go straight away.
 */

const QUICK = ["Shorter", "Plainer", "Fix grammar"];

export function VizzyBubble({
  editor,
  container,
  busy,
  hidden = false,
  onAsk,
  onQuick,
}: {
  editor: Editor;
  /** Where the bar is drawn: inside Edit mode, which is a React portal. Drawn anywhere else
   *  (document.body, tippy's default), React doesn't see its clicks. Read when it shows. */
  container: () => HTMLElement | null;
  busy: boolean;
  /** Kept mounted but not shown (while the ask box has the focus). Unmounting a shown menu
   *  breaks React: tippy has moved its element. */
  hidden?: boolean;
  onAsk: () => void;
  onQuick: (ask: string) => void;
}) {
  // The menu keeps the first shouldShow it was given, so it reads "busy" through a ref.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="vizzyBubble"
      tippyOptions={{ placement: "top", maxWidth: "none", appendTo: () => container() ?? document.body, zIndex: 60 }}
      shouldShow={({ editor: ed, view, state }) => {
        // Hidden while the person types in the Vizzy tab; its buttons don't take the focus.
        if (busyRef.current || state.selection.empty || !ed.isEditable || !view.hasFocus()) return false;
        const { $from } = state.selection;
        return !$from.parent.type.spec.code;
      }}
    >
      <div
        aria-hidden={hidden || undefined}
        className={`${hidden ? "hidden" : "flex"} items-center gap-0.5 rounded-lg bg-neutral-900 p-1 shadow-lg dark:bg-neutral-100`}
      >
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onAsk}
          className="inline-flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-neutral-900 dark:bg-neutral-900 dark:text-white"
        >
          <VizzyMark size={13} />
          Ask Vizzy
        </button>
        {QUICK.map((q) => (
          <button
            key={q}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onQuick(q)}
            className="rounded-md px-2.5 py-1 text-xs text-white hover:bg-white/10 dark:text-neutral-900 dark:hover:bg-black/10"
          >
            {q}
          </button>
        ))}
      </div>
    </BubbleMenu>
  );
}
