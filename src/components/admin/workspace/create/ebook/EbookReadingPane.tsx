"use client";

import type { EbookChapter, EbookDoc } from "@/lib/types/contentPlan";
import { CONTENT_PLAN_LIMITS } from "@/lib/types/contentPlan";
import { ChapterCard, type ChapterState } from "./ChapterCard";
import type { EbookPhase } from "./EbookStudio";

const PRIMARY =
  "rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900";
const SECONDARY =
  "rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900";
const INPUT =
  "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

function newChapterId(): string {
  return `ch_${crypto.randomUUID()}`;
}

export function EbookReadingPane({
  ebook,
  phase,
  streaming,
  currentIndex,
  busy,
  onLocalChange,
  onConfirmToc,
  onGenerateChapter,
  onConfirmChapter,
  onSaveChapter,
  onFinish,
}: {
  ebook: EbookDoc;
  phase: EbookPhase;
  streaming: { chapterId: string; text: string } | null;
  currentIndex: number;
  busy: boolean;
  onLocalChange: (next: EbookDoc) => void;
  onConfirmToc: () => void;
  onGenerateChapter: (chapterId: string) => void;
  onConfirmChapter: (chapterId: string, andContinue: boolean) => void;
  onSaveChapter: (chapter: EbookChapter) => void;
  onFinish: () => void;
}) {
  const reviewing = phase === "toc_review";
  const allConfirmed = ebook.chapters.length > 0 && currentIndex >= ebook.chapters.length;

  function setChapter(idx: number, patch: Partial<EbookChapter>) {
    onLocalChange({
      ...ebook,
      chapters: ebook.chapters.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    });
  }
  function moveChapter(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= ebook.chapters.length) return;
    const chapters = [...ebook.chapters];
    [chapters[idx], chapters[j]] = [chapters[j]!, chapters[idx]!];
    onLocalChange({ ...ebook, chapters });
  }
  function removeChapter(idx: number) {
    onLocalChange({ ...ebook, chapters: ebook.chapters.filter((_, i) => i !== idx) });
  }
  function addChapter() {
    if (ebook.chapters.length >= CONTENT_PLAN_LIMITS.MAX_CHAPTERS) return;
    onLocalChange({
      ...ebook,
      chapters: [
        ...ebook.chapters,
        { id: newChapterId(), title: "New chapter", summary: "", bodyHtml: "", status: "planned", images: [] },
      ],
    });
  }

  function chapterState(i: number, chapter: EbookChapter): ChapterState {
    // Status-driven (not purely positional) so a chat reorder that moves an unconfirmed
    // chapter ahead of confirmed ones never renders a confirmed chapter as "locked".
    if (streaming?.chapterId === chapter.id) return "streaming";
    if (chapter.status === "confirmed") return "confirmed";
    if (i === currentIndex) return chapter.status === "generated" ? "generated" : "planned";
    return "locked";
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {/* Cover */}
      <header className="mb-6 border-b border-neutral-200 pb-6 dark:border-neutral-800">
        {reviewing ? (
          <div className="space-y-3">
            <input
              value={ebook.title}
              onChange={(e) => onLocalChange({ ...ebook, title: e.target.value })}
              placeholder="eBook title"
              className={`${INPUT} text-lg font-semibold`}
            />
            <input
              value={ebook.subtitle}
              onChange={(e) => onLocalChange({ ...ebook, subtitle: e.target.value })}
              placeholder="Subtitle (the promise to the reader)"
              className={INPUT}
            />
          </div>
        ) : (
          <>
            <h1 className="text-3xl font-bold tracking-tight">{ebook.title}</h1>
            {ebook.subtitle ? <p className="mt-2 text-lg text-neutral-500">{ebook.subtitle}</p> : null}
          </>
        )}
        {ebook.industryLens ? (
          <p className="mt-3 text-xs uppercase tracking-wide text-neutral-400">{ebook.industryLens}</p>
        ) : null}
      </header>

      {/* TOC REVIEW — shape the outline, then confirm. */}
      {reviewing ? (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
            Table of contents
          </h2>
          {ebook.chapters.map((c, i) => (
            <div key={c.id} className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
              <div className="flex items-start gap-2">
                <span className="mt-2 text-xs font-semibold text-neutral-400">{i + 1}</span>
                <div className="flex-1 space-y-2">
                  <input
                    value={c.title}
                    onChange={(e) => setChapter(i, { title: e.target.value })}
                    placeholder="Chapter title"
                    className={`${INPUT} font-medium`}
                  />
                  <textarea
                    value={c.summary}
                    onChange={(e) => setChapter(i, { summary: e.target.value })}
                    placeholder="What this chapter covers"
                    rows={2}
                    className={INPUT}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <button type="button" onClick={() => moveChapter(i, -1)} disabled={i === 0} className="rounded px-1.5 py-0.5 text-xs hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800">↑</button>
                  <button type="button" onClick={() => moveChapter(i, 1)} disabled={i === ebook.chapters.length - 1} className="rounded px-1.5 py-0.5 text-xs hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800">↓</button>
                  <button type="button" onClick={() => removeChapter(i)} className="rounded px-1.5 py-0.5 text-xs text-red-600 hover:bg-neutral-100 dark:hover:bg-neutral-800">✕</button>
                </div>
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between pt-2">
            <button type="button" onClick={addChapter} disabled={ebook.chapters.length >= CONTENT_PLAN_LIMITS.MAX_CHAPTERS} className={SECONDARY}>
              + Add chapter
            </button>
            <button type="button" onClick={onConfirmToc} disabled={busy || ebook.chapters.length === 0} className={PRIMARY}>
              {busy ? "Saving…" : "Confirm table of contents →"}
            </button>
          </div>
        </div>
      ) : null}

      {/* CHAPTERS — generate + confirm one at a time. */}
      {!reviewing ? (
        <div>
          {ebook.chapters.map((c, i) => (
            <ChapterCard
              key={c.id}
              chapter={c}
              index={i}
              total={ebook.chapters.length}
              state={chapterState(i, c)}
              streamingText={streaming?.chapterId === c.id ? streaming.text : ""}
              busy={busy}
              onGenerate={() => onGenerateChapter(c.id)}
              onConfirm={(andContinue) => onConfirmChapter(c.id, andContinue)}
              onSaveEdit={onSaveChapter}
            />
          ))}

          {allConfirmed ? (
            <div className="mt-8 rounded-md border border-neutral-200 p-6 text-center dark:border-neutral-800">
              <p className="text-sm text-neutral-500">
                Every chapter is confirmed. Finish to build the canvas — your eBook becomes the hub
                with spokes to atomize it.
              </p>
              <button type="button" onClick={onFinish} disabled={busy} className={`${PRIMARY} mt-4`}>
                {busy ? "Building…" : "Finish eBook →"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
