"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

/**
 * Presentational React Flow nodes for the Journey Canvas. Trigger = entry,
 * Email = a drip send (editable in the inspector), Wait = a delay.
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
