"use client";

import { CHANNELS, channelLabel, formatLabel } from "@/lib/content/channels";
import { CORE_ANGLES, frameworkLabel } from "@/lib/content/frameworks";
import { EMAIL_FRAMEWORKS } from "@/lib/content/emailFrameworks";
import type { ContentNode } from "@/lib/types/contentPlan";
import type { TemplateOption } from "./types";

/**
 * Slide-out inspector for the selected Create node. Exposes the node's CONFIG
 * (channel + which saved template skeleton it fills — the Architect auto-selects
 * one, shown here and overridable), the brief, the editable final copy, the dynamic
 * token values, warnings, and Regenerate / Approve. Edits flow to the canvas via
 * onUpdate; the graph is persisted from the toolbar Save.
 */
const SELECT =
  "rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900";

export function ContentNodeInspector({
  node,
  templates,
  busy,
  onUpdate,
  onGenerate,
  onApprove,
  onDelete,
  onClose,
  onOpenLayout,
}: {
  node: ContentNode;
  templates: TemplateOption[];
  busy: boolean;
  onUpdate: (patch: Partial<ContentNode>) => void;
  onGenerate: () => void;
  onApprove: () => void;
  onDelete: () => void;
  onClose: () => void;
  /** Email nodes — open the visual layout editor (mounted at the canvas level). */
  onOpenLayout?: () => void;
}) {
  const tokenEntries = Object.entries(node.placeholderValues ?? {});
  // Templates for this channel first (the relevant ones), then the rest.
  const onChannel = templates.filter((t) => t.channel === node.channel);
  const others = templates.filter((t) => t.channel !== node.channel);
  const isEmail = node.type === "email";
  const isStructural =
    node.type === "trigger" || node.type === "wait" || node.type === "condition";

  // Structural sequence nodes (trigger / wait / condition) carry no copy — a compact
  // inspector that just edits their config.
  if (isStructural) {
    const w = node.waitConfig ?? { amount: 1, unit: "days" as const };
    const c = node.conditionConfig ?? { label: node.role, yesLabel: "Yes", noLabel: "No" };
    return (
      <div className="fixed inset-y-0 right-0 z-40 w-full max-w-[420px] overflow-y-auto border-l border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-800 dark:bg-neutral-950">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">{node.role}</h3>
            <p className="text-xs text-neutral-500">{node.type}</p>
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

        {node.type === "wait" ? (
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
              Amount
              <input
                type="number"
                min={1}
                value={w.amount}
                onChange={(e) =>
                  onUpdate({
                    waitConfig: { amount: Math.max(1, parseInt(e.target.value, 10) || 1), unit: w.unit },
                  })
                }
                className={`mt-1 w-full ${SELECT}`}
              />
            </label>
            <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
              Unit
              <select
                value={w.unit}
                onChange={(e) =>
                  onUpdate({ waitConfig: { amount: w.amount, unit: e.target.value as "hours" | "days" } })
                }
                className={`mt-1 w-full ${SELECT}`}
              >
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </label>
          </div>
        ) : null}

        {node.type === "condition" ? (
          <div className="space-y-3">
            <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
              Condition
              <input
                value={c.label}
                onChange={(e) => onUpdate({ conditionConfig: { ...c, label: e.target.value } })}
                className={`mt-1 w-full ${SELECT}`}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                Yes branch
                <input
                  value={c.yesLabel}
                  onChange={(e) => onUpdate({ conditionConfig: { ...c, yesLabel: e.target.value } })}
                  className={`mt-1 w-full ${SELECT}`}
                />
              </label>
              <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                No branch
                <input
                  value={c.noLabel}
                  onChange={(e) => onUpdate({ conditionConfig: { ...c, noLabel: e.target.value } })}
                  className={`mt-1 w-full ${SELECT}`}
                />
              </label>
            </div>
          </div>
        ) : null}

        {node.type === "trigger" ? (
          <p className="text-xs text-neutral-500">The sequence entry point — no configuration.</p>
        ) : null}
      </div>
    );
  }

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

      {/* Config: channel + template skeleton (content nodes only). */}
      {!isEmail ? (
        <div className="mb-4 grid grid-cols-2 gap-3">
          <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
            Channel
            <select
              value={node.channel}
              onChange={(e) => onUpdate({ channel: e.target.value, format: null, templateId: null })}
              className={`mt-1 w-full ${SELECT}`}
            >
              {CHANNELS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
            Template skeleton
            <select
              value={node.templateId ?? ""}
              onChange={(e) => onUpdate({ templateId: e.target.value || null })}
              className={`mt-1 w-full ${SELECT}`}
            >
              <option value="">AI-composed (no template)</option>
              {onChannel.length ? (
                <optgroup label={`${channelLabel(node.channel)} templates`}>
                  {onChannel.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {others.length ? (
                <optgroup label="Other templates">
                  {others.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title} ({t.channel ?? "—"})
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </label>
        </div>
      ) : null}

      {/* Email node — framework + subject + preview + A/B subject variants. */}
      {isEmail ? (
        <div className="mb-4 space-y-3">
          <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
            Copy framework
            <select
              value={node.framework ?? ""}
              onChange={(e) => onUpdate({ framework: e.target.value || null })}
              className={`mt-1 w-full ${SELECT}`}
            >
              <option value="">Default</option>
              {EMAIL_FRAMEWORKS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-1 gap-3">
            <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
              Subject
              <input
                value={node.subject ?? ""}
                onChange={(e) => onUpdate({ subject: e.target.value })}
                maxLength={200}
                placeholder="The email subject line"
                className={`mt-1 w-full ${SELECT}`}
              />
            </label>
            <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
              Preview text
              <input
                value={node.previewText ?? ""}
                onChange={(e) => onUpdate({ previewText: e.target.value })}
                maxLength={200}
                placeholder="Inbox preview / preheader"
                className={`mt-1 w-full ${SELECT}`}
              />
            </label>
          </div>
          {node.subjectVariants.length ? (
            <div>
              <div className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                Subject A/B variants
              </div>
              <ul className="mt-1 space-y-1">
                {node.subjectVariants.map((v, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs">
                    <span className="flex-1 truncate text-neutral-500">{v}</span>
                    <button
                      type="button"
                      onClick={() => onUpdate({ subject: v })}
                      className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                    >
                      Use
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Content ANGLE — only spokes carry one. Changing it + Regenerate re-drafts in the
          new angle (saveThenGenerate persists it before the server reads the node). */}
      {node.type === "spoke" ? (
        <label className="mb-4 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
          Angle
          <select
            value={node.framework ?? ""}
            onChange={(e) => onUpdate({ framework: e.target.value || null })}
            className={`mt-1 w-full ${SELECT}`}
          >
            <option value="">No angle (channel-only)</option>
            {CORE_ANGLES.map((id) => (
              <option key={id} value={id}>
                {frameworkLabel(id)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {/* Brief is the AI's generation instruction — editable so the user can refine it
          before (or between) Generate runs; the canvas persists it before generating. */}
      <label className="mb-4 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
        Brief
        <textarea
          value={node.brief ?? ""}
          onChange={(e) => onUpdate({ brief: e.target.value })}
          rows={4}
          maxLength={2000}
          placeholder="The AI's generation instruction for this node — refine it before generating."
          className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-xs leading-relaxed dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>

      {node.warnings.length ? (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50/60 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          ⚠ {node.warnings.join(", ")}
        </div>
      ) : null}

      {/* Email nodes: open the visual layout editor. When a layout exists it is the
          source of truth, so the raw "Final copy" below is read-only (edit via the editor). */}
      {isEmail ? (
        <button
          type="button"
          onClick={onOpenLayout}
          className="mb-4 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          🎨 Email Layout{node.layout ? "" : " — build a visual email"}
        </button>
      ) : null}

      <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
        Final copy{isEmail && node.layout ? " (rendered from layout — read-only)" : ""}
        <textarea
          value={node.body}
          onChange={(e) => onUpdate({ body: e.target.value })}
          readOnly={Boolean(isEmail && node.layout)}
          rows={16}
          placeholder={busy ? "Generating…" : "Generate to draft this node, or write it here."}
          className={`mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 font-mono text-xs leading-relaxed dark:border-neutral-700 dark:bg-neutral-900 ${
            isEmail && node.layout ? "opacity-60" : ""
          }`}
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
