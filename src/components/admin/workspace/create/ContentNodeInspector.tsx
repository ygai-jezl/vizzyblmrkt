"use client";

import { channelLabel, formatLabel } from "@/lib/content/channels";
import type { ContentNode } from "@/lib/types/contentPlan";

/**
 * Slide-out inspector for the selected Create node (like the Journey NodeInspector).
 * Shows the brief, the editable final copy, the dynamic token values, warnings, and
 * Regenerate / Approve actions. Edits flow back to the canvas via onUpdate; the graph
 * is persisted from the toolbar Save.
 */
export function ContentNodeInspector({
  node,
  busy,
  onUpdate,
  onGenerate,
  onApprove,
  onDelete,
  onClose,
}: {
  node: ContentNode;
  busy: boolean;
  onUpdate: (patch: Partial<ContentNode>) => void;
  onGenerate: () => void;
  onApprove: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const tokenEntries = Object.entries(node.placeholderValues ?? {});

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-[640px] overflow-y-auto border-l border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">{node.role}</h3>
          <p className="text-xs text-neutral-500">
            {channelLabel(node.channel)}
            {node.format ? ` · ${formatLabel(node.format)}` : ""} · {node.status}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-900"
            aria-label="Close inspector"
          >
            ✕
          </button>
        </div>
      </div>

      {node.brief ? (
        <div className="mb-4 rounded-md bg-neutral-50 p-3 text-xs text-neutral-600 dark:bg-neutral-900/40 dark:text-neutral-400">
          <span className="font-medium text-neutral-500">Brief:</span> {node.brief}
        </div>
      ) : null}

      {node.warnings.length ? (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50/60 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          ⚠ {node.warnings.join(", ")}
        </div>
      ) : null}

      <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
        Final copy
        <textarea
          value={node.body}
          onChange={(e) => onUpdate({ body: e.target.value })}
          rows={16}
          placeholder={busy ? "Generating…" : "Generate to draft this node, or write it here."}
          className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 font-mono text-xs leading-relaxed dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>

      {tokenEntries.length ? (
        <div className="mt-4">
          <div className="text-xs font-medium text-neutral-600 dark:text-neutral-300">Dynamic values</div>
          <ul className="mt-1 space-y-1 text-xs text-neutral-500">
            {tokenEntries.map(([k, v]) => (
              <li key={k} className="flex gap-2">
                <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">{`{{${k}}}`}</code>
                <span className="truncate">{v}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5 flex items-center gap-2">
        <button
          type="button"
          onClick={onGenerate}
          disabled={busy}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          {busy ? "Generating…" : node.body ? "Regenerate" : "Generate"}
        </button>
        <button
          type="button"
          onClick={onApprove}
          disabled={busy || !node.body}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {node.status === "approved" ? "Approved ✓" : "Approve"}
        </button>
      </div>
    </div>
  );
}
