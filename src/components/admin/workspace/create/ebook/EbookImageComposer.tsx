"use client";

import { useRef, useState } from "react";
import type { EbookAspect, EbookDoc } from "@/lib/types/contentPlan";
import type { EbookImageTarget } from "@/lib/content/create/ebookOps";
import {
  EBOOK_ASPECTS,
  EBOOK_ASPECT_LABELS,
  EBOOK_IMAGE_STYLES,
  DEFAULT_EBOOK_IMAGE_STYLE,
} from "@/lib/content/create/ebook";

const PRIMARY =
  "rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900";
const SECONDARY =
  "rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900";
const INPUT =
  "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

/**
 * The "Create image" panel (rendered in a modal). Generates OR iteratively edits an on-brand
 * eBook image for a target (an existing slot / a new slot in a chapter / the cover), or uploads
 * one. On success it applies the returned draft snapshot via onEbook. When `target` is null
 * (opened from the "+" menu) it shows a target picker (cover / new image in a chapter).
 */
export function EbookImageComposer({
  workspaceId,
  planId,
  target,
  seedBrief,
  seedMode,
  seedAspect,
  chapters,
  hasImage,
  onEbook,
  onClose,
}: {
  workspaceId: string;
  planId: string;
  target: EbookImageTarget | null;
  seedBrief: string;
  seedMode: "create" | "edit";
  /** The existing image's aspect (so a colour tweak doesn't reset a 1:4 slot to 1:1). */
  seedAspect: EbookAspect;
  chapters: { id: string; title: string }[];
  /** True when the target already holds an image (so we lead with Refine, not Generate). */
  hasImage: boolean;
  onEbook: (ebook: EbookDoc) => void;
  onClose: () => void;
}) {
  const base = `/api/admin/workspace/${workspaceId}/content-plans/${planId}/ebook/images`;
  const [mode, setMode] = useState<"create" | "edit">(seedMode);
  const [brief, setBrief] = useState(seedBrief);
  const [aspect, setAspect] = useState<EbookAspect>(seedAspect);
  const [style, setStyle] = useState<string>(DEFAULT_EBOOK_IMAGE_STYLE);
  const [pickKind, setPickKind] = useState<"cover" | "new">(chapters.length ? "new" : "cover");
  const [pickChapter, setPickChapter] = useState<string>(chapters[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Effective target: the fixed one, or the picker's choice for a free "+" create.
  const effectiveTarget: EbookImageTarget | null =
    target ?? (pickKind === "cover" ? { kind: "cover" } : pickChapter ? { kind: "new", chapterId: pickChapter } : null);

  async function run(payload: Record<string, unknown>) {
    if (!effectiveTarget) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: effectiveTarget, aspect, style, ...payload }),
      });
      const data = (await res.json().catch(() => ({}))) as { ebook?: EbookDoc; message?: string };
      if (res.ok && data.ebook) {
        onEbook(data.ebook);
        // A free "+" create targets a NEW slot whose id we don't get back — so we can't refine
        // it (a second Generate would append a DUPLICATE). Close instead; the operator refines
        // via the new slot's Edit button. Fixed slot/cover targets stay open in refine mode.
        if (!target) {
          onClose();
          return;
        }
        setMode("edit");
        setBrief("");
      } else {
        setErr(data.message ?? "Image generation failed — try again.");
      }
    } catch {
      setErr("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const generate = () => run({ brief: brief.trim(), mode: "create" });
  const refine = () => brief.trim() && run({ instruction: brief.trim(), mode: "edit" });

  async function upload(file: File) {
    if (!effectiveTarget) return;
    setBusy(true);
    setErr(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("target", JSON.stringify(effectiveTarget));
      form.append("aspect", aspect);
      const res = await fetch(`${base}/upload`, { method: "POST", body: form });
      const data = (await res.json().catch(() => ({}))) as { ebook?: EbookDoc; message?: string };
      if (res.ok && data.ebook) {
        onEbook(data.ebook);
        onClose();
      } else {
        setErr(data.message ?? "Upload failed — use a PNG, JPEG, or WebP under 8 MB.");
      }
    } catch {
      setErr("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const refining = mode === "edit" && (hasImage || false);

  return (
    <div className="space-y-3">
      {/* Target picker (only for a free "+" create) */}
      {!target ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-neutral-500">Add to:</span>
          <select value={pickKind} onChange={(e) => setPickKind(e.target.value as "cover" | "new")} className="rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900">
            <option value="cover">Cover</option>
            {chapters.length ? <option value="new">A chapter</option> : null}
          </select>
          {pickKind === "new" ? (
            <select value={pickChapter} onChange={(e) => setPickChapter(e.target.value)} className="max-w-[220px] rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900">
              {chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      ) : null}

      <textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        rows={3}
        placeholder={refining ? "Describe a change (e.g. make the background navy)…" : "Describe the image you want…"}
        className={INPUT}
      />

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm">
          <span className="text-neutral-500">Aspect</span>
          <select value={aspect} onChange={(e) => setAspect(e.target.value as EbookAspect)} className="rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900">
            {EBOOK_ASPECTS.map((a) => (
              <option key={a} value={a}>
                {EBOOK_ASPECT_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <span className="text-neutral-500">Style</span>
          <select value={style} onChange={(e) => setStyle(e.target.value)} className="rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900">
            {EBOOK_IMAGE_STYLES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {err ? <p className="text-xs text-red-600 dark:text-red-400">{err}</p> : null}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {refining ? (
          <button type="button" onClick={refine} disabled={busy || !brief.trim()} className={PRIMARY}>
            {busy ? "Editing…" : "Apply edit"}
          </button>
        ) : (
          <button type="button" onClick={generate} disabled={busy || !brief.trim() || !effectiveTarget} className={PRIMARY}>
            {busy ? "Generating…" : "Generate"}
          </button>
        )}
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy || !effectiveTarget} className={SECONDARY}>
          Upload
        </button>
        <button type="button" onClick={onClose} className={SECONDARY}>
          Done
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
