"use client";

import { useState } from "react";
import { CONTENT_MATRIX_TOPICS } from "@/lib/content/contentMatrix";

interface Workspace {
  topics?: string[];
  defaultTags?: string[];
  brandVoice?: string | null;
  audience?: string | null;
}

/** Workspace Settings — authority topics, default tags, brand voice + audience. */
export function WorkspaceSettings({
  workspaceId,
  initial,
}: {
  workspaceId: string;
  initial: { topics: string[]; defaultTags: string[]; brandVoice: string; audience: string };
}) {
  const [topics, setTopics] = useState<string[]>(initial.topics);
  const [tags, setTags] = useState<string[]>(initial.defaultTags);
  const [tagDraft, setTagDraft] = useState("");
  const [brandVoice, setBrandVoice] = useState(initial.brandVoice);
  const [audience, setAudience] = useState(initial.audience);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  function toggleTopic(id: string) {
    setStatus("idle");
    setTopics((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  }
  function addTag(raw: string) {
    const t = raw.trim().toLowerCase().replace(/\s+/g, " ");
    if (t && !tags.includes(t) && tags.length < 20) setTags([...tags, t]);
    setTagDraft("");
    setStatus("idle");
  }

  async function save() {
    setStatus("saving");
    try {
      const res = await fetch(`/api/admin/workspace/${workspaceId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topics, defaultTags: tags, brandVoice, audience }),
      });
      if (!res.ok) throw new Error("save_failed");
      const d = (await res.json().catch(() => ({}))) as { workspace?: Workspace };
      setTopics(d.workspace?.topics ?? []);
      setTags(d.workspace?.defaultTags ?? []);
      setBrandVoice(d.workspace?.brandVoice ?? "");
      setAudience(d.workspace?.audience ?? "");
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-sm font-semibold">Workspace Settings</h2>
        <p className="text-sm text-neutral-500">
          Define what this workspace is about. Later, these drive how content is created from your
          grounding data.
        </p>
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Authority topics</h3>
        <p className="text-xs text-neutral-500">
          The Content Matrix topics you want to create content around and become an authority in.
        </p>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {CONTENT_MATRIX_TOPICS.map((t) => (
            <label key={t.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={topics.includes(t.id)}
                onChange={() => toggleTopic(t.id)}
              />
              {t.label}
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Default tags</h3>
        <p className="text-xs text-neutral-500">Free-form tags suggested for new grounding sources.</p>
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700">
          {tags.map((t) => (
            <span
              key={t}
              className="flex items-center gap-1 rounded bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800"
            >
              {t}
              <button
                type="button"
                onClick={() => {
                  setTags(tags.filter((x) => x !== t));
                  setStatus("idle");
                }}
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
            placeholder={tags.length ? "" : "add a tag (Enter)"}
            className="min-w-[8rem] flex-1 bg-transparent px-1 py-1 text-sm outline-none"
          />
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Brand voice</h3>
        <p className="text-xs text-neutral-500">
          How your content should sound — informs templatize + deconstruct.
        </p>
        <textarea
          value={brandVoice}
          onChange={(e) => {
            setBrandVoice(e.target.value);
            setStatus("idle");
          }}
          rows={2}
          placeholder="e.g. Direct, practical, no hype. Short sentences."
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Audience</h3>
        <p className="text-xs text-neutral-500">Who you&apos;re writing for (reader persona).</p>
        <textarea
          value={audience}
          onChange={(e) => {
            setAudience(e.target.value);
            setStatus("idle");
          }}
          rows={2}
          placeholder="e.g. Early-stage B2B SaaS founders."
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={status === "saving"}
          className="rounded-md border border-neutral-900 bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:border-white dark:bg-white dark:text-neutral-900"
        >
          {status === "saving" ? "Saving…" : "Save"}
        </button>
        {status === "saved" ? (
          <span className="text-xs text-green-600 dark:text-green-400">Saved.</span>
        ) : null}
        {status === "error" ? (
          <span className="text-xs text-red-600 dark:text-red-400">Save failed.</span>
        ) : null}
      </div>
    </div>
  );
}
