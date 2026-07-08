"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { EbookChapter, EbookDoc } from "@/lib/types/contentPlan";
import { EbookReadingPane } from "./EbookReadingPane";

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
  const [phase, setPhase] = useState<EbookPhase>(initialEbook ? (initialEbook.tocConfirmed ? "chapters" : "toc_review") : "toc_loading");
  const [streaming, setStreaming] = useState<{ chapterId: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const didInit = useRef(false);

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

  async function persist(next: EbookDoc): Promise<EbookDoc | null> {
    try {
      const res = await fetch(`${base}/ebook`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ ebook: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { ebook?: EbookDoc };
      if (res.ok && data.ebook) {
        setEbook(data.ebook);
        return data.ebook;
      }
      setErr("Couldn't save your changes.");
      return null;
    } catch {
      setErr("Couldn't save your changes.");
      return null;
    }
  }

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

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-white dark:bg-neutral-950">
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
        <Link href={`/admin/workspace/${workspaceId}/create`} className="text-xs text-neutral-500 hover:underline">
          ← Create
        </Link>
        <span className="text-sm font-semibold">📖 eBook studio</span>
        <span className="truncate text-xs text-neutral-400">{planName}</span>
        {err ? <span className="ml-auto text-xs text-red-600 dark:text-red-400">{err}</span> : null}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* LEFT — assistant / guidance column (chat proper lands in v2). */}
        <aside className="hidden w-[360px] shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-800 md:flex">
          <div className="flex-1 space-y-3 overflow-y-auto p-4 text-sm">
            <p className="font-medium">Studio guide</p>
            <StepGuide phase={phase} />
          </div>
          <div className="border-t border-neutral-200 p-3 dark:border-neutral-800">
            <div className="flex items-center gap-2 rounded-full border border-neutral-200 px-3 py-2 text-sm text-neutral-400 dark:border-neutral-800">
              <span>＋</span>
              <span className="flex-1">Chat editing &amp; image generation arrive next…</span>
            </div>
          </div>
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
              onLocalChange={setEbook}
              onConfirmToc={confirmToc}
              onGenerateChapter={generateChapter}
              onConfirmChapter={confirmChapter}
              onSaveChapter={saveChapter}
              onFinish={finish}
            />
          )}
        </main>
      </div>
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
