"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { JourneyBranch } from "@/lib/types/journey";
import { branchLabel, DEFAULT_BRANCH } from "@/lib/journey/conditions";

/**
 * Presentational React Flow nodes for the Journey Canvas. Trigger = entry,
 * Email = a drip send (editable in the inspector), Wait = a delay, Condition = a
 * switch that routes the recipient down the first matching branch (else Default).
 */

/** Bottom offset (px) of the first branch handle, then each row below it. */
const BRANCH_ROW_TOP = 44;
const BRANCH_ROW_H = 22;
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

export function ConditionNode({ data, selected }: NodeProps) {
  const branches = (data.branches as JourneyBranch[] | undefined) ?? [];
  // Each branch gets a right-side source handle on its own row, plus the
  // implicit Default (else) handle last. Row positions match the handle offsets.
  const rows: Array<{ id: string; label: string; isDefault?: boolean }> = [
    ...branches.map((b) => ({ id: b.id, label: branchLabel(b) })),
    { id: DEFAULT_BRANCH, label: "Default", isDefault: true },
  ];
  return (
    <div
      className={box(selected, "border-sky-500")}
      style={{ minHeight: BRANCH_ROW_TOP + rows.length * BRANCH_ROW_H }}
    >
      <Handle type="target" position={Position.Top} />
      <div className="text-xs font-semibold text-sky-700 dark:text-sky-400">
        ⤳ Switch
      </div>
      <div className="text-[10px] text-neutral-500">first match wins</div>
      {rows.map((r, i) => (
        <div
          key={r.id}
          className="relative flex items-center pr-2"
          style={{ height: BRANCH_ROW_H }}
        >
          <span
            className={`truncate text-[10px] ${
              r.isDefault
                ? "text-neutral-400"
                : "text-neutral-600 dark:text-neutral-400"
            }`}
          >
            {r.label}
          </span>
          <Handle
            id={r.id}
            type="source"
            position={Position.Right}
            style={{ top: BRANCH_ROW_TOP + i * BRANCH_ROW_H + BRANCH_ROW_H / 2 }}
          />
        </div>
      ))}
    </div>
  );
}
