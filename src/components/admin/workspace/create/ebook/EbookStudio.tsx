"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { EbookChapter, EbookDoc, EbookImageSlot } from "@/lib/types/contentPlan";
import { applyEbookOps, type EbookImageTarget } from "@/lib/content/create/ebookOps";
import { Modal } from "@/components/admin/email/Modal";
import { EbookReadingPane } from "./EbookReadingPane";
import { EbookChatColumn } from "./EbookChatColumn";
import { EbookImageComposer } from "./EbookImageComposer";
import type { EbookImageApi } from "./imageApi";

export type EbookPhase = "toc_loading" | "toc_review" | "chapters" | "finalizing" | "done" | "error";

/**
 * The eBook studio — a full-screen split: LEFT a guidance/assistant column (the chat proper
 * arrives in v2), RIGHT the reading pane (ToC → chapters). Owns the authoritative eBook
 * state + a phase machine, drives ToC generation, chapter-by-chapter SSE streaming behind a
 * confirm gate, and the Finish handoff that runs the architect and lands on the canvas.
 */
export function EbookStudio({
  workspaceId,
  planId,
  planName,
  initialEbook,
}: {
  workspaceId: string;
  planId: string;
  planName: string;
  initialEbook: EbookDoc | null;
}) {
  const router = useRouter();
  const base = `/api/admin/workspace/${workspaceId}/content-plans/${planId}`;
  const JSON_HEADERS = { "Content-Type": "application/json" } as const;

  const [ebook, setEbook] = useState<EbookDoc | null>(initialEbook);
  // Live mirror of `ebook` so rapid read-modify-write handlers (image resize / align / wrap /
  // remove) compose off the LATEST doc instead of a stale render closure (else two quick clicks
  // on the same slot clobber each other). Kept in sync every render + on each optimistic mutate.
  const ebookRef = useRef(ebook);
  ebookRef.current = ebook;
  const [phase, setPhase] = useState<EbookPhase>(initialEbook ? (initialEbook.tocConfirmed ? "chapters" : "toc_review") : "toc_loading");
  const [streaming, setStreaming] = useState<{ chapterId: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const didInit = useRef(false);
  // Debounced auto-save for ToC-review edits (title/subtitle/chapter title/summary/add/
  // remove/reorder). Those go through onLocalChange (local state only) and were otherwise
  // never persisted until "Confirm table of contents" — so leaving mid-edit lost them.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<EbookDoc | null>(null);
  // All PATCH /ebook writes (auto-save + explicit persist) run through ONE serial chain so
  // ordering is guaranteed — an already-fired auto-save can't land AFTER Confirm-ToC and
  // revert tocConfirmed (the reason a plain fire-and-forget was racy).
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  // The image composer (Create-image), opened from a slot / cover / the chat "+" menu.
  const [composer, setComposer] = useState<{
    target: EbookImageTarget | null;
    brief: string;
    mode: "create" | "edit";
    aspect: EbookImageSlot["aspect"];
  } | null>(null);

  // First unconfirmed chapter — the "current" one in the confirm-by-confirm flow.
  const currentIndex = ebook
    ? (() => {
        const i = ebook.chapters.findIndex((c) => c.status !== "confirmed");
        return i < 0 ? ebook.chapters.length : i;
      })()
    : 0;

  // On mount: generate the ToC if there's no draft yet (else we resumed into the right phase).
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    if (initialEbook) return;
    void (async () => {
      setPhase("toc_loading");
      try {
        const res = await fetch(`${base}/ebook/toc`, { method: "POST", headers: JSON_HEADERS });
        const data = (await res.json().catch(() => ({}))) as { ebook?: EbookDoc };
        if (res.ok && data.ebook) {
          setEbook(data.ebook);
          setPhase("toc_review");
        } else {
          setErr("Couldn't generate a table of contents. Go back and try again.");
          setPhase("error");
        }
      } catch {
        setErr("Couldn't reach the server.");
        setPhase("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear a not-yet-fired auto-save (an explicit save supersedes it). If the debounce has
  // already FIRED, its PATCH is already in the serial chain BEFORE the explicit save, so the
  // explicit save still commits last — no revert.
  function cancelPendingSave() {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    pendingSaveRef.current = null;
  }

  /** One PATCH /ebook, run in submission order via the serial chain. */
  function enqueueSave(doc: EbookDoc, echo: boolean): Promise<EbookDoc | null> {
    const run = saveChainRef.current.then(async () => {
      try {
        const res = await fetch(`${base}/ebook`, {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ ebook: doc }),
        });
        const data = (await res.json().catch(() => ({}))) as { ebook?: EbookDoc };
        if (res.ok && data.ebook) {
          if (echo) setEbook(data.ebook); // don't echo an auto-save — avoids a cursor jump mid-typing
          return data.ebook;
        }
        setErr("Couldn't save your changes.");
        return null;
      } catch {
        setErr("Couldn't save your changes.");
        return null;
      }
    });
    saveChainRef.current = run.catch(() => {}); // keep the chain alive on error
    return run;
  }

  /** Explicit save (ToC/chapter confirm, chapter edit, image resize/remove). */
  function persist(next: EbookDoc): Promise<EbookDoc | null> {
    cancelPendingSave();
    return enqueueSave(next, true);
  }

  /** Apply an authoritative server snapshot (chat/image routes) — cancel any pending auto-save
   *  first so a stale ToC-era doc can't later overwrite the snapshot. */
  function applyServerEbook(e: EbookDoc) {
    cancelPendingSave();
    ebookRef.current = e;
    setEbook(e);
  }

  /** Optimistic read-modify-write off the LATEST doc (ebookRef) → update UI now + persist in
   *  order. Used by the image resize/align/wrap/remove handlers so rapid clicks compose. */
  function mutateEbook(fn: (cur: EbookDoc) => EbookDoc) {
    const cur = ebookRef.current;
    if (!cur) return;
    const next = fn(cur);
    ebookRef.current = next; // synchronous → a second rapid handler reads this, not a stale render
    setEbook(next);
    cancelPendingSave();
    void enqueueSave(next, false);
  }

  /** Fire the pending auto-save now (debounce tick or on studio exit). */
  function flushSave() {
    const doc = pendingSaveRef.current;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    pendingSaveRef.current = null;
    if (doc) void enqueueSave(doc, false);
  }

  /** Local ToC edits: update state immediately, then persist after a short debounce. */
  function handleLocalChange(next: EbookDoc) {
    setEbook(next);
    pendingSaveRef.current = next;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, 700);
  }

  // Flush a pending ToC auto-save when the studio unmounts (operator navigates away).
  useEffect(() => () => flushSave(), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function generateChapter(chapterId: string) {
    if (!ebook) return;
    setErr(null);
    setBusy(true);
    setStreaming({ chapterId, text: "" });
    let acc = "";
    try {
      const res = await fetch(`${base}/ebook/chapters/${chapterId}/generate`, {
        method: "POST",
        headers: JSON_HEADERS,
      });
      if (!res.ok || !res.body) throw new Error(`chapter_${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let ev: { type?: string; text?: string; chapter?: EbookChapter; message?: string };
          try {
            ev = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (ev.type === "text" && ev.text) {
            acc += ev.text;
            setStreaming({ chapterId, text: acc });
          } else if (ev.type === "chapter" && ev.chapter) {
            const ch = ev.chapter;
            setEbook((prev) =>
              prev ? { ...prev, chapters: prev.chapters.map((c) => (c.id === chapterId ? ch : c)) } : prev,
            );
          } else if (ev.type === "error") {
            setErr(ev.message ?? "Chapter generation failed.");
          }
        }
      }
    } catch {
      setErr("Chapter generation failed — try again.");
    } finally {
      setStreaming(null);
      setBusy(false);
    }
  }

  async function confirmToc() {
    if (!ebook) return;
    setBusy(true);
    const saved = await persist({ ...ebook, tocConfirmed: true });
    setBusy(false);
    if (saved) setPhase("chapters");
  }

  async function confirmChapter(chapterId: string, andContinue: boolean) {
    if (!ebook) return;
    const idx = ebook.chapters.findIndex((c) => c.id === chapterId);
    const next: EbookDoc = {
      ...ebook,
      chapters: ebook.chapters.map((c) => (c.id === chapterId ? { ...c, status: "confirmed" as const } : c)),
    };
    setBusy(true);
    const saved = await persist(next);
    setBusy(false);
    if (saved && andContinue) {
      const nextChapter = saved.chapters[idx + 1];
      if (nextChapter) void generateChapter(nextChapter.id);
    }
  }

  async function saveChapter(chapter: EbookChapter) {
    if (!ebook) return;
    setBusy(true);
    await persist({
      ...ebook,
      chapters: ebook.chapters.map((c) => (c.id === chapter.id ? chapter : c)),
    });
    setBusy(false);
  }

  async function finish() {
    if (busy) return; // reentrancy guard — one finalize at a time
    setBusy(true);
    setErr(null);
    setPhase("finalizing");
    try {
      const res = await fetch(`${base}/generate`, { method: "POST", headers: JSON_HEADERS });
      if (res.ok) {
        // Success: navigate away and leave busy/phase as-is so the Finish button can't
        // re-enable and fire a duplicate finalize while the route transition is in flight.
        router.replace(`/admin/workspace/${workspaceId}/create/${planId}`);
        return;
      }
      setErr("Couldn't build the canvas — try again.");
    } catch {
      setErr("Couldn't build the canvas — try again.");
    }
    // Only reached on failure — re-enable so the operator can retry.
    setBusy(false);
    setPhase("chapters");
  }

  // ── Images (Slice 2b) ─────────────────────────────────────────────────────
  function openComposer(
    target: EbookImageTarget | null,
    brief: string,
    mode: "create" | "edit",
    aspect: EbookImageSlot["aspect"] = "1:1",
  ) {
    setComposer({ target, brief, mode, aspect });
  }
  async function uploadImage(target: EbookImageTarget, file: File, aspect: EbookImageSlot["aspect"]) {
    const form = new FormData();
    form.append("file", file);
    form.append("target", JSON.stringify(target));
    form.append("aspect", aspect);
    const res = await fetch(`${base}/ebook/images/upload`, { method: "POST", body: form });
    const data = (await res.json().catch(() => ({}))) as { ebook?: EbookDoc; message?: string };
    if (res.ok && data.ebook) applyServerEbook(data.ebook);
    else setErr(data.message ?? "Upload failed.");
  }
  const imageApi: EbookImageApi = {
    assetUrl: (ref) => `/api/admin/workspace/${workspaceId}/asset/${ref}`,
    onGenerate: (chapterId, slot) => openComposer({ kind: "slot", chapterId, slotId: slot.id }, slot.contextPrompt, "create", slot.aspect),
    onEdit: (chapterId, slot) => openComposer({ kind: "slot", chapterId, slotId: slot.id }, "", "edit", slot.aspect),
    onUpload: (chapterId, slot, file) => void uploadImage({ kind: "slot", chapterId, slotId: slot.id }, file, slot.aspect),
    onRemove: (chapterId, slotId) =>
      mutateEbook((cur) => applyEbookOps(cur, [{ op: "remove_image_slot", chapterId, slotId }])),
    onResize: (chapterId, slotId, width) =>
      mutateEbook((cur) => ({
        ...cur,
        chapters: cur.chapters.map((c) =>
          c.id === chapterId ? { ...c, images: c.images.map((s) => (s.id === slotId ? { ...s, width } : s)) } : c,
        ),
      })),
    onSetLayout: (chapterId, slotId, patch) =>
      mutateEbook((cur) => ({
        ...cur,
        chapters: cur.chapters.map((c) =>
          c.id === chapterId ? { ...c, images: c.images.map((s) => (s.id === slotId ? { ...s, ...patch } : s)) } : c,
        ),
      })),
  };
  const composerHasImage = (() => {
    const t = composer?.target;
    if (!t || !ebook) return false;
    if (t.kind === "cover") return !!ebook.coverImage?.imageAssetRef;
    if (t.kind === "slot") {
      const slot = ebook.chapters.find((c) => c.id === t.chapterId)?.images.find((s) => s.id === t.slotId);
      return !!slot?.imageAssetRef;
    }
    return false;
  })();

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-white dark:bg-neutral-950">
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
        <Link
          href={`/admin/workspace/${workspaceId}/create`}
          onClick={flushSave}
          className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          ← Save &amp; exit
        </Link>
        <span className="text-sm font-semibold">📖 eBook studio</span>
        <span className="truncate text-xs text-neutral-400">{planName}</span>
        <span className="ml-auto text-xs text-neutral-400">Auto-saves · resume any time from Create</span>
        {err ? <span className="text-xs text-red-600 dark:text-red-400">{err}</span> : null}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* LEFT — the editing chat (once there's a draft to edit); a step guide otherwise. */}
        <aside className="hidden w-[380px] shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-800 md:flex">
          {ebook && (phase === "toc_review" || phase === "chapters") ? (
            <EbookChatColumn
              workspaceId={workspaceId}
              planId={planId}
              onEbook={applyServerEbook}
              onCreateImage={() => openComposer(null, "", "create")}
              // Persist un-confirmed local edits (toc_review inline title/summary) before the
              // chat mutates the persisted draft, so the returned snapshot doesn't wipe them.
              onBeforeSend={async () => {
                if (ebook) await persist(ebook);
              }}
            />
          ) : (
            <div className="flex-1 space-y-3 overflow-y-auto p-4 text-sm">
              <p className="font-medium">Studio guide</p>
              <StepGuide phase={phase} />
            </div>
          )}
        </aside>

        {/* RIGHT — the book. */}
        <main className="flex-1 overflow-y-auto bg-neutral-50/50 dark:bg-neutral-900/20">
          {phase === "toc_loading" ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-500">
              Drafting your table of contents…
            </div>
          ) : phase === "error" || !ebook ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-500">
              {err ?? "Something went wrong."}
            </div>
          ) : (
            <EbookReadingPane
              ebook={ebook}
              phase={phase}
              streaming={streaming}
              currentIndex={currentIndex}
              busy={busy}
              onLocalChange={handleLocalChange}
              onConfirmToc={confirmToc}
              onGenerateChapter={generateChapter}
              onConfirmChapter={confirmChapter}
              onSaveChapter={saveChapter}
              onFinish={finish}
              api={imageApi}
              onGenerateCover={() => openComposer({ kind: "cover" }, "", "create", ebook.coverImage?.aspect ?? "1:1")}
            />
          )}
        </main>
      </div>

      {composer ? (
        <Modal open title={composer.target?.kind === "cover" ? "Cover image" : "Create image"} onClose={() => setComposer(null)}>
          <EbookImageComposer
            workspaceId={workspaceId}
            planId={planId}
            target={composer.target}
            seedBrief={composer.brief}
            seedMode={composer.mode}
            seedAspect={composer.aspect}
            hasImage={composerHasImage}
            chapters={(ebook?.chapters ?? []).map((c) => ({ id: c.id, title: c.title }))}
            onEbook={applyServerEbook}
            onClose={() => setComposer(null)}
          />
        </Modal>
      ) : null}
    </div>
  );
}

function StepGuide({ phase }: { phase: EbookPhase }) {
  const items: Record<EbookPhase, string[]> = {
    toc_loading: ["Generating a grounded table of contents from your scope + knowledge."],
    toc_review: [
      "Review the outline on the right.",
      "Edit chapter titles/summaries, reorder, add or remove.",
      "Confirm the table of contents to start writing chapters.",
    ],
    chapters: [
      "Generate one chapter at a time — each streams in live.",
      "Edit any chapter's text directly, then Confirm & continue.",
      "Image placeholders mark where illustrations will go (generation lands next).",
    ],
    finalizing: ["Building your canvas…"],
    done: ["Done."],
    error: ["Something went wrong — go back to Create and retry."],
  };
  return (
    <ul className="list-disc space-y-1.5 pl-4 text-neutral-500">
      {items[phase].map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}
