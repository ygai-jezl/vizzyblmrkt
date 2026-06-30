"use client";

import { useEffect, useState } from "react";
import type { Template } from "@/lib/types/template";
import { GroupCombobox } from "./GroupCombobox";
import { PlaceholderList } from "./PlaceholderList";
import { ReframeControl } from "./ReframeControl";
import { DeconstructControl } from "./DeconstructControl";
import { TEMPLATE_CATEGORIES } from "@/lib/content/templateCategories";
import { frameworkLabel } from "@/lib/content/frameworks";
import { blockLabel, moduleSizeLabel } from "@/lib/content/blocks";
import { channelLabel } from "@/lib/content/channels";

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
      {children}
    </span>
  );
}

export function TemplateCard({
  workspaceId,
  template,
  groups,
  onUpdate,
  onDelete,
  onDeconstructed,
}: {
  workspaceId: string;
  template: Template;
  groups: string[];
  onUpdate: (t: Template) => void;
  onDelete: (id: string) => void;
  onDeconstructed?: (spokes: Template[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(template.title);
  const [body, setBody] = useState(template.body);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  // Optimistic category so the select reflects the choice during the async PUT.
  const [cat, setCat] = useState(template.category);
  useEffect(() => setCat(template.category), [template.category]);

  async function put(patch: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setErr(false);
    try {
      const res = await fetch(`/api/admin/workspace/${workspaceId}/templates/${template.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await res.json().catch(() => ({}))) as { template?: Template };
      if (res.ok && data.template) {
        onUpdate(data.template);
        return true;
      }
      setErr(true);
      return false;
    } catch {
      setErr(true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function changeCategory(next: string) {
    setCat(next as Template["category"]); // optimistic
    if (!(await put({ category: next }))) setCat(template.category); // revert on failure
  }

  async function save() {
    if (await put({ title: title.trim(), body })) setEditing(false);
  }

  async function remove() {
    if (!window.confirm("Delete this template?")) return;
    const res = await fetch(`/api/admin/workspace/${workspaceId}/templates/${template.id}`, {
      method: "DELETE",
    });
    if (res.ok) onDelete(template.id);
  }

  return (
    <div className="space-y-2 rounded-md border border-neutral-300 p-3 dark:border-neutral-700">
      <div className="flex items-start justify-between gap-2">
        {editing ? (
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        ) : (
          <div className="text-sm font-medium">{template.title}</div>
        )}
        <select
          value={cat}
          onChange={(e) => changeCategory(e.target.value)}
          disabled={busy}
          className="shrink-0 rounded border border-neutral-300 px-1 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-900"
        >
          {TEMPLATE_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div className="text-xs">
        <GroupCombobox
          value={template.group}
          options={groups}
          onChange={(g) => put({ group: g })}
          disabled={busy}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {template.framework ? <Badge>{frameworkLabel(template.framework)}</Badge> : null}
        {template.blockType ? <Badge>{blockLabel(template.blockType)}</Badge> : null}
        {template.moduleSize ? <Badge>{moduleSizeLabel(template.moduleSize).replace(/ \(.*\)/, "")}</Badge> : null}
        {template.channel && template.channel !== "standalone" ? (
          <Badge>{channelLabel(template.channel)}</Badge>
        ) : null}
        {template.tier && template.tier !== "standalone" ? (
          <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[11px] text-violet-700 dark:bg-violet-900/60 dark:text-violet-200">
            {template.tier}
          </span>
        ) : null}
        {typeof template.confidence === "number" && template.confidence < 0.6 ? (
          <span
            title={(template.warnings ?? []).join(", ")}
            className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
          >
            ⚠ check structure
          </span>
        ) : null}
      </div>

      {editing ? (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          className="w-full rounded border border-neutral-300 px-2 py-1 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
        />
      ) : (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 text-xs dark:bg-neutral-900">
          {template.body}
        </pre>
      )}

      {!editing ? (
        <PlaceholderList body={template.body} placeholders={template.placeholders ?? []} />
      ) : null}

      {!editing ? (
        <ReframeControl workspaceId={workspaceId} template={template} onReframed={onUpdate} />
      ) : null}

      {!editing && template.tier !== "spoke" && onDeconstructed ? (
        <DeconstructControl
          workspaceId={workspaceId}
          template={template}
          onDeconstructed={onDeconstructed}
        />
      ) : null}

      <div className="flex items-center gap-3">
        {editing ? (
          <>
            <button
              onClick={save}
              disabled={busy}
              className="rounded-md border border-neutral-900 bg-neutral-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:border-white dark:bg-white dark:text-neutral-900"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setTitle(template.title);
                setBody(template.body);
              }}
              className="text-xs text-neutral-500"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="rounded-md border border-neutral-300 px-3 py-1 text-xs dark:border-neutral-700"
          >
            Edit
          </button>
        )}
        <button onClick={remove} className="text-xs text-red-600 dark:text-red-400">
          Delete
        </button>
        {err ? <span className="text-xs text-red-600 dark:text-red-400">Save failed</span> : null}
      </div>
    </div>
  );
}
