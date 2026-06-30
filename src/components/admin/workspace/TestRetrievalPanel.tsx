"use client";

import { useState } from "react";
import { CONTENT_MATRIX_TOPICS, contentMatrixLabel } from "@/lib/content/contentMatrix";

interface ResultChunk {
  title: string;
  content: string;
  sourceUri: string;
  topic: string | null;
  tags: string[];
}

/**
 * Test-retrieval box: run the same nearest-neighbour search an agent would, with
 * an optional topic OR tag pre-filter, and preview the grounding it returns.
 */
export function TestRetrievalPanel({ workspaceId }: { workspaceId: string }) {
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState("");
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [chunks, setChunks] = useState<ResultChunk[] | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setNote(null);
    setChunks(null);
    try {
      const body: Record<string, unknown> = {
        ownerKind: "workspace",
        ownerId: workspaceId,
        query: query.trim(),
      };
      if (topic) body.topic = topic;
      if (tag.trim()) body.tag = tag.trim().toLowerCase();
      const res = await fetch("/api/admin/knowledge/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        chunks?: ResultChunk[];
        error?: string;
      };
      if (!res.ok) {
        setNote(
          data.error === "filter_one_at_a_time"
            ? "Filter by topic OR tag, not both (combined filtering is coming)."
            : "Search failed.",
        );
        return;
      }
      setChunks(data.chunks ?? []);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-md border border-neutral-300 p-4 dark:border-neutral-700">
      <div>
        <h2 className="text-sm font-semibold">Test retrieval</h2>
        <p className="text-xs text-neutral-500">
          Preview the grounding an agent would receive for a query. Optionally scope by a topic
          or a tag.
        </p>
      </div>
      <form onSubmit={run} className="flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="A topic or question to ground on…"
          className="min-w-[14rem] flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <select
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          className="rounded-md border border-neutral-300 px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          <option value="">Any topic</option>
          {CONTENT_MATRIX_TOPICS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="tag"
          className="w-28 rounded-md border border-neutral-300 px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-md border border-neutral-900 bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:border-white dark:bg-white dark:text-neutral-900"
        >
          {busy ? "Searching…" : "Test"}
        </button>
      </form>
      {note ? <p className="text-xs text-amber-600 dark:text-amber-400">{note}</p> : null}
      {chunks !== null ? (
        chunks.length === 0 ? (
          <p className="text-xs text-neutral-500">No matching grounding found.</p>
        ) : (
          <ul className="space-y-2">
            {chunks.map((c, i) => (
              <li
                key={i}
                className="rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800"
              >
                <div className="flex items-center gap-2 text-xs text-neutral-500">
                  <span className="truncate" title={c.sourceUri}>
                    {c.title || c.sourceUri}
                  </span>
                  {c.topic ? (
                    <span className="rounded bg-violet-50 px-1.5 py-0.5 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
                      {contentMatrixLabel(c.topic)}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-neutral-700 dark:text-neutral-300">
                  {c.content.slice(0, 300)}
                  {c.content.length > 300 ? "…" : ""}
                </p>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
