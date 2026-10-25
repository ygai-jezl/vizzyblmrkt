"use client";

import { useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import {
  Bold,
  ChevronDown,
  Code,
  Columns3,
  Italic,
  Link,
  List,
  ListOrdered,
  Minus,
  PanelTop,
  Quote,
  Redo2,
  Rows3,
  SquareCode,
  Table,
  Trash2,
  Undo2,
} from "lucide-react";
import type { EditFormat } from "@/lib/content/editor/extensions";
import { LinkPopover } from "./LinkPopover";

/** The boxes an article's writer uses, then one the person names. */
const BOXES = [
  { label: "Key facts", hint: "The short list readers and AI answers lift" },
  { label: "TL;DR", hint: "The answer in two lines" },
  { label: "Answer", hint: "A direct answer to the section's question" },
];

type Style = "p" | "1" | "2" | "3" | "4";

const STYLES: Record<EditFormat, { value: Style; label: string }[]> = {
  blog: [
    { value: "p", label: "Paragraph" },
    { value: "1", label: "Title" },
    { value: "2", label: "Heading" },
    { value: "3", label: "Subheading" },
    { value: "4", label: "Small heading" },
  ],
  newsletter: [
    { value: "p", label: "Paragraph" },
    { value: "1", label: "Title" },
    { value: "2", label: "Heading" },
    { value: "3", label: "Subheading" },
  ],
  email: [
    { value: "p", label: "Paragraph" },
    { value: "1", label: "Heading 1" },
    { value: "2", label: "Heading 2" },
    { value: "3", label: "Heading 3" },
  ],
};

function Tool({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      // Keep the editor's selection: a click on a tool shouldn't move focus out of the text.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
          : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px bg-neutral-200 dark:bg-neutral-800" />;
}

/** The formatting tools for a format: only what its saved form can hold. */
export function EditorToolbar({ editor, format, end }: { editor: Editor; format: EditFormat; end?: ReactNode }) {
  const [menu, setMenu] = useState<"box" | "link" | null>(null);
  const article = format === "blog";
  const markdown = format !== "email";
  const chain = () => editor.chain().focus();

  const level = ([1, 2, 3, 4] as const).find((l) => editor.isActive("heading", { level: l }));
  const style: Style = level ? (String(level) as Style) : "p";
  const inBox = editor.isActive("articleBox");
  const inTable = editor.isActive("table");

  function setStyle(v: Style) {
    if (v === "p") chain().setParagraph().run();
    else chain().setHeading({ level: Number(v) as 1 | 2 | 3 | 4 }).run();
  }

  function pickBox(label: string) {
    if (inBox) chain().updateAttributes("articleBox", { label }).run();
    else chain().wrapIn("articleBox", { label }).run();
    setMenu(null);
  }

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex flex-wrap items-center gap-0.5 border-b border-neutral-200 bg-white px-4 py-1.5 dark:border-neutral-800 dark:bg-neutral-950"
    >
      <label className="sr-only" htmlFor="edit-mode-style">
        Text style
      </label>
      <select
        id="edit-mode-style"
        value={style}
        onChange={(e) => setStyle(e.target.value as Style)}
        className="h-8 rounded-md border border-neutral-200 bg-white px-2 text-sm dark:border-neutral-800 dark:bg-neutral-950"
      >
        {STYLES[format].map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <Divider />
      <Tool label="Bold" active={editor.isActive("bold")} onClick={() => chain().toggleBold().run()}>
        <Bold size={16} aria-hidden />
      </Tool>
      <Tool label="Italic" active={editor.isActive("italic")} onClick={() => chain().toggleItalic().run()}>
        <Italic size={16} aria-hidden />
      </Tool>
      {article ? (
        <Tool label="Inline code" active={editor.isActive("code")} onClick={() => chain().toggleMark("code").run()}>
          <Code size={16} aria-hidden />
        </Tool>
      ) : null}
      <span className="relative">
        <Tool label="Link" active={editor.isActive("link")} onClick={() => setMenu(menu === "link" ? null : "link")}>
          <Link size={16} aria-hidden />
        </Tool>
        {menu === "link" ? <LinkPopover editor={editor} format={format} onClose={() => setMenu(null)} /> : null}
      </span>
      <Divider />
      <Tool label="Bulleted list" active={editor.isActive("bulletList")} onClick={() => chain().toggleBulletList().run()}>
        <List size={16} aria-hidden />
      </Tool>
      <Tool label="Numbered list" active={editor.isActive("orderedList")} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered size={16} aria-hidden />
      </Tool>
      {markdown ? <Divider /> : null}
      {article ? (
        <span className="relative">
          <button
            type="button"
            aria-expanded={menu === "box"}
            aria-haspopup="menu"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setMenu(menu === "box" ? null : "box")}
            className={`inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm ${
              inBox || menu === "box"
                ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            }`}
          >
            <PanelTop size={16} aria-hidden />
            Box
            <ChevronDown size={12} aria-hidden />
          </button>
          {menu === "box" ? (
            <div
              role="menu"
              aria-label="Add a box"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setMenu(null);
                }
              }}
              className="absolute left-0 top-full z-20 mt-2 w-72 rounded-lg border border-neutral-200 bg-white p-1.5 shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
            >
              {BOXES.map((b) => (
                <button
                  key={b.label}
                  type="button"
                  role="menuitem"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickBox(b.label)}
                  className="block w-full rounded-md px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
                >
                  <span className="block text-sm font-semibold">{b.label}</span>
                  <span className="block text-xs text-neutral-500">{b.hint}</span>
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickBox("Note")}
                className="block w-full rounded-md px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                <span className="block text-sm font-semibold">Your own label</span>
                <span className="block text-xs text-neutral-500">Type the label on the box</span>
              </button>
              {inBox ? (
                <>
                  <span aria-hidden className="mx-1.5 my-1 block h-px bg-neutral-200 dark:bg-neutral-800" />
                  <button
                    type="button"
                    role="menuitem"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      chain().lift("articleBox").run();
                      setMenu(null);
                    }}
                    className="block w-full rounded-md px-2.5 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
                  >
                    Remove the box
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </span>
      ) : null}
      {markdown ? (
        <Tool label="Quotation" active={editor.isActive("blockquote")} onClick={() => chain().toggleBlockquote().run()}>
          <Quote size={16} aria-hidden />
        </Tool>
      ) : null}
      {article ? (
        <Tool
          label="Table"
          active={inTable}
          disabled={inTable}
          onClick={() => chain().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run()}
        >
          <Table size={16} aria-hidden />
        </Tool>
      ) : null}
      {article ? (
        <Tool label="Code block" active={editor.isActive("codeBlock")} onClick={() => chain().toggleCodeBlock().run()}>
          <SquareCode size={16} aria-hidden />
        </Tool>
      ) : null}
      {markdown ? (
        <Tool label="Divider line" onClick={() => chain().setHorizontalRule().run()}>
          <Minus size={16} aria-hidden />
        </Tool>
      ) : null}
      <Divider />
      <Tool label="Undo" disabled={!editor.can().undo()} onClick={() => chain().undo().run()}>
        <Undo2 size={16} aria-hidden />
      </Tool>
      <Tool label="Redo" disabled={!editor.can().redo()} onClick={() => chain().redo().run()}>
        <Redo2 size={16} aria-hidden />
      </Tool>
      {inTable ? (
        <>
          <Divider />
          <span className="px-1 text-xs text-neutral-500">Table:</span>
          <Tool label="Add a row" onClick={() => chain().addRowAfter().run()}>
            <Rows3 size={16} aria-hidden />
            <span className="text-xs">Row</span>
          </Tool>
          <Tool label="Add a column" onClick={() => chain().addColumnAfter().run()}>
            <Columns3 size={16} aria-hidden />
            <span className="text-xs">Column</span>
          </Tool>
          <Tool label="Delete this row" onClick={() => chain().deleteRow().run()}>
            <Trash2 size={14} aria-hidden />
            <span className="text-xs">Row</span>
          </Tool>
          <Tool label="Delete this column" onClick={() => chain().deleteColumn().run()}>
            <Trash2 size={14} aria-hidden />
            <span className="text-xs">Column</span>
          </Tool>
          <Tool label="Delete the table" onClick={() => chain().deleteTable().run()}>
            <Trash2 size={14} aria-hidden />
            <span className="text-xs">Table</span>
          </Tool>
        </>
      ) : null}
      {end ? <span className="ml-auto">{end}</span> : null}
    </div>
  );
}
