"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { useState } from "react";
import { MERGE_VARS } from "@/lib/email/mergeVars";
import { sanitizeEmailHtml } from "@/lib/email/emailRender";

/**
 * Rich-text editor for a Text block (Tiptap). StarterKit is trimmed to exactly what
 * the email renderer's allowlist supports (bold/italic/lists/link) so nothing the user
 * types is silently stripped on save. Output is sanitized before it leaves the editor.
 * Insert-token menu drops {{merge_vars}} as plain text (they render verbatim + resolve
 * per-recipient at send time).
 */
export function TextBlockEditor({
  html,
  onChange,
}: {
  html: string;
  onChange: (html: string) => void;
}) {
  const [showTokens, setShowTokens] = useState(false);
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
      }),
      Link.configure({ openOnClick: false, autolink: false }),
    ],
    content: html,
    editorProps: {
      attributes: {
        class: "prose-sm min-h-[80px] max-w-none focus:outline-none text-sm leading-relaxed",
      },
    },
    onUpdate: ({ editor }) => onChange(sanitizeEmailHtml(editor.getHTML())),
  });

  if (!editor) return null;

  const btn = (active: boolean) =>
    `rounded px-1.5 py-0.5 text-xs ${active ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" : "hover:bg-neutral-100 dark:hover:bg-neutral-800"}`;

  function setLink() {
    const url = window.prompt("Link URL (https://… or {{token}})");
    if (url === null) return;
    if (!url) editor!.chain().focus().unsetLink().run();
    else editor!.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }

  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-1 border-b border-neutral-200 p-1 dark:border-neutral-800">
        <button type="button" onClick={() => editor.chain().focus().toggleBold().run()} className={btn(editor.isActive("bold"))}>
          <b>B</b>
        </button>
        <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()} className={btn(editor.isActive("italic"))}>
          <i>I</i>
        </button>
        <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()} className={btn(editor.isActive("bulletList"))}>
          • List
        </button>
        <button type="button" onClick={setLink} className={btn(editor.isActive("link"))}>
          Link
        </button>
        <div className="relative">
          <button type="button" onClick={() => setShowTokens((s) => !s)} className={btn(false)}>
            {"{{ }}"}
          </button>
          {showTokens ? (
            <div className="absolute z-10 mt-1 w-44 rounded-md border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
              {MERGE_VARS.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => {
                    editor.chain().focus().insertContent(`{{${v}}}`).run();
                    setShowTokens(false);
                  }}
                  className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  {`{{${v}}}`}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="px-2 py-1.5">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
