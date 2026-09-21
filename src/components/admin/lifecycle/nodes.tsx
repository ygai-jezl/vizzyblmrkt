"use client";

import { createContext, useContext } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { ContentPool, LifecycleNodeData } from "@/lib/types/lifecycle";
import { conditionText, poolLabel, waitSummary, type FieldOption } from "./model";

/**
 * React Flow nodes for the lifecycle canvas, styled like the waitlist Journey
 * Canvas. Node `data` is the stored LifecycleNodeData; what a node shows that
 * isn't on it (pool names, the trigger event, field labels) comes from context.
 */

export interface CanvasInfo {
  pools: ContentPool[];
  triggerEvent: string;
  fields: FieldOption[];
  /** Node ids with a validation issue (outlined red). */
  flagged: Set<string>;
}

export const CanvasInfoContext = createContext<CanvasInfo>({
  pools: [],
  triggerEvent: "user.signed_up",
  fields: [],
  flagged: new Set(),
});

function box(selected: boolean | undefined, accent: string, flagged: boolean): string {
  const border = selected ? accent : flagged ? "border-red-400 dark:border-red-700" : "border-neutral-300 dark:border-neutral-700";
  return `w-48 rounded-md border bg-white p-2 shadow-sm dark:bg-neutral-900 ${border}`;
}

export function TriggerNode({ id, selected }: NodeProps) {
  const info = useContext(CanvasInfoContext);
  return (
    <div className={box(selected, "border-green-500", info.flagged.has(id))}>
      <div className="text-xs font-semibold text-green-700 dark:text-green-400">▶ Trigger</div>
      <div className="truncate font-mono text-[11px] text-neutral-500">{info.triggerEvent}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export function EmailNode({ id, data, selected }: NodeProps) {
  const info = useContext(CanvasInfoContext);
  const d = data as LifecycleNodeData;
  const pool = info.pools.find((p) => p.id === d.poolId);
  return (
    <div className={box(selected, "border-violet-500", info.flagged.has(id))}>
      <Handle type="target" position={Position.Top} />
      <div className="text-xs font-semibold text-violet-700 dark:text-violet-300">✉ {d.label || "Email"}</div>
      <div className="truncate text-[11px] text-neutral-600 dark:text-neutral-400">{poolLabel(info.pools, d.poolId)}</div>
      {pool ? (
        <div className="text-[10px] text-neutral-400">
          {pool.items.length === 1 ? "1 email" : `next of ${pool.items.length} emails`}
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export function WaitNode({ id, data, selected }: NodeProps) {
  const info = useContext(CanvasInfoContext);
  const d = data as LifecycleNodeData;
  return (
    <div className={box(selected, "border-amber-500", info.flagged.has(id))}>
      <Handle type="target" position={Position.Top} />
      <div className="text-xs font-semibold text-amber-700 dark:text-amber-400">⏱ {d.label || "Wait"}</div>
      <div className="text-[11px] text-neutral-600 dark:text-neutral-400">{waitSummary(d.wait)}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export function ExitNode({ id, data, selected }: NodeProps) {
  const info = useContext(CanvasInfoContext);
  const d = data as LifecycleNodeData;
  return (
    <div className={box(selected, "border-rose-500", info.flagged.has(id))}>
      <Handle type="target" position={Position.Top} />
      <div className="text-xs font-semibold text-rose-700 dark:text-rose-400">⇥ {d.label || "Exit"}</div>
      <div className="text-[11px] text-neutral-500">End of journey</div>
    </div>
  );
}

const COND_HEADER_H = 36;
const COND_ROW_H = 24;

/** One right-side handle per branch (first match wins), plus Default last. */
export function ConditionNode({ id, data, selected }: NodeProps) {
  const info = useContext(CanvasInfoContext);
  const d = data as LifecycleNodeData;
  const rows = [
    ...(d.branches ?? []).map((b) => ({
      id: b.id,
      label: b.label || (b.conditions[0] ? conditionText(b.conditions[0], info.fields) : b.id),
      isDefault: false,
    })),
    { id: "default", label: "Default (everyone else)", isDefault: true },
  ];
  const border = selected
    ? "border-sky-500"
    : info.flagged.has(id)
      ? "border-red-400 dark:border-red-700"
      : "border-neutral-300 dark:border-neutral-700";
  return (
    <div
      className={`relative w-56 rounded-md border bg-white shadow-sm dark:bg-neutral-900 ${border}`}
      style={{ height: COND_HEADER_H + rows.length * COND_ROW_H + 4 }}
    >
      <Handle type="target" position={Position.Top} />
      <div className="px-2 pt-1.5">
        <div className="truncate text-xs font-semibold text-sky-700 dark:text-sky-400">⤳ {d.label || "Split"}</div>
        <div className="text-[10px] text-neutral-500">first match wins</div>
      </div>
      {rows.map((r, i) => (
        <div
          key={r.id}
          className="pointer-events-none absolute inset-x-0 flex items-center px-2"
          style={{ top: COND_HEADER_H + i * COND_ROW_H, height: COND_ROW_H }}
        >
          <span className={`truncate pr-3 text-[10px] ${r.isDefault ? "text-neutral-400" : "text-neutral-600 dark:text-neutral-400"}`}>
            {r.label}
          </span>
        </div>
      ))}
      {rows.map((r, i) => (
        <Handle
          key={`h-${r.id}`}
          id={r.id}
          type="source"
          position={Position.Right}
          style={{ top: COND_HEADER_H + i * COND_ROW_H + COND_ROW_H / 2, width: 9, height: 9 }}
        />
      ))}
    </div>
  );
}

export const lifecycleNodeTypes = {
  trigger: TriggerNode,
  email: EmailNode,
  wait: WaitNode,
  condition: ConditionNode,
  exit: ExitNode,
};
