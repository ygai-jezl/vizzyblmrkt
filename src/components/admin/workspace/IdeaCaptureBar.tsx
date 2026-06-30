"use client";

import { useRef, useState } from "react";
import type { IdeaItem } from "@/lib/types/ideaItem";
import { classifyLinkSource } from "@/lib/content/linkSource";

const ERRORS: Record<string, string> = {
  empty_idea: "Add a link, paste text, or attach a screenshot.",
  invalid_url: "That link isn't a valid URL.",
  too_large: "Screenshot is too large (max 8MB).",
  bad_type: "Only PNG, JPEG, or WebP screenshots.",
  upload_failed: "Couldn't store the screenshot.",
  invalid_input: "Check the fields and try again.",
};

/** The Idea Board capture bar — drop a link, paste text, and/or attach a screenshot. */
export function IdeaCaptureBar({
  workspaceId,
  onCaptured,
}: {
  workspaceId: string;
  onCaptured: (item: IdeaItem) => void;
}) {
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Prepend https:// when the user types a bare host (e.g. "example.com/post").
  const normalizedUrl = url.trim()
    ? /^https?:\/\//i.test(url.trim())
      ? url.trim()
      : `https://${url.trim()}`
    : "";
  const cls = normalizedUrl ? classifyLinkSource(normalizedUrl) : null;
  const flakyNudge = Boolean(cls?.host && !cls.fetchable && !text.trim() && !file);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() && !text.trim() && !file) {
      setNote(ERRORS.empty_idea ?? "Add a link, paste text, or attach a screenshot.");
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const endpoint = `/api/admin/workspace/${workspaceId}/idea-items`;
      let res: Response;
      if (file) {
        const form = new FormData();
        if (normalizedUrl) form.set("url", normalizedUrl);
        if (text.trim()) form.set("text", text.trim());
        form.set("file", file);
        res = await fetch(endpoint, { method: "POST", body: form });
      } else {
        res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: normalizedUrl || undefined, text: text.trim() || undefined }),
        });
      }
      const data = (await res.json().catch(() => ({}))) as { item?: IdeaItem; error?: string };
      if (!res.ok || !data.item) {
        setNote(ERRORS[data.error ?? ""] ?? "Couldn't save that idea.");
        return;
      }
      setUrl("");
      setText("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      onCaptured(data.item);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-2 rounded-md border border-neutral-300 p-4 dark:border-neutral-700"
    >
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Paste a link you like (tweet, article, post)…"
        className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />
      {flakyNudge ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {cls?.host} content can&apos;t be auto-read — paste the text or add a screenshot for an
          accurate template.
        </p>
      ) : null}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="…or paste the text / a quick idea"
        rows={3}
        className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          <span className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700">
            {file ? `📎 ${file.name}` : "📎 Add screenshot"}
          </span>
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md border border-neutral-900 bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:border-white dark:bg-white dark:text-neutral-900"
        >
          {busy ? "Capturing…" : "Capture idea"}
        </button>
      </div>
      {note ? <p className="text-xs text-amber-600 dark:text-amber-400">{note}</p> : null}
    </form>
  );
}
