"use client";

import { useRef } from "react";
import { CreativeDirectorPanel, type CopyVariant } from "./CreativeDirectorPanel";
import { AgentPresenceToken } from "./AgentPresenceToken";
import { MergeVariableMenu } from "./MergeVariableMenu";

/**
 * Shared email composer: a live editor on the left, the Agent 3 Creative
 * Director side-panel on the right. Reused by the Broadcast wizard and the
 * Journey node inspector. Fully controlled — the parent owns `value`.
 */
export type ComposerMode = "broadcast" | "journey-node";

export interface EmailComposerValue {
  subject: string;
  body: string;
  heroImageUrl?: string | null;
  agentMeta?: { source: "agent3" | "human"; variantId?: string; at?: string };
}

export interface EmailComposerProps {
  mode: ComposerMode;
  campaignId: string;
  value: EmailComposerValue;
  onChange: (next: EmailComposerValue) => void;
  performanceHint?: string;
}

export function EmailComposer({
  campaignId,
  value,
  onChange,
  performanceHint,
}: EmailComposerProps) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  function insertAtCursor(token: string) {
    const el = bodyRef.current;
    if (!el) {
      onChange({ ...value, body: `${value.body}${token}` });
      return;
    }
    const start = el.selectionStart ?? value.body.length;
    const end = el.selectionEnd ?? value.body.length;
    const next = value.body.slice(0, start) + token + value.body.slice(end);
    onChange({ ...value, body: next });
    // Restore caret just after the inserted token.
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + token.length;
    });
  }

  function applyVariant(v: CopyVariant) {
    onChange({
      ...value,
      subject: v.subject,
      body: v.body,
      agentMeta: { source: "agent3", at: new Date().toISOString() },
    });
  }

  function applyImage(url: string) {
    onChange({
      ...value,
      heroImageUrl: url,
      agentMeta: { source: "agent3", at: new Date().toISOString() },
    });
  }

  function edited(patch: Partial<EmailComposerValue>) {
    // A manual edit flips provenance back to human.
    onChange({ ...value, ...patch, agentMeta: { source: "human" } });
  }

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_320px]">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
            Subject
          </label>
          <AgentPresenceToken meta={value.agentMeta} />
        </div>
        <input
          value={value.subject}
          onChange={(e) => edited({ subject: e.target.value })}
          placeholder="Subject line"
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />

        {value.heroImageUrl ? (
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={value.heroImageUrl}
              alt="Email hero"
              className="max-h-44 w-full rounded-md object-cover"
            />
            <button
              type="button"
              onClick={() => edited({ heroImageUrl: null })}
              className="absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white"
            >
              Remove
            </button>
          </div>
        ) : null}

        <textarea
          ref={bodyRef}
          value={value.body}
          onChange={(e) => edited({ body: e.target.value })}
          rows={12}
          placeholder="Write your email… HTML and {{merge_vars}} are supported."
          className="w-full rounded-md border border-neutral-300 px-3 py-2 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <MergeVariableMenu onInsert={insertAtCursor} />
      </div>

      <CreativeDirectorPanel
        campaignId={campaignId}
        performanceHint={performanceHint}
        onApplyVariant={applyVariant}
        onApplyImage={applyImage}
      />
    </div>
  );
}
