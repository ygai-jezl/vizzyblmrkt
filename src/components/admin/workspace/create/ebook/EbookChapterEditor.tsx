"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import { sanitizeEbookHtml } from "@/lib/content/create/ebookHtml";
import { EbookImage } from "./EbookImageNode";

/**
 * Rich-text (WYSIWYG) editor for one eBook chapter. StarterKit is trimmed to exactly the
 * tags sanitizeEbookHtml keeps (headings h2/h3/h4, bold, italic, lists, blockquote, hr, link,
 * tables) so nothing typed is silently stripped on save; the custom EbookImage node round-trips
 * the inline image anchors. Output is sanitized before it leaves the editor.
 */
export function EbookChapterEditor({
  html,
  onChange,
}: {
  html: string;
  onChange: (html: string) => void;
}) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        codeBlock: false,
        strike: false,
        code: false,
      }),
      Link.configure({ openOnClick: false, autolink: false }),
      // Tables (attributes are stripped on save, so no merged cells / column widths — plain
      // tabular structure that round-trips through the sanitizer + prose styling).
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      EbookImage,
    ],
    content: html,
    editorProps: {
      attributes: {
        class:
          "prose prose-sm max-w-none focus:outline-none leading-relaxed min-h-[200px] dark:prose-invert",
      },
    },
    onUpdate: ({ editor }) => onChange(sanitizeEbookHtml(editor.getHTML())),
  });

  if (!editor) return null;

  const btn = (active: boolean) =>
    `rounded px-2 py-0.5 text-xs ${active ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" : "hover:bg-neutral-100 dark:hover:bg-neutral-800"}`;

  function setLink() {
    const url = window.prompt("Link URL (https://…)");
    if (url === null) return;
    if (!url) editor!.chain().focus().unsetLink().run();
    else editor!.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }

  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b border-neutral-200 bg-white/90 p-1.5 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90">
        <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} className={btn(editor.isActive("heading", { level: 2 }))}>
          H2
        </button>
        <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} className={btn(editor.isActive("heading", { level: 3 }))}>
          H3
        </button>
        <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 4 }).run()} className={btn(editor.isActive("heading", { level: 4 }))}>
          H4
        </button>
        <button type="button" onClick={() => editor.chain().focus().toggleBold().run()} className={btn(editor.isActive("bold"))}>
          <b>B</b>
        </button>
        <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()} className={btn(editor.isActive("italic"))}>
          <i>I</i>
        </button>
        <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()} className={btn(editor.isActive("bulletList"))}>
          • List
        </button>
        <button type="button" onClick={() => editor.chain().focus().toggleOrderedList().run()} className={btn(editor.isActive("orderedList"))}>
          1. List
        </button>
        <button type="button" onClick={() => editor.chain().focus().toggleBlockquote().run()} className={btn(editor.isActive("blockquote"))}>
          &ldquo; Quote
        </button>
        <button type="button" onClick={setLink} className={btn(editor.isActive("link"))}>
          Link
        </button>
        <button type="button" onClick={() => editor.chain().focus().setHorizontalRule().run()} className={btn(false)} title="Divider">
          —
        </button>
        {editor.isActive("table") ? (
          <>
            <button type="button" onClick={() => editor.chain().focus().addRowAfter().run()} className={btn(false)} title="Add row">
              +Row
            </button>
            <button type="button" onClick={() => editor.chain().focus().addColumnAfter().run()} className={btn(false)} title="Add column">
              +Col
            </button>
            <button type="button" onClick={() => editor.chain().focus().deleteTable().run()} className={btn(false)} title="Delete table">
              ⌫ Table
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
            className={btn(false)}
            title="Insert table"
          >
            ⊞ Table
          </button>
        )}
      </div>
      <div className="px-4 py-3">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
