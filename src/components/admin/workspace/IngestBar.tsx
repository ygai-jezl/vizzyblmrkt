"use client";

import { useState } from "react";
import { CONTENT_MATRIX_TOPICS } from "@/lib/content/contentMatrix";
import { GitConnectHint } from "./GitConnectHint";

const SOURCE_TYPES = [
  { id: "docs_url", label: "Docs / page" },
  { id: "website", label: "Website (crawl)" },
  { id: "github", label: "GitHub repo" },
  { id: "gitlab", label: "GitLab repo" },
] as const;

const ERRORS: Record<string, string> = {
  invalid_input: "Check the form fields.",
  invalid_topic: "Pick a valid topic.",
  invalid_source_url: "That URL isn't allowed (https only; git sources must be github.com / gitlab.com).",
  too_many_active_ingestions: "Too many ingestions in progress — wait for some to finish.",
  owner_not_found: "Workspace not found.",
  job_trigger_failed: "Couldn't start the ingestion worker.",
};

/** The "Ingest Grounding Source" bar — vectorizes a URL into the workspace KB. */
export function IngestBar({
  workspaceId,
  onIngested,
}: {
  workspaceId: string;
  onIngested: () => void | Promise<void>;
}) {
  const [source, setSource] = useState<string>("docs_url");
  const [url, setUrl] = useState("");
  const [topic, setTopic] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const isRepo = source === "github" || source === "gitlab";

  function addTag(raw: string) {
    const t = raw.trim().toLowerCase().replace(/\s+/g, " ");
    if (t && !tags.includes(t) && tags.length < 20) setTags([...tags, t]);
    setTagDraft("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return setNote("Add a source URL.");
    setBusy(true);
    setNote(null);
    try {
      const body: Record<string, unknown> = {
        ownerKind: "workspace",
        ownerId: workspaceId,
        source,
        sourceUri: url.trim(),
        tags,
      };
      if (topic) body.topic = topic;
      if (isRepo && gitRef.trim()) body.ref = gitRef.trim();
      const res = await fetch("/api/admin/knowledge/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; status?: string };
      if (!res.ok) {
        setNote(ERRORS[data.error ?? ""] ?? "Couldn't ingest that source.");
        return;
      }
      if (data.status === "duplicate") {
        setNote("That source is already ingested.");
        await onIngested();
        return;
      }
      setUrl("");
      setGitRef("");
      setTags([]);
      setTagDraft("");
      await onIngested();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-md border border-neutral-300 p-4 dark:border-neutral-700"
    >
      <div className="flex flex-wrap gap-2">
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="rounded-md border border-neutral-300 px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          {SOURCE_TYPES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://… (docs page, site, or repo URL)"
          className="min-w-[16rem] flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        {isRepo ? (
          <input
            value={gitRef}
            onChange={(e) => setGitRef(e.target.value)}
            placeholder="branch / tag / SHA (optional)"
            className="w-44 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        ) : null}
      </div>

      {isRepo ? (
        <div className="flex items-center">
          <GitConnectHint provider={source as "github" | "gitlab"} />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          className="rounded-md border border-neutral-300 px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          <option value="">Topic (optional)…</option>
          {CONTENT_MATRIX_TOPICS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>

        <div className="flex flex-1 flex-wrap items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700">
          {tags.map((t) => (
            <span
              key={t}
              className="flex items-center gap-1 rounded bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800"
            >
              {t}
              <button
                type="button"
                onClick={() => setTags(tags.filter((x) => x !== t))}
                className="text-neutral-400 hover:text-neutral-700"
              >
                ×
              </button>
            </span>
          ))}
          <input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag(tagDraft);
              }
            }}
            onBlur={() => tagDraft && addTag(tagDraft)}
            placeholder={tags.length ? "" : "custom tags (Enter)"}
            className="min-w-[8rem] flex-1 bg-transparent px-1 py-1 text-sm outline-none"
          />
        </div>

        <button
          type="submit"
          disabled={busy}
          className="rounded-md border border-neutral-900 bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:border-white dark:bg-white dark:text-neutral-900"
        >
          {busy ? "Ingesting…" : "Ingest"}
        </button>
      </div>
      {note ? <p className="text-xs text-amber-600 dark:text-amber-400">{note}</p> : null}
    </form>
  );
}
