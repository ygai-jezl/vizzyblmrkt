"use client";

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { linkCheck, type EditFormat } from "@/lib/content/editor/extensions";

const HINT: Record<EditFormat, string> = {
  blog: "A web address (https://…), a page on your site (/pricing) or a section of this article (#faq).",
  newsletter: "A web address (https://…), an email address (mailto:…) or a value such as {{hub_url}}.",
  email: "A web address (https://…), an email address (mailto:…) or a value such as {{unsubscribe_url}}.",
};

/** Set, change or remove the link on the selected words. */
export function LinkPopover({ editor, format, onClose }: { editor: Editor; format: EditFormat; onClose: () => void }) {
  const current = String(editor.getAttributes("link").href ?? "");
  const [href, setHref] = useState(current);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  function apply() {
    const raw = href.trim();
    if (!raw) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      onClose();
      return;
    }
    const target = linkCheck(format)(raw);
    if (!target) {
      setProblem("That address can't be a link here.");
      return;
    }
    const chain = editor.chain().focus().extendMarkRange("link");
    // With nothing selected, the address itself becomes the link's words.
    if (editor.state.selection.empty && !editor.isActive("link")) {
      chain.insertContent({ type: "text", text: target, marks: [{ type: "link", attrs: { href: target } }] }).run();
    } else {
      chain.setLink({ href: target }).run();
    }
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-label="Link"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className="absolute right-0 top-full z-20 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] space-y-2 rounded-lg border border-neutral-200 bg-white p-3 shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
    >
      <label className="block space-y-1">
        <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Link address</span>
        <input
          ref={input}
          value={href}
          onChange={(e) => {
            setHref(e.target.value);
            setProblem(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            }
          }}
          className="w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>
      <p className={`text-xs ${problem ? "text-red-700 dark:text-red-400" : "text-neutral-500"}`}>
        {problem ? `${problem} ${HINT[format]}` : HINT[format]}
      </p>
      <div className="flex justify-end gap-2">
        {current ? (
          <button
            type="button"
            onClick={() => {
              editor.chain().focus().extendMarkRange("link").unsetLink().run();
              onClose();
            }}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Remove link
          </button>
        ) : null}
        <button
          type="button"
          onClick={apply}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Apply
        </button>
      </div>
    </div>
  );
}
