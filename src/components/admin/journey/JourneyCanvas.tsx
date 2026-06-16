"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Journey, JourneyStatus } from "@/lib/types/journey";
import { TriggerNode, EmailNode, WaitNode } from "./nodes";
import { NodeInspector } from "./NodeInspector";

/**
 * Journey Canvas — the visual sequence builder (React Flow). Drag connections
 * between Trigger → Email → Wait → Email …; click an email node to edit it in the
 * slide-out inspector (with Agent 3). Save persists the graph; Activate enqueues
 * the first step for every verified subscriber (see lib/email/delivery.ts).
 */
const STATUS_STYLES: Record<JourneyStatus, string> = {
  draft: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  active: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  paused: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
};

function seedGraph(j: Journey): { nodes: Node[]; edges: Edge[] } {
  if (j.graph.nodes.length > 0) {
    return {
      nodes: j.graph.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data as Record<string, unknown>,
      })),
      edges: j.graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
      })),
    };
  }
  // Empty journey → seed the entry trigger so there's something to connect from.
  return {
    nodes: [{ id: "trigger", type: "trigger", position: { x: 180, y: 24 }, data: {} }],
    edges: [],
  };
}

export function JourneyCanvas({
  campaignId,
  initial,
}: {
  campaignId: string;
  initial: Journey;
}) {
  const router = useRouter();
  const seeded = useMemo(() => seedGraph(initial), [initial]);
  const [nodes, setNodes, onNodesChange] = useNodesState(seeded.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(seeded.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<JourneyStatus>(initial.status);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const nodeTypes = useMemo(
    () => ({ trigger: TriggerNode, email: EmailNode, wait: WaitNode }),
    [],
  );
  const onConnect = useCallback(
    (c: Connection) => setEdges((eds) => addEdge(c, eds)),
    [setEdges],
  );

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  function addNode(type: "email" | "wait") {
    const id = `${type}_${crypto.randomUUID()}`;
    const data: Record<string, unknown> =
      type === "email" ? { subject: "", body: "" } : { waitHours: 24 };
    setNodes((nds) => [
      ...nds,
      { id, type, position: { x: 180, y: 120 + nds.length * 90 }, data },
    ]);
    setSelectedId(id);
  }

  function updateNodeData(id: string, patch: Record<string, unknown>) {
    setNodes((nds) =>
      nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
    );
  }

  function deleteNode(id: string) {
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    if (selectedId === id) setSelectedId(null);
  }

  async function save(): Promise<boolean> {
    const graph = {
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type ?? "email",
        position: n.position,
        data: n.data,
      })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    };
    const res = await fetch(`/api/admin/campaigns/${campaignId}/journey`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graph }),
    });
    return res.ok;
  }

  async function onSave() {
    setBusy(true);
    setMsg(null);
    const ok = await save();
    setBusy(false);
    setMsg(ok ? "Saved." : "Save failed.");
  }

  async function setActive(action: "activate" | "pause") {
    setBusy(true);
    setMsg(null);
    const saved = await save(); // run the latest graph
    if (!saved) {
      setBusy(false);
      setMsg("Save failed — not activated.");
      return;
    }
    const res = await fetch(
      `/api/admin/campaigns/${campaignId}/journey/activate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      },
    );
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setStatus(data.status as JourneyStatus);
      setMsg(
        action === "activate"
          ? `Activated — ${data.enqueued ?? 0} recipient(s) enqueued.`
          : "Paused.",
      );
      router.refresh();
    } else {
      setMsg("Action failed.");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => addNode("email")}
          className="rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          ✉ Add email
        </button>
        <button
          type="button"
          onClick={() => addNode("wait")}
          className="rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          ⏱ Add wait
        </button>
        <span className="mx-1 h-5 w-px bg-neutral-200 dark:bg-neutral-800" />
        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className="rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Save
        </button>
        {status === "active" ? (
          <button
            type="button"
            onClick={() => setActive("pause")}
            disabled={busy}
            className="rounded-md border border-amber-300 px-3 py-1 text-sm text-amber-800 hover:bg-amber-50 disabled:opacity-60 dark:border-amber-900 dark:text-amber-300"
          >
            Pause
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setActive("activate")}
            disabled={busy}
            className="rounded-md bg-neutral-900 px-3 py-1 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
          >
            Activate
          </button>
        )}
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
        >
          {status}
        </span>
        {msg ? (
          <span className="text-xs text-neutral-500">{msg}</span>
        ) : null}
      </div>

      <div className="h-[600px] rounded-md border border-neutral-200 dark:border-neutral-800">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) => setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>

      {selected ? (
        <NodeInspector
          node={selected}
          campaignId={campaignId}
          onUpdate={updateNodeData}
          onDelete={deleteNode}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}
