"use client";

import { useEffect, useRef, useState } from "react";
import type { EbookChapter, EbookImageSlot } from "@/lib/types/contentPlan";
import {
  splitChapterByImages,
  reconcileChapterImages,
} from "@/lib/content/create/ebookHtml";
import { ebookAspectRatioCss } from "@/lib/content/create/ebook";
import { EbookChapterEditor } from "./EbookChapterEditor";
import type { EbookImageApi } from "./imageApi";

/** The gate state of a chapter within the confirm-by-confirm flow. */
export type ChapterState = "locked" | "planned" | "streaming" | "generated" | "confirmed";

const PRIMARY =
  "rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900";
const SECONDARY =
  "rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900";

const SLOT_CTRL = "rounded px-1.5 py-0.5 text-[11px] hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-800";

/**
 * An inline image slot. Placeholder → Generate / Upload / ✕. Generated → the image (served via
 * the authenticated asset proxy) + a width slider + Edit / Regenerate / Upload / ✕. Inert when
 * no `api` (e.g. inside the Tiptap editor's node view). Width drags locally, persists on release.
 */
function SlotCard({
  slot,
  chapterId,
  api,
}: {
  slot: EbookImageSlot | undefined;
  chapterId: string;
  api?: EbookImageApi;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [w, setW] = useState(slot?.width ?? 100);
  // Re-sync to the persisted width (revert a failed resize; reflect a server snapshot).
  useEffect(() => {
    if (slot) setW(slot.width);
  }, [slot?.width]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!slot) return null;
  const generated = slot.status === "generated" && !!slot.imageAssetRef;

  const uploadInput = api ? (
    <input
      ref={fileRef}
      type="file"
      accept="image/png,image/jpeg,image/webp"
      className="hidden"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) api.onUpload(chapterId, slot, f);
        e.target.value = "";
      }}
    />
  ) : null;

  if (generated) {
    return (
      <div className="my-4 flex flex-col items-center">
        <div style={{ width: `${w}%`, aspectRatio: ebookAspectRatioCss(slot.aspect) }} className="overflow-hidden rounded-md">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={api!.assetUrl(slot.imageAssetRef!)}
            alt={slot.contextPrompt || "eBook illustration"}
            className="h-full w-full object-cover"
          />
        </div>
        {api ? (
          <div className="mt-1.5 flex items-center gap-2">
            <input
              type="range"
              min={20}
              max={100}
              value={w}
              onChange={(e) => setW(Number(e.target.value))}
              onMouseUp={() => api.onResize(chapterId, slot.id, w)}
              onTouchEnd={() => api.onResize(chapterId, slot.id, w)}
              onKeyUp={() => api.onResize(chapterId, slot.id, w)}
              className="w-24"
              title={`Width ${w}%`}
            />
            <button type="button" onClick={() => api.onEdit(chapterId, slot)} className={SLOT_CTRL}>Edit</button>
            <button type="button" onClick={() => api.onGenerate(chapterId, slot)} className={SLOT_CTRL}>Regenerate</button>
            <button type="button" onClick={() => fileRef.current?.click()} className={SLOT_CTRL}>Upload</button>
            <button type="button" onClick={() => api.onRemove(chapterId, slot.id)} className={`${SLOT_CTRL} text-red-600`}>✕</button>
            {uploadInput}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="my-4 flex flex-col items-center">
      <div
        className="flex flex-col items-center justify-center rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-4 text-center text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/40"
        style={{ width: `${slot.width}%`, aspectRatio: ebookAspectRatioCss(slot.aspect) }}
      >
        <span aria-hidden className="text-lg">🖼</span>
        <span className="mt-1 line-clamp-3">{slot.contextPrompt || "Image placeholder"}</span>
        <span className="mt-1 text-[10px] uppercase tracking-wide text-neutral-400">{slot.aspect}</span>
      </div>
      {api ? (
        <div className="mt-1.5 flex items-center gap-2">
          <button type="button" onClick={() => api.onGenerate(chapterId, slot)} className={SLOT_CTRL}>Generate</button>
          <button type="button" onClick={() => fileRef.current?.click()} className={SLOT_CTRL}>Upload</button>
          <button type="button" onClick={() => api.onRemove(chapterId, slot.id)} className={`${SLOT_CTRL} text-red-600`}>✕</button>
          {uploadInput}
        </div>
      ) : null}
    </div>
  );
}

/** Rendered (read) chapter: sanitized HTML segments interleaved with interactive slot cards. */
function ChapterContent({ chapter, api }: { chapter: EbookChapter; api?: EbookImageApi }) {
  const byId = new Map(chapter.images.map((s) => [s.id, s]));
  const segments = splitChapterByImages(chapter.bodyHtml);
  return (
    <div className="prose prose-sm max-w-none leading-relaxed dark:prose-invert">
      {segments.map((seg, i) =>
        seg.type === "html" ? (
          // bodyHtml is server-sanitized (sanitizeEbookHtml) on every persist.
          <div key={i} dangerouslySetInnerHTML={{ __html: seg.html }} />
        ) : (
          <SlotCard key={seg.slotId} slot={byId.get(seg.slotId)} chapterId={chapter.id} api={api} />
        ),
      )}
    </div>
  );
}

export function ChapterCard({
  chapter,
  index,
  total,
  state,
  streamingText,
  busy,
  api,
  onGenerate,
  onConfirm,
  onSaveEdit,
}: {
  chapter: EbookChapter;
  index: number;
  total: number;
  state: ChapterState;
  streamingText: string;
  busy: boolean;
  api?: EbookImageApi;
  onGenerate: () => void;
  onConfirm: (andContinue: boolean) => void;
  onSaveEdit: (next: EbookChapter) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chapter.bodyHtml);
  const isLast = index === total - 1;

  function saveEdit() {
    const images = reconcileChapterImages(draft, chapter.images);
    onSaveEdit({ ...chapter, bodyHtml: draft, images });
    setEditing(false);
  }

  return (
    <section className="border-t border-neutral-200 py-6 first:border-t-0 dark:border-neutral-800">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Chapter {index + 1} of {total}
        </span>
        {state === "confirmed" ? (
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
            confirmed
          </span>
        ) : null}
      </div>

      {/* Locked — waiting for earlier chapters to be confirmed. */}
      {state === "locked" ? (
        <div className="rounded-md border border-dashed border-neutral-300 p-5 dark:border-neutral-700">
          <div className="text-sm font-medium text-neutral-500">{chapter.title}</div>
          <p className="mt-1 text-xs text-neutral-400">{chapter.summary}</p>
          <p className="mt-3 text-xs text-neutral-400">
            Confirm the previous chapter to unlock generation.
          </p>
        </div>
      ) : null}

      {/* Ready to generate. */}
      {state === "planned" ? (
        <div className="rounded-md border border-neutral-200 p-5 dark:border-neutral-800">
          <div className="text-base font-semibold">{chapter.title}</div>
          <p className="mt-1 text-sm text-neutral-500">{chapter.summary}</p>
          <button type="button" onClick={onGenerate} disabled={busy} className={`${PRIMARY} mt-4`}>
            {busy ? "Generating…" : "Generate this chapter"}
          </button>
        </div>
      ) : null}

      {/* Streaming live. */}
      {state === "streaming" ? (
        <div>
          <div className="text-base font-semibold">{chapter.title}</div>
          <pre className="mt-3 whitespace-pre-wrap break-words rounded-md bg-neutral-50 p-4 text-sm leading-relaxed text-neutral-700 dark:bg-neutral-900/40 dark:text-neutral-300">
            {streamingText || "Writing…"}
            <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-neutral-400 align-middle" />
          </pre>
        </div>
      ) : null}

      {/* Generated or confirmed — render + edit + (for the current chapter) confirm gate. */}
      {state === "generated" || state === "confirmed" ? (
        <div>
          {editing ? (
            <>
              <EbookChapterEditor html={chapter.bodyHtml} onChange={setDraft} />
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={saveEdit} className={PRIMARY}>
                  Save changes
                </button>
                <button type="button" onClick={() => { setDraft(chapter.bodyHtml); setEditing(false); }} className={SECONDARY}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <ChapterContent chapter={chapter} api={api} />
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => { setDraft(chapter.bodyHtml); setEditing(true); }} className={SECONDARY}>
                  Edit
                </button>
                {state === "generated" ? (
                  <>
                    <button type="button" onClick={onGenerate} disabled={busy} className={SECONDARY}>
                      Regenerate
                    </button>
                    <button type="button" onClick={() => onConfirm(!isLast)} disabled={busy} className={PRIMARY}>
                      {isLast ? "Confirm & finish" : "Confirm & continue"}
                    </button>
                  </>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
