"use client";

import { useState } from "react";
import Link from "next/link";
import type { IdeaItem } from "@/lib/types/ideaItem";
import type { Template } from "@/lib/types/template";
import { GroupCombobox } from "./GroupCombobox";
import { templateCategoryLabel } from "@/lib/content/templateCategories";

export function IdeaCard({
  workspaceId,
  item,
  groups,
  onDelete,
  onTemplatized,
  onGroupCreated,
}: {
  workspaceId: string;
  item: IdeaItem;
  groups: string[];
  onDelete: (id: string) => void;
  onTemplatized: (id: string, template: Template) => void;
  onGroupCreated: (group: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [template, setTemplate] = useState<Template | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function templatize() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/admin/workspace/${workspaceId}/idea-items/${item.id}/templatize`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => ({}))) as { template?: Template };
      if (!res.ok || !data.template) {
        setErr("Couldn't templatize — try again.");
        return;
      }
      setTemplate(data.template);
      onTemplatized(item.id, data.template);
    } finally {
      setBusy(false);
    }
  }

  async function changeGroup(g: string) {
    if (!template) return;
    const res = await fetch(`/api/admin/workspace/${workspaceId}/templates/${template.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group: g }),
    });
    const data = (await res.json().catch(() => ({}))) as { template?: Template };
    if (res.ok && data.template) {
      setTemplate(data.template);
      onGroupCreated(g);
    }
  }

  async function remove() {
    if (!window.confirm("Delete this idea?")) return;
    setDeleting(true);
    const res = await fetch(`/api/admin/workspace/${workspaceId}/idea-items/${item.id}`, {
      method: "DELETE",
    });
    if (res.ok) onDelete(item.id);
    else setDeleting(false);
  }

  const sourceBadge = item.sourceHost ?? (item.screenshotPath ? "screenshot" : "text");
  const alreadyTemplatized = item.status === "templatized" || Boolean(template);

  return (
    <div className="space-y-2 rounded-md border border-neutral-300 p-3 dark:border-neutral-700">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium">{item.title}</div>
        <span className="shrink-0 rounded bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
          {sourceBadge}
        </span>
      </div>

      {item.screenshotPath ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/admin/workspace/${workspaceId}/asset/${item.screenshotPath}`}
          alt="Idea screenshot"
          className="max-h-40 rounded border border-neutral-200 dark:border-neutral-700"
        />
      ) : null}
      {item.text ? (
        <p className="line-clamp-4 whitespace-pre-wrap text-xs text-neutral-600 dark:text-neutral-300">
          {item.text}
        </p>
      ) : null}
      {item.url ? (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="block truncate text-xs text-violet-600 underline dark:text-violet-400"
        >
          {item.url}
        </a>
      ) : null}

      {template ? (
        <div className="space-y-2 rounded border border-violet-200 bg-violet-50/40 p-2 dark:border-violet-900 dark:bg-violet-950/20">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-violet-100 px-2 py-0.5 text-violet-700 dark:bg-violet-900/60 dark:text-violet-200">
              {templateCategoryLabel(template.category)}
            </span>
            <span className="text-neutral-400">·</span>
            <GroupCombobox value={template.group} options={groups} onChange={changeGroup} />
            <span className="text-[11px] text-green-600 dark:text-green-400">✨ AI suggested</span>
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-xs dark:bg-neutral-900">
            {template.body}
          </pre>
          <Link
            href={`/admin/workspace/${workspaceId}/templatize`}
            className="text-xs text-violet-600 underline dark:text-violet-400"
          >
            Open in Templatize →
          </Link>
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        {!alreadyTemplatized ? (
          <button
            onClick={templatize}
            disabled={busy}
            className="rounded-md border border-violet-600 bg-violet-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            {busy ? "Templatizing…" : "✨ Templatize"}
          </button>
        ) : !template ? (
          <Link
            href={`/admin/workspace/${workspaceId}/templatize`}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
          >
            View template →
          </Link>
        ) : null}
        <button
          onClick={remove}
          disabled={deleting}
          className="text-xs text-red-600 disabled:opacity-50 dark:text-red-400"
        >
          {deleting ? "…" : "Delete"}
        </button>
      </div>
      {err ? <p className="text-xs text-red-600 dark:text-red-400">{err}</p> : null}
    </div>
  );
}
