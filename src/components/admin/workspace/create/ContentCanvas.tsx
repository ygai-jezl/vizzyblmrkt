"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ContentNode, ContentPlan, ContentNodeType } from "@/lib/types/contentPlan";
import { HubNode, PromoNode, SpokeNode, type ContentNodeData } from "./contentNodes";
import { ContentNodeInspector } from "./ContentNodeInspector";

/**
 * Create Canvas — the visual hub-and-spoke builder (React Flow), mirroring the
 * Journey canvas. The Architect seeds the graph; each node fills progressively via
 * the per-node generate route (hub first so spokes can atomize it). Drag to lay
 * out; Save persists the graph (positions + filled copy). Each node is Distribute-
 * shaped ({channel, body, scheduledAt}).
 */
const RF_TYPE: Record<ContentNodeType, "hub" | "promo" | "spoke"> = {
  hub: "hub",
  promo_pre: "promo",
  promo_post: "promo",
  spoke: "spoke",
};

const GEN_ORDER: Record<ContentNodeType, number> = {
  hub: 0,
  promo_pre: 1,
  promo_post: 2,
  spoke: 3,
};

function seedNodes(plan: ContentPlan): Node[] {
  return plan.graph.nodes.map((cn) => ({
    id: cn.id,
    type: RF_TYPE[cn.type],
    position: cn.position,
    data: { cn } as ContentNodeData,
  }));
}

function seedEdges(plan: ContentPlan): Edge[] {
  return plan.graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));
}

export function ContentCanvas({
  workspaceId,
  initial,
}: {
  workspaceId: string;
  initial: ContentPlan;
}) {
  const router = useRouter();
  const planId = initial.id;
  const seeded = useMemo(() => ({ nodes: seedNodes(initial), edges: seedEdges(initial) }), [initial]);
  const [nodes, setNodes, onNodesChange] = useNodesState(seeded.nodes);
  const [edges, , onEdgesChange] = useEdgesState(seeded.edges);
  const [name, setName] = useState(initial.name);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const nodeTypes = useMemo(() => ({ hub: HubNode, promo: PromoNode, spoke: SpokeNode }), []);

  const patchNode = useCallback(
    (id: string, patch: Partial<ContentNodeData>) =>
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n))),
    [setNodes],
  );

  const updateCn = useCallback(
    (id: string, patch: Partial<ContentNode>) =>
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, cn: { ...(n.data as ContentNodeData).cn, ...patch } } } : n,
        ),
      ),
    [setNodes],
  );

  const generateOne = useCallback(
    async (id: string): Promise<void> => {
      patchNode(id, { busy: true });
      try {
        const res = await fetch(
          `/api/admin/workspace/${workspaceId}/content-plans/${planId}/nodes/${id}/generate`,
          { method: "POST", headers: { "Content-Type": "application/json" } },
        );
        const data = (await res.json().catch(() => ({}))) as { node?: ContentNode };
        if (res.ok && data.node) {
          patchNode(id, { busy: false, cn: data.node });
        } else {
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      busy: false,
                      cn: { ...(n.data as ContentNodeData).cn, status: "error", warnings: ["request_failed"] },
                    },
                  }
                : n,
            ),
          );
        }
      } catch {
        patchNode(id, { busy: false });
      }
    },
    [workspaceId, planId, patchNode, setNodes],
  );

  // Inject the generate handler into every node's data (stable).
  const rfNodes = useMemo(
    () => nodes.map((n) => ({ ...n, data: { ...n.data, onGenerate: generateOne } })),
    [nodes, generateOne],
  );

  async function generateAll() {
    setBusy(true);
    setMsg(null);
    const targets = nodes
      .map((n) => (n.data as ContentNodeData).cn)
      .filter((cn) => cn.status === "empty" || cn.status === "error")
      .sort((a, b) => (GEN_ORDER[a.type] ?? 9) - (GEN_ORDER[b.type] ?? 9));
    // Sequential: the hub persists before spokes (which atomize it) run.
    for (const cn of targets) await generateOne(cn.id);
    setBusy(false);
    setMsg(targets.length ? "Generation complete." : "Nothing left to generate.");
    router.refresh();
  }

  async function save(): Promise<boolean> {
    const graph = {
      nodes: nodes.map((n) => ({ ...(n.data as ContentNodeData).cn, position: n.position })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    };
    const res = await fetch(`/api/admin/workspace/${workspaceId}/content-plans/${planId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() || initial.name, graph }),
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

  function deleteNode(id: string) {
    setNodes((nds) => nds.filter((n) => n.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  const selectedCn =
    (nodes.find((n) => n.id === selectedId)?.data as ContentNodeData | undefined)?.cn ?? null;
  const total = nodes.length;
  const generated = nodes.filter((n) => {
    const s = (n.data as ContentNodeData).cn.status;
    return s === "generated" || s === "approved";
  }).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-[14rem] flex-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="button"
          onClick={generateAll}
          disabled={busy}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
        >
          {busy ? "Generating…" : "✨ Generate all"}
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Save
        </button>
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
          {generated}/{total} generated
        </span>
        {msg ? <span className="text-xs text-neutral-500">{msg}</span> : null}
      </div>

      <div className="h-[640px] rounded-md border border-neutral-200 dark:border-neutral-800">
        <ReactFlow
          nodes={rfNodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) => setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>

      {selectedCn ? (
        <ContentNodeInspector
          node={selectedCn}
          busy={
            Boolean((nodes.find((n) => n.id === selectedId)?.data as ContentNodeData | undefined)?.busy) ||
            selectedCn.status === "generating"
          }
          onUpdate={(patch) => updateCn(selectedCn.id, patch)}
          onGenerate={() => generateOne(selectedCn.id)}
          onApprove={() => updateCn(selectedCn.id, { status: "approved" })}
          onDelete={() => deleteNode(selectedCn.id)}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}
