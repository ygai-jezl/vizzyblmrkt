"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { JourneyBranch } from "@/lib/types/journey";
import { branchLabel, DEFAULT_BRANCH } from "@/lib/journey/conditions";

/**
 * Presentational React Flow nodes for the Journey Canvas. Trigger = entry,
 * Email = a drip send (editable in the inspector), Wait = a delay, Condition = a
 * switch that routes the recipient down the first matching branch (else Default).
 */
function box(selected: boolean | undefined, accent: string): string {
  return `w-44 rounded-md border bg-white p-2 shadow-sm dark:bg-neutral-900 ${
    selected ? accent : "border-neutral-300 dark:border-neutral-700"
  }`;
}

export function TriggerNode({ selected }: NodeProps) {
  return (
    <div className={box(selected, "border-green-500")}>
      <div className="text-xs font-semibold text-green-700 dark:text-green-400">
        ▶ Trigger
      </div>
      <div className="text-[11px] text-neutral-500">New verified signup</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export function EmailNode({ data, selected }: NodeProps) {
  const d = data as { subject?: string; agentMeta?: { source?: string } };
  return (
    <div className={box(selected, "border-violet-500")}>
      <Handle type="target" position={Position.Top} />
      <div className="text-xs font-semibold text-violet-700 dark:text-violet-300">
        ✉ Email
      </div>
      <div className="truncate text-[11px] text-neutral-600 dark:text-neutral-400">
        {d.subject || "Untitled email"}
      </div>
      {d.agentMeta?.source === "agent3" ? (
        <div className="text-[10px] text-violet-500">✨ Agent 3</div>
      ) : null}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export function WaitNode({ data, selected }: NodeProps) {
  const d = data as { waitHours?: number };
  return (
    <div className={box(selected, "border-amber-500")}>
      <Handle type="target" position={Position.Top} />
      <div className="text-xs font-semibold text-amber-700 dark:text-amber-400">
        ⏱ Wait
      </div>
      <div className="text-[11px] text-neutral-600 dark:text-neutral-400">
        {d.waitHours ?? 0}h
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

/** Title block height (px) and per-branch row height (px) — drive handle offsets. */
const COND_HEADER_H = 36;
const COND_ROW_H = 24;

export function ConditionNode({ data, selected }: NodeProps) {
  const branches = (data.branches as JourneyBranch[] | undefined) ?? [];
  // One right-side source handle per branch (vertically centred on its row),
  // plus the implicit Default (else) branch last. Handles are DIRECT children of
  // the node so React Flow can start a connection from them; the label rows are
  // pointer-events-none so they never intercept the connection drag.
  const rows: Array<{ id: string; label: string; isDefault?: boolean }> = [
    ...branches.map((b) => ({ id: b.id, label: branchLabel(b) })),
    { id: DEFAULT_BRANCH, label: "Default", isDefault: true },
  ];
  const height = COND_HEADER_H + rows.length * COND_ROW_H + 4;
  return (
    <div
      className={`relative w-48 rounded-md border bg-white shadow-sm dark:bg-neutral-900 ${
        selected ? "border-sky-500" : "border-neutral-300 dark:border-neutral-700"
      }`}
      style={{ height }}
    >
      <Handle type="target" position={Position.Top} />
      <div className="px-2 pt-1.5">
        <div className="text-xs font-semibold text-sky-700 dark:text-sky-400">
          ⤳ Switch
        </div>
        <div className="text-[10px] text-neutral-500">first match wins</div>
      </div>

      {/* Visual labels only — never capture pointer events. */}
      {rows.map((r, i) => (
        <div
          key={r.id}
          className="pointer-events-none absolute inset-x-0 flex items-center px-2"
          style={{ top: COND_HEADER_H + i * COND_ROW_H, height: COND_ROW_H }}
        >
          <span
            className={`truncate pr-2 text-[10px] ${
              r.isDefault
                ? "text-neutral-400"
                : "text-neutral-600 dark:text-neutral-400"
            }`}
          >
            {r.label}
          </span>
        </div>
      ))}

      {/* Interactive branch handles, on top, one per row. */}
      {rows.map((r, i) => (
        <Handle
          key={`h-${r.id}`}
          id={r.id}
          type="source"
          position={Position.Right}
          style={{
            top: COND_HEADER_H + i * COND_ROW_H + COND_ROW_H / 2,
            width: 9,
            height: 9,
          }}
        />
      ))}
    </div>
  );
}
