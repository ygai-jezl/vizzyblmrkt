"use client";

import { useRef, useState } from "react";
import { CHANNELS, channelLabel, formatLabel } from "@/lib/content/channels";
import { CORE_ANGLES, frameworkLabel } from "@/lib/content/frameworks";
import { EMAIL_FRAMEWORKS } from "@/lib/content/emailFrameworks";
import type { ContentNode } from "@/lib/types/contentPlan";
import {
  SOCIAL_ASPECTS,
  SOCIAL_IMAGE_STYLES,
  DEFAULT_SOCIAL_IMAGE_STYLE,
  socialImageStyle,
  defaultAspectForChannel,
  isSocialImageChannel,
  isSocialImageUiEnabled,
  type SocialAspect,
  type SocialImageStyle,
} from "@/lib/content/create/socialImage";
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
  workspaceId,
  planId,
  templates,
  busy,
  briefBusy,
  onUpdate,
  onGenerate,
  onSuggestBrief,
  onApprove,
  onDelete,
  onClose,
  onOpenLayout,
  onOpenPreview,
}: {
  node: ContentNode;
  workspaceId: string;
  planId: string;
  templates: TemplateOption[];
  busy: boolean;
  /** The brief is being auto-written from the node's connections. */
  briefBusy?: boolean;
  onUpdate: (patch: Partial<ContentNode>) => void;
  onGenerate: () => void;
  /** Spoke/promo nodes — (re)write the brief from what the node is connected to. */
  onSuggestBrief?: () => void;
  onApprove: () => void;
  onDelete: () => void;
  onClose: () => void;
  /** Email nodes — open the visual layout editor (mounted at the canvas level). */
  onOpenLayout?: () => void;
  /** Content nodes — open the channel-native WYSIWYG preview (feed / opened). */
  onOpenPreview?: () => void;
}) {
  const tokenEntries = Object.entries(node.placeholderValues ?? {});
  // Templates for this channel first (the relevant ones), then the rest.
  const onChannel = templates.filter((t) => t.channel === node.channel);
  const others = templates.filter((t) => t.channel !== node.channel);
  const isEmail = node.type === "email";
  const isStructural =
    node.type === "trigger" || node.type === "wait" || node.type === "condition";
  // Only spokes/promos atomize upstream content — the hub is the root, so it can't be
  // briefed from connections (matches the API guard).
  const isBriefable =
    node.type === "spoke" || node.type === "promo_pre" || node.type === "promo_post";

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

      {/* Brief is the AI's generation instruction — auto-written when the node is connected
          (from its upstream context up to the hub), editable to refine, and re-suggestable
          on demand. The canvas persists it before generating. */}
      <div className="mb-4">
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor="node-brief"
            className="block text-xs font-medium text-neutral-600 dark:text-neutral-300"
          >
            Brief
          </label>
          {isBriefable && onSuggestBrief ? (
            <button
              type="button"
              onClick={onSuggestBrief}
              disabled={briefBusy || busy}
              title="Write a brief from the nodes this is connected to"
              className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              {briefBusy ? "Writing…" : "✨ Suggest brief"}
            </button>
          ) : null}
        </div>
        <textarea
          id="node-brief"
          value={node.brief ?? ""}
          onChange={(e) => onUpdate({ brief: e.target.value })}
          rows={4}
          maxLength={2000}
          disabled={briefBusy}
          placeholder={
            briefBusy
              ? "Generating brief from connections…"
              : "The AI's generation instruction for this node — connect it to another node to auto-write one, or refine it here."
          }
          className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-xs leading-relaxed disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>

      {/* Social post image — on-brand ✨ generation for linkedin/x/instagram nodes. */}
      {!isEmail && isSocialImageChannel(node.channel) && isSocialImageUiEnabled() ? (
        <SocialImageControls
          key={node.id}
          node={node}
          workspaceId={workspaceId}
          planId={planId}
          onUpdate={onUpdate}
        />
      ) : null}

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
        {onOpenPreview ? (
          <button
            type="button"
            onClick={onOpenPreview}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            👁 Preview
          </button>
        ) : null}
        <button
          type="button"
          onClick={onGenerate}
          disabled={busy || briefBusy}
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

/**
 * ✨ On-brand image generation for a social post node (linkedin/x/instagram). Local
 * brief/aspect/style state; POSTs the flag-gated post-image route, then applies the
 * returned workspace-asset filename via onUpdate (persisted by the canvas Save). Keyed
 * by node id at the call site so state resets when a different node is selected.
 */
function SocialImageControls({
  node,
  workspaceId,
  planId,
  onUpdate,
}: {
  node: ContentNode;
  workspaceId: string;
  planId: string;
  onUpdate: (patch: Partial<ContentNode>) => void;
}) {
  const [brief, setBrief] = useState("");
  const [aspect, setAspect] = useState<SocialAspect>(
    node.imageAspect ?? defaultAspectForChannel(node.channel),
  );
  const [style, setStyle] = useState<SocialImageStyle>(DEFAULT_SOCIAL_IMAGE_STYLE);
  const [busy, setBusy] = useState<null | "generate" | "upload">(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const hasImage = Boolean(node.imageAssetRef);
  const thumbUrl = node.imageAssetRef
    ? `/api/admin/workspace/${workspaceId}/asset/${node.imageAssetRef}`
    : null;

  async function generate() {
    if (!brief.trim() || busy) return;
    setBusy("generate");
    setErr(null);
    try {
      const res = await fetch(
        `/api/admin/workspace/${workspaceId}/content-plans/${planId}/nodes/${node.id}/post-image`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brief: brief.trim(), aspect, style }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        imageAssetRef?: string;
        imagePrompt?: string | null;
        message?: string;
      };
      if (res.ok && data.imageAssetRef) {
        onUpdate({
          imageAssetRef: data.imageAssetRef,
          imageAspect: aspect,
          imagePrompt: data.imagePrompt ?? null,
        });
      } else {
        setErr(data.message ?? "Couldn't generate — try again.");
      }
    } catch {
      setErr("Couldn't generate — try again.");
    } finally {
      setBusy(null);
    }
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-picked after a failure
    if (!file || busy) return;
    setBusy("upload");
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(
        `/api/admin/workspace/${workspaceId}/content-plans/${planId}/nodes/${node.id}/post-image/upload`,
        { method: "POST", body: fd },
      );
      const data = (await res.json().catch(() => ({}))) as { imageAssetRef?: string; message?: string };
      if (res.ok && data.imageAssetRef) {
        // Uploaded image → no AI aspect/prompt metadata.
        onUpdate({ imageAssetRef: data.imageAssetRef, imageAspect: null, imagePrompt: null });
      } else {
        setErr(data.message ?? "Couldn't upload — try again.");
      }
    } catch {
      setErr("Couldn't upload — try again.");
    } finally {
      setBusy(null);
    }
  }

  const CHIP = "cursor-pointer rounded border px-2 py-0.5 text-[11px] capitalize";
  const ON = "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900";
  const OFF = "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

  return (
    <div className="mb-4 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="mb-2 text-xs font-medium text-neutral-600 dark:text-neutral-300">✨ Post image</div>
      {thumbUrl ? (
        <div className="mb-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbUrl}
            alt="Post image"
            className="max-h-48 rounded border border-neutral-200 object-contain dark:border-neutral-800"
          />
        </div>
      ) : null}
      <textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        rows={2}
        maxLength={1000}
        placeholder="Describe the image (on-brand, no text in the image)…"
        className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-900"
      />
      <div className="mt-2 flex items-center gap-1">
        <span className="text-[10px] uppercase tracking-wide text-neutral-400">Aspect</span>
        {SOCIAL_ASPECTS.map((a) => (
          <button key={a} type="button" onClick={() => setAspect(a)} className={`${CHIP} ${aspect === a ? ON : OFF}`}>
            {a}
          </button>
        ))}
      </div>
      <div className="mt-2">
        <label className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-neutral-400">
          Style
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value as SocialImageStyle)}
            className="rounded-md border border-neutral-300 px-2 py-1 text-xs normal-case text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
          >
            {SOCIAL_IMAGE_STYLES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <p className="mt-1 text-[10px] text-neutral-400">{socialImageStyle(style).hint}</p>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={generate}
          disabled={busy !== null || !brief.trim()}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {busy === "generate" ? "Generating…" : hasImage ? "Regenerate" : "✨ Generate image"}
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy !== null}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          {busy === "upload" ? "Uploading…" : "⬆ Upload"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={upload}
          className="hidden"
        />
        {hasImage ? (
          <button
            type="button"
            onClick={() => onUpdate({ imageAssetRef: null, imageAspect: null, imagePrompt: null })}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Remove
          </button>
        ) : null}
        {err ? <span className="text-xs text-red-600">{err}</span> : null}
      </div>
      <p className="mt-1.5 text-[10px] text-neutral-400">
        Generate an on-brand image (Brand Kit + this post&apos;s copy) or upload your own
        (PNG / JPG / WebP). Save the canvas to keep it.
      </p>
    </div>
  );
}
