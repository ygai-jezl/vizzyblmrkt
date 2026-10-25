"use client";

import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { PenLine, X } from "lucide-react";
import { ADMIN_THEME_ROOT_ID } from "@/lib/theme";
import { editorExtensions, isMarkdownFormat, type EditFormat } from "@/lib/content/editor/extensions";
import { docLoss, docToMarkdown, markdownEditProblem, markdownToDoc, type DocLoss } from "@/lib/content/editor/markdownDoc";
import { editorHtmlToEmail, emailEditProblem, emailToEditorHtml } from "@/lib/email/emailDoc";
import { ArticleBoxWithView } from "./ArticleBoxView";
import { EditorToolbar } from "./EditorToolbar";

/**
 * Edit mode: long content in a rich editor over the screen, styled the way readers see it.
 * What it saves is the format the content is stored in (an article's Markdown, an email's
 * sanitized HTML), so everything that reads the text works as before. Content the editor can't
 * keep opens as raw text with the reason, and a save that would simplify formatting asks
 * first. Unsaved text is kept in this browser's session until it is saved or discarded.
 */
export interface EditModeProps {
  format: EditFormat;
  /** What this is ("Blog hub", "Broadcast email"), above the title. */
  kicker: string;
  title: string;
  /** The text as stored. */
  value: string;
  /** "Save" where Edit mode saves; "Done" where the form it came from saves. */
  primaryLabel: "Save" | "Done";
  /** Hands back the new text; false = it didn't save, so Edit mode stays open. */
  onSave: (next: string) => boolean | Promise<boolean>;
  onClose: () => void;
  /** Names this text in the browser's session store (screen and item). */
  draftKey: string;
  maxChars: number;
  /** A blog article's hero image, shown above the text, read only. */
  heroUrl?: string | null;
  /** The article's checks for the text as it stands. */
  checks?: (markdown: string) => ReactNode;
  /** Merge values an email can insert. */
  tokens?: readonly string[];
}

const RAW_LABEL: Record<EditFormat, string> = { blog: "Markdown", newsletter: "Markdown", email: "HTML" };

const DOC_COMMON =
  "min-h-[50vh] focus:outline-none [&>*:first-child]:mt-0 " +
  "[&_p]:mt-4 [&_ul]:mt-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:mt-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:mt-1.5 [&_li>p]:mt-0 " +
  "[&_a]:text-blue-700 [&_a]:underline dark:[&_a]:text-blue-400 " +
  "[&_h1]:font-bold [&_h1]:leading-tight [&_h1]:tracking-tight [&_h2]:font-semibold [&_h2]:leading-snug [&_h3]:font-semibold";

/** An article's look, as the preview draws it (ArticleMarkdown). */
const ARTICLE_DOC =
    `${DOC_COMMON} text-[16px] leading-7 ` +
    "[&_h1]:mt-8 [&_h1]:text-[32px] [&_h2]:mt-9 [&_h2]:text-[23px] [&_h3]:mt-6 [&_h3]:text-lg [&_h4]:mt-5 [&_h4]:font-semibold " +
    "[&_blockquote]:mt-5 [&_blockquote]:border-l-4 [&_blockquote]:border-neutral-300 [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-neutral-700 dark:[&_blockquote]:border-neutral-600 dark:[&_blockquote]:text-neutral-300 " +
    "[&_table]:mt-5 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm [&_table]:leading-6 " +
    "[&_td]:border [&_td]:border-neutral-300 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_td>p]:mt-0 dark:[&_td]:border-neutral-700 " +
    "[&_th]:border [&_th]:border-neutral-300 [&_th]:bg-neutral-100 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:align-top [&_th]:font-semibold [&_th>p]:mt-0 dark:[&_th]:border-neutral-700 dark:[&_th]:bg-neutral-800 " +
    "[&_.selectedCell]:bg-blue-50 dark:[&_.selectedCell]:bg-blue-950 " +
    "[&_pre]:mt-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-neutral-200 [&_pre]:bg-neutral-50 [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs [&_pre]:leading-snug dark:[&_pre]:border-neutral-800 dark:[&_pre]:bg-neutral-900 " +
    "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-neutral-100 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.9em] dark:[&_:not(pre)>code]:bg-neutral-800 " +
    "[&_hr]:my-8 [&_hr]:border-neutral-200 dark:[&_hr]:border-neutral-800";

const DOC_CLASS: Record<EditFormat, string> = {
  blog: ARTICLE_DOC,
  newsletter: ARTICLE_DOC,
  email:
    `${DOC_COMMON} text-[16px] leading-relaxed ` +
    "[&_h1]:mt-6 [&_h1]:text-2xl [&_h2]:mt-6 [&_h2]:text-xl [&_h3]:mt-5 [&_h3]:text-lg",
};

// ── the browser's session copy of unsaved text ─────────────────────────────────────

interface Draft {
  /** The stored text the changes were made to. */
  base: string;
  text: string;
}

const DRAFT_PREFIX = "yg-edit-mode:";

function readDraft(key: string): Draft | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_PREFIX + key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    return typeof d.base === "string" && typeof d.text === "string" ? { base: d.base, text: d.text } : null;
  } catch {
    return null;
  }
}

function writeDraft(key: string, draft: Draft): void {
  try {
    window.sessionStorage.setItem(DRAFT_PREFIX + key, JSON.stringify(draft));
  } catch {
    // A private window or a full store: Edit mode works without it.
  }
}

function clearDraft(key: string): void {
  try {
    window.sessionStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    // As above.
  }
}

// ── messages ──────────────────────────────────────────────────────────────────────────

function where(loss: DocLoss): string {
  return loss.under ? `the ${loss.kind} under "${loss.near}"` : `the ${loss.kind} "${loss.near}"`;
}

/** Why Edit mode can't open this text, or null when it can. */
export function cantOpenReason(format: EditFormat, text: string): string | null {
  if (isMarkdownFormat(format)) {
    const loss = markdownEditProblem(text, format);
    return loss ? `Edit mode can't keep ${where(loss)} yet. Edit it as Markdown.` : null;
  }
  const kept = emailEditProblem(text);
  return kept ? `This email has HTML Edit mode can't keep: ${kept.join(", ")}. Edit the HTML here.` : null;
}

function count(n: number): string {
  return n.toLocaleString("en-GB");
}

function headingsOf(editor: Editor): { pos: number; level: number; text: string }[] {
  const out: { pos: number; level: number; text: string }[] = [];
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === "heading" && node.textContent.trim()) {
      out.push({ pos: offset + 1, level: Number(node.attrs.level) || 2, text: node.textContent.trim() });
    }
  });
  return out;
}

function Notice({ tone, children }: { tone: "info" | "warn" | "err"; children: ReactNode }) {
  const tones = {
    info: "border-neutral-200 bg-white text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300",
    warn: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
    err: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
  };
  return (
    <div role="status" className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 text-sm ${tones[tone]}`}>
      {children}
    </div>
  );
}

const SMALL_BUTTON =
  "rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900";

export function EditModeView(props: EditModeProps) {
  const { format, kicker, title, value, primaryLabel, onSave, onClose, draftKey, maxChars, heroUrl, checks, tokens } = props;
  const markdown = isMarkdownFormat(format);
  const blocked = useMemo(() => cantOpenReason(format, value), [format, value]);

  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [view, setView] = useState<"rich" | "raw">(blocked ? "raw" : "rich");
  const [raw, setRaw] = useState(value);
  const [dirty, setDirty] = useState(false);
  const [restore, setRestore] = useState<Draft | null>(null);
  const [rawProblem, setRawProblem] = useState<string | null>(blocked);
  const [pendingLoss, setPendingLoss] = useState<DocLoss | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const shown = useDeferredValue(raw);

  const toContent = (text: string) => (markdown ? markdownToDoc(text, format) : emailToEditorHtml(text));
  const fromEditor = (ed: Editor) => (markdown ? docToMarkdown(ed.getJSON()) : editorHtmlToEmail(ed.getHTML()));

  const extensions = useMemo(() => editorExtensions(format, ArticleBoxWithView), [format]);
  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    content: blocked ? "" : toContent(value),
    editorProps: { attributes: { class: DOC_CLASS[format], "aria-label": "Text" } },
    onUpdate: ({ editor: ed }) => {
      setRaw(fromEditor(ed));
      setDirty(true);
      setPendingLoss(null);
    },
  });

  // Portalled into the admin shell (it carries the light or dark theme), above everything else.
  useEffect(() => {
    setTarget(document.getElementById(ADMIN_THEME_ROOT_ID) ?? document.body);
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = before;
    };
  }, []);

  // Offer back what was typed here before a reload, or before Vizzy saved the plan.
  useEffect(() => {
    const draft = readDraft(draftKey);
    if (draft && draft.text !== value) setRestore(draft);
  }, [draftKey, value]);

  useEffect(() => {
    if (!dirty) return;
    const t = window.setTimeout(() => writeDraft(draftKey, { base: value, text: raw }), 400);
    return () => window.clearTimeout(t);
  }, [dirty, raw, draftKey, value]);

  const changed = dirty && raw !== value;

  function showRich(text: string): boolean {
    const reason = cantOpenReason(format, text);
    if (reason || !editor) {
      setRawProblem(reason);
      setView("raw");
      return false;
    }
    editor.commands.setContent(toContent(text), false);
    setRawProblem(null);
    setView("rich");
    return true;
  }

  function finish() {
    clearDraft(draftKey);
    onClose();
  }

  function requestClose() {
    if (changed) setConfirmClose(true);
    else finish();
  }

  async function save(force = false) {
    setNote(null);
    setConfirmClose(false);
    if (!changed) {
      finish();
      return;
    }
    if (raw.length > maxChars) {
      setNote(`This is ${count(raw.length)} characters, and the limit is ${count(maxChars)}. Shorten it to save.`);
      return;
    }
    if (!force && markdown && view === "rich" && editor) {
      const loss = docLoss(editor.getJSON(), format);
      if (loss) {
        setPendingLoss(loss);
        return;
      }
    }
    setPendingLoss(null);
    setSaving(true);
    let ok = false;
    try {
      ok = await onSave(raw);
    } catch {
      ok = false;
    }
    setSaving(false);
    if (ok) finish();
    else setNote("Save failed. Your changes are still here, so try again.");
  }

  if (!target) return null;

  const outline = editor && view === "rich" && markdown ? headingsOf(editor) : [];
  const over = raw.length > maxChars;
  const width = format === "email" ? "max-w-[640px]" : "max-w-[780px]";

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Edit mode: ${title}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          requestClose();
        }
      }}
      className="fixed inset-0 z-50 flex flex-col bg-neutral-100 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-neutral-200 bg-white px-4 py-2.5 dark:border-neutral-800 dark:bg-neutral-950">
        <button
          type="button"
          aria-label="Close Edit mode"
          onClick={requestClose}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
        >
          <X size={16} aria-hidden />
        </button>
        <div className="min-w-0 flex-[1_1_240px]">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{kicker}</div>
          <div className="truncate text-sm font-semibold">{title || "Untitled"}</div>
        </div>
        {changed ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Unsaved changes
          </span>
        ) : null}
        <span className="inline-flex gap-0.5 rounded-lg border border-neutral-200 bg-neutral-100 p-0.5 dark:border-neutral-800 dark:bg-neutral-900">
          <button
            type="button"
            aria-pressed={view === "raw"}
            onClick={() => setView("raw")}
            className={`rounded-md px-3 py-1 text-sm ${view === "raw" ? "bg-white font-semibold shadow-sm dark:bg-neutral-800" : "text-neutral-600 dark:text-neutral-400"}`}
          >
            {RAW_LABEL[format]}
          </button>
          <button
            type="button"
            aria-pressed={view === "rich"}
            onClick={() => (view === "rich" ? undefined : showRich(raw))}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm ${view === "rich" ? "bg-white font-semibold shadow-sm dark:bg-neutral-800" : "text-neutral-600 dark:text-neutral-400"}`}
          >
            <PenLine size={14} aria-hidden />
            Edit mode
          </button>
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={requestClose}
            className="rounded-md border border-neutral-300 bg-white px-3.5 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:hover:bg-neutral-900"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-semibold text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {saving ? "Saving…" : primaryLabel}
          </button>
        </div>
      </header>

      {view === "rich" && editor ? (
        <EditorToolbar
          editor={editor}
          format={format}
          end={<span className="text-xs text-neutral-500">Saves as {RAW_LABEL[format] === "HTML" ? "email HTML" : "Markdown"}</span>}
        />
      ) : null}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-start gap-6 px-4 py-6 sm:px-6">
          <div className={`min-w-0 flex-[999_1_560px] space-y-3 ${width}`}>
            {restore ? (
              <Notice tone="info">
                <span>
                  {restore.base === value
                    ? "You have unsaved changes from earlier."
                    : "You have unsaved changes from earlier, made before this text last changed."}
                </span>
                <button
                  type="button"
                  className={SMALL_BUTTON}
                  onClick={() => {
                    setRaw(restore.text);
                    setDirty(true);
                    if (view === "rich") showRich(restore.text);
                    setRestore(null);
                  }}
                >
                  Restore them
                </button>
                <button
                  type="button"
                  className={SMALL_BUTTON}
                  onClick={() => {
                    clearDraft(draftKey);
                    setRestore(null);
                  }}
                >
                  Discard
                </button>
              </Notice>
            ) : null}
            {view === "raw" && rawProblem ? <Notice tone="warn">{rawProblem}</Notice> : null}
            {pendingLoss ? (
              <Notice tone="warn">
                <span>Some formatting in {where(pendingLoss)} can&apos;t be kept in Markdown, so it will be saved simpler.</span>
                <button type="button" className={SMALL_BUTTON} onClick={() => void save(true)}>
                  {primaryLabel === "Save" ? "Save anyway" : "Done anyway"}
                </button>
                <button type="button" className={SMALL_BUTTON} onClick={() => setPendingLoss(null)}>
                  Keep editing
                </button>
              </Notice>
            ) : null}
            {confirmClose ? (
              <Notice tone="warn">
                <span>Close without saving your changes?</span>
                <button type="button" className={SMALL_BUTTON} onClick={finish}>
                  Discard changes
                </button>
                <button type="button" className={SMALL_BUTTON} onClick={() => setConfirmClose(false)}>
                  Keep editing
                </button>
              </Notice>
            ) : null}
            {note ? <Notice tone="err">{note}</Notice> : null}

            {view === "raw" ? (
              <label className="block">
                <span className="sr-only">{RAW_LABEL[format]}</span>
                <textarea
                  value={raw}
                  onChange={(e) => {
                    setRaw(e.target.value);
                    setDirty(true);
                  }}
                  spellCheck
                  className="min-h-[70vh] w-full rounded-xl border border-neutral-200 bg-white p-4 font-mono text-[13px] leading-relaxed dark:border-neutral-800 dark:bg-neutral-950"
                />
              </label>
            ) : (
              <article className="rounded-xl border border-neutral-200 bg-white px-5 py-8 dark:border-neutral-800 dark:bg-neutral-950 sm:px-12 sm:py-10">
                {heroUrl ? (
                  <figure className="mb-8">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={heroUrl} alt="" className="w-full rounded-lg object-cover" />
                    <figcaption className="mt-2 text-xs text-neutral-500">
                      The hero image, as readers see it. Change it in the Hero card.
                    </figcaption>
                  </figure>
                ) : null}
                <EditorContent editor={editor} />
              </article>
            )}
          </div>

          <aside className="min-w-0 max-w-[360px] flex-[1_1_280px] space-y-4">
            {checks ? (
              <section className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <h2 className="text-sm font-semibold">Checks</h2>
                  <span className="text-xs text-neutral-500">Update as you type</span>
                </div>
                {checks(shown)}
              </section>
            ) : null}
            {outline.length ? (
              <section className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
                <h2 className="text-sm font-semibold">Outline</h2>
                <ul className="mt-2 space-y-1 text-sm">
                  {outline.map((h) => (
                    <li key={h.pos} style={{ paddingLeft: `${(h.level - 1) * 12}px` }}>
                      <button
                        type="button"
                        onClick={() => editor?.chain().focus().setTextSelection(h.pos).scrollIntoView().run()}
                        className="text-left text-neutral-700 hover:underline dark:text-neutral-300"
                      >
                        {h.text}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {tokens?.length && view === "rich" ? (
              <section className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
                <h2 className="text-sm font-semibold">Merge values</h2>
                <p className="mt-1 text-xs text-neutral-500">Filled in for each person when it sends.</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {tokens.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => editor?.chain().focus().insertContent(t).run()}
                      className="rounded border border-neutral-300 px-1.5 py-0.5 font-mono text-xs text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            <section className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
              <div className="flex justify-between gap-2 text-sm">
                <span className="font-semibold">Length</span>
                <span className={over ? "font-medium text-red-700 dark:text-red-400" : "text-neutral-600 dark:text-neutral-400"}>
                  {count(raw.length)} of {count(maxChars)} characters
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                <div
                  className={`h-1.5 ${over ? "bg-red-600" : "bg-blue-600"}`}
                  style={{ width: `${Math.min(100, Math.round((raw.length / maxChars) * 100))}%` }}
                />
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>,
    target,
  );
}
