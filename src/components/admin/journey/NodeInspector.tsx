"use client";

import type { Node } from "@xyflow/react";
import { EmailComposer, type EmailComposerValue } from "@/components/admin/email/EmailComposer";

/**
 * Slide-out inspector for the selected Journey node. Email nodes host the shared
 * <EmailComposer/> (Agent 3 + merge vars); wait nodes expose a delay input.
 * Edits flow straight back to the canvas via onUpdate (the graph is saved
 * separately from the canvas toolbar).
 */
export function NodeInspector({
  node,
  campaignId,
  onUpdate,
  onDelete,
  onClose,
}: {
  node: Node;
  campaignId: string;
  onUpdate: (id: string, data: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const data = node.data as Record<string, unknown>;

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-[760px] overflow-y-auto border-l border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold capitalize">{node.type} step</h3>
        <div className="flex items-center gap-2">
          {node.type !== "trigger" ? (
            <button
              type="button"
              onClick={() => onDelete(node.id)}
              className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400"
            >
              Delete
            </button>
          ) : null}
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

      {node.type === "email" ? (
        <EmailComposer
          mode="journey-node"
          campaignId={campaignId}
          value={{
            subject: String(data.subject ?? ""),
            body: String(data.body ?? ""),
            heroImageUrl: (data.heroImageUrl as string | null) ?? null,
            agentMeta: data.agentMeta as EmailComposerValue["agentMeta"],
          }}
          onChange={(v) =>
            onUpdate(node.id, {
              subject: v.subject,
              body: v.body,
              heroImageUrl: v.heroImageUrl ?? null,
              agentMeta: v.agentMeta,
            })
          }
        />
      ) : null}

      {node.type === "wait" ? (
        <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
          Wait duration (hours)
          <input
            type="number"
            min={0}
            value={Number(data.waitHours ?? 0)}
            onChange={(e) =>
              onUpdate(node.id, { waitHours: Math.max(0, Number(e.target.value) || 0) })
            }
            className="mt-1 w-32 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
      ) : null}

      {node.type === "trigger" ? (
        <p className="text-sm text-neutral-500">
          The journey starts here when a signup becomes verified. Connect this to
          the first email or wait step.
        </p>
      ) : null}
    </div>
  );
}
