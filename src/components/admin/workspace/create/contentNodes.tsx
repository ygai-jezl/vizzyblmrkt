"use client";

import Link from "next/link";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { channelLabel } from "@/lib/content/channels";
import { emailFrameworkLabel } from "@/lib/content/emailFrameworks";
import type { ContentNode, ContentNodeStatus, ContentDistributionStatus } from "@/lib/types/contentPlan";

/**
 * Presentational React Flow nodes for the Create canvas. Each shows its role +
 * channel, a status chip, a per-node Generate button, and a copy preview. The
 * authoritative ContentNode + handlers ride on `data` (cn / onGenerate / busy);
 * ContentCanvas owns the source-of-truth state and persistence.
 */
export interface ContentNodeData {
  cn: ContentNode;
  busy?: boolean;
  /** Its brief is being auto-written from the nodes it's connected to. */
  briefBusy?: boolean;
  onGenerate?: (id: string) => void;
  [key: string]: unknown;
}

const STATUS_CHIP: Record<ContentNodeStatus, string> = {
  empty: "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  generating: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300 animate-pulse",
  generated: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  error: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  approved: "bg-emerald-600 text-white",
};

// Distribution lifecycle chip (overrides the generation status once a node is scheduled).
// `posted` shares approved's emerald; `failed` uses a stronger solid red than the generation
// `error` chip so a publish failure reads distinctly from a generation error.
const DIST_CHIP: Record<ContentDistributionStatus, string> = {
  scheduled: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  posting: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300 animate-pulse",
  posted: "bg-emerald-600 text-white",
  failed: "bg-red-600 text-white",
};
const DIST_LABEL: Record<ContentDistributionStatus, string> = {
  scheduled: "scheduled",
  posting: "posting…",
  posted: "posted",
  failed: "failed",
};

/**
 * The status chip a node shows. Precedence: an in-flight generate wins (rare, and it
 * un-approves anyway), else the distribution lifecycle once scheduled, else the generation
 * status. Shared by NodeShell + EmailNode so both stay in lockstep.
 */
function statusChip(cn: ContentNode, busy: boolean): { cls: string; label: string } {
  if (busy) return { cls: STATUS_CHIP.generating, label: "generating" };
  if (cn.distributionStatus)
    return { cls: DIST_CHIP[cn.distributionStatus], label: DIST_LABEL[cn.distributionStatus] };
  return { cls: STATUS_CHIP[cn.status], label: cn.status };
}

function preview(body: string): string {
  const t = body.replace(/\s+/g, " ").trim();
  return t.length > 140 ? `${t.slice(0, 140)}…` : t;
}

function NodeShell({
  data,
  accent,
  width,
  icon,
  hasTarget,
  hasSource,
}: {
  data: ContentNodeData;
  accent: string;
  width: string;
  icon: string;
  hasTarget: boolean;
  hasSource: boolean;
}) {
  const cn = data.cn;
  const busy = data.busy || cn.status === "generating";
  const chip = statusChip(cn, busy);
  return (
    <div className={`${width} rounded-md border bg-white p-2.5 shadow-sm dark:bg-neutral-900 ${accent}`}>
      {hasTarget ? <Handle type="target" position={Position.Top} /> : null}
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-xs font-semibold">
          {icon} {cn.role}
        </div>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${chip.cls}`}>
          {chip.label}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1 text-[10px] text-neutral-500">
        <span>{channelLabel(cn.channel)}</span>
        {cn.templateId ? <span className="text-violet-500" title="Uses a saved template">· 📄</span> : null}
      </div>
      {cn.body ? (
        <p className="mt-1.5 text-[11px] leading-snug text-neutral-600 dark:text-neutral-400">
          {preview(cn.body)}
        </p>
      ) : data.briefBusy ? (
        <p className="mt-1.5 animate-pulse text-[11px] italic leading-snug text-sky-500">
          ✨ writing brief…
        </p>
      ) : cn.brief ? (
        <p className="mt-1.5 line-clamp-2 text-[11px] italic leading-snug text-neutral-400">
          {cn.brief}
        </p>
      ) : null}
      {cn.warnings.length ? (
        <div className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">⚠ {cn.warnings.join(", ")}</div>
      ) : null}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          data.onGenerate?.(cn.id);
        }}
        disabled={busy || data.briefBusy}
        className="mt-2 w-full rounded border border-neutral-300 px-2 py-1 text-[11px] hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        {busy ? "…" : cn.body ? "Regenerate" : "Generate"}
      </button>
      {hasSource ? <Handle type="source" position={Position.Bottom} /> : null}
    </div>
  );
}

/** An eBook hub — its content IS the authored book; opens the studio instead of Generate. */
function EbookHubNode({ data, selected }: { data: ContentNodeData; selected: boolean }) {
  const cn = data.cn;
  const ebook = cn.ebook ?? null;
  const workspaceId = typeof data.workspaceId === "string" ? data.workspaceId : "";
  const planId = typeof data.planId === "string" ? data.planId : "";
  const chapters = ebook?.chapters.length ?? 0;
  return (
    <div
      className={`w-56 rounded-md border bg-white p-2.5 shadow-sm dark:bg-neutral-900 ${
        selected ? "border-violet-500" : "border-violet-300 dark:border-violet-800"
      }`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-xs font-semibold">📖 {ebook?.title ?? cn.role}</div>
        <span className="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
          eBook
        </span>
      </div>
      <div className="mt-0.5 text-[10px] text-neutral-500">
        {chapters} chapter{chapters === 1 ? "" : "s"}
      </div>
      {ebook?.subtitle ? (
        <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-neutral-600 dark:text-neutral-400">
          {ebook.subtitle}
        </p>
      ) : null}
      {workspaceId && planId ? (
        <Link
          href={`/admin/workspace/${workspaceId}/create/${planId}/ebook`}
          onClick={(e) => e.stopPropagation()}
          className="nodrag mt-2 block w-full rounded border border-neutral-300 px-2 py-1 text-center text-[11px] hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          Open eBook
        </Link>
      ) : null}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export function HubNode({ data, selected }: NodeProps) {
  const d = data as ContentNodeData;
  if (d.cn.channel === "ebook") return <EbookHubNode data={d} selected={!!selected} />;
  return (
    <NodeShell
      data={d}
      icon="◆"
      width="w-56"
      accent={selected ? "border-violet-500" : "border-violet-300 dark:border-violet-800"}
      hasTarget
      hasSource
    />
  );
}

export function PromoNode({ data, selected }: NodeProps) {
  return (
    <NodeShell
      data={data as ContentNodeData}
      icon="✦"
      width="w-48"
      accent={selected ? "border-amber-500" : "border-amber-300 dark:border-amber-800"}
      hasTarget
      hasSource
    />
  );
}

export function SpokeNode({ data, selected }: NodeProps) {
  return (
    <NodeShell
      data={data as ContentNodeData}
      icon="→"
      width="w-48"
      accent={selected ? "border-sky-500" : "border-sky-300 dark:border-sky-800"}
      hasTarget
      hasSource
    />
  );
}

// ── Email-sequence nodes ─────────────────────────────────────────────────────

/** The sequence entry point — no copy, source-only. */
export function TriggerNode({ data }: NodeProps) {
  const cn = (data as ContentNodeData).cn;
  return (
    <div className="rounded-full border border-emerald-400 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 shadow-sm dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
      ▶ {cn.role}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

/** A delay between steps — structural, no generation. */
export function WaitNode({ data }: NodeProps) {
  const cn = (data as ContentNodeData).cn;
  const w = cn.waitConfig;
  const label = w ? `Wait ${w.amount} ${w.unit}` : cn.role;
  return (
    <div className="rounded-full border border-neutral-300 bg-neutral-50 px-3 py-1 text-[11px] text-neutral-600 shadow-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
      <Handle type="target" position={Position.Top} />
      ⏱ {label}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

/** A branch split (visual only) — one target, both branches leave the bottom handle. */
export function ConditionNode({ data, selected }: NodeProps) {
  const cn = (data as ContentNodeData).cn;
  const c = cn.conditionConfig;
  return (
    <div
      className={`w-44 rounded-md border bg-amber-50 p-2 text-center shadow-sm dark:bg-amber-950/30 ${
        selected ? "border-amber-500" : "border-amber-300 dark:border-amber-800"
      }`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="text-xs font-semibold text-amber-800 dark:text-amber-300">◇ {c?.label ?? cn.role}</div>
      {c ? (
        <div className="mt-0.5 text-[10px] text-neutral-500">
          {c.yesLabel} / {c.noLabel}
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

/** A single email in the sequence — LLM-filled (subject + preview + variants + body). */
export function EmailNode({ data, selected }: NodeProps) {
  const d = data as ContentNodeData;
  const cn = d.cn;
  const busy = d.busy || cn.status === "generating";
  const chip = statusChip(cn, busy);
  return (
    <div
      className={`w-56 rounded-md border bg-white p-2.5 shadow-sm dark:bg-neutral-900 ${
        selected ? "border-indigo-500" : "border-indigo-300 dark:border-indigo-800"
      }`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-xs font-semibold">✉️ {cn.role}</div>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${chip.cls}`}>
          {chip.label}
        </span>
      </div>
      {cn.framework ? (
        <div className="mt-0.5 text-[10px] text-neutral-500">{emailFrameworkLabel(cn.framework)}</div>
      ) : null}
      {cn.subject ? (
        <p className="mt-1.5 text-[11px] font-medium leading-snug">{cn.subject}</p>
      ) : null}
      {cn.body ? (
        <p className="mt-1 text-[11px] leading-snug text-neutral-600 dark:text-neutral-400">{preview(cn.body)}</p>
      ) : cn.brief ? (
        <p className="mt-1.5 line-clamp-2 text-[11px] italic leading-snug text-neutral-400">{cn.brief}</p>
      ) : null}
      {cn.warnings.length ? (
        <div className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">⚠ {cn.warnings.join(", ")}</div>
      ) : null}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          d.onGenerate?.(cn.id);
        }}
        disabled={busy}
        className="mt-2 w-full rounded border border-neutral-300 px-2 py-1 text-[11px] hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        {busy ? "…" : cn.body ? "Regenerate" : "Generate email"}
      </button>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
