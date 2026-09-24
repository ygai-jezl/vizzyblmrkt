"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Plus, Trash2 } from "lucide-react";
import type {
  ContentPool,
  LifecycleBranch,
  LifecycleGraph,
  LifecycleNodeData,
  LifecycleNodeType,
  WaitConfig,
} from "@/lib/types/lifecycle";
import { CanvasInfoContext, lifecycleNodeTypes } from "./nodes";
import { ConditionList } from "./ConditionList";
import { conditionText, newId, type FieldOption, type GraphIssue } from "./model";
import { Button, Field, inputClass } from "../connect/ui";

/**
 * The lifecycle canvas: the journey's graph in React Flow (drag, connect, add,
 * delete) with an inspector for the selected step. The canvas owns the graph
 * while it's open and reports every real change upward; the parent remounts it
 * (via `key`) when the journey is reloaded.
 */

type RFNode = Node<LifecycleNodeData>;

function toRf(graph: LifecycleGraph): { nodes: RFNode[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: n.data,
      deletable: n.type !== "trigger",
    })),
    edges: graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
  };
}

function toGraph(nodes: RFNode[], edges: Edge[]): LifecycleGraph {
  const ids = new Set(nodes.map((n) => n.id));
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type as LifecycleNodeType,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      data: n.data,
    })),
    edges: edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
  };
}

function edgeLabel(nodes: RFNode[], e: Edge, fields: FieldOption[]): string | undefined {
  if (!e.sourceHandle) return undefined;
  if (e.sourceHandle === "default") return "Default";
  const b = nodes.find((n) => n.id === e.source)?.data.branches?.find((x) => x.id === e.sourceHandle);
  if (!b) return undefined;
  return b.label || (b.conditions[0] ? conditionText(b.conditions[0], fields) : b.id);
}

function addable(waitlist: boolean): Array<{ type: LifecycleNodeType; label: string; data: () => LifecycleNodeData }> {
  return [
    { type: "email", label: "Email", data: () => ({ label: "Email" }) },
    {
      type: "wait",
      label: "Wait",
      // A welcome journey sends at any time, counting from the previous step (as it always has).
      data: () => ({ label: "Wait", wait: waitlist ? { minHours: 24, after: "previous_step" } : { minHours: 24, differentLocalDay: true } }),
    },
    {
      type: "condition",
      label: "Split",
      data: () => ({
        label: "Split",
        branches: [
          waitlist
            ? { id: newId("br"), label: "Made a referral", match: "all", conditions: [{ field: "signup.madeReferral", operator: "is_true" }] }
            : { id: newId("br"), label: "Onboarding complete", match: "all", conditions: [{ field: "onboarding.complete", operator: "is_true" }] },
        ],
      }),
    },
    { type: "exit", label: "Exit", data: () => ({ label: "End" }) },
  ];
}

export function LifecycleCanvas({
  graph,
  pools,
  triggerEvent,
  fields,
  issues,
  readOnly,
  onChange,
  onEditContent,
  waitlist = false,
}: {
  graph: LifecycleGraph;
  pools: ContentPool[];
  triggerEvent: string;
  fields: FieldOption[];
  issues: GraphIssue[];
  readOnly: boolean;
  onChange: (graph: LifecycleGraph) => void;
  onEditContent: (poolId: string) => void;
  /** A launch's welcome journey (engine move). */
  waitlist?: boolean;
}) {
  const ADDABLE = useMemo(() => addable(waitlist), [waitlist]);
  const seeded = useMemo(() => toRf(graph), []); // eslint-disable-line react-hooks/exhaustive-deps -- seed once; remount to reload
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>(seeded.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(seeded.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rf = useRef<ReactFlowInstance<RFNode, Edge> | null>(null);
  const pane = useRef<HTMLDivElement | null>(null);

  // Report real graph changes upward (not selection or measuring).
  const last = useRef(JSON.stringify(toGraph(seeded.nodes, seeded.edges)));
  useEffect(() => {
    const g = toGraph(nodes, edges);
    const s = JSON.stringify(g);
    if (s !== last.current) {
      last.current = s;
      onChange(g);
    }
  }, [nodes, edges, onChange]);

  const labelledEdges = useMemo(
    () => edges.map((e) => ({ ...e, label: edgeLabel(nodes, e, fields) })),
    [edges, nodes, fields],
  );
  const flagged = useMemo(() => new Set(issues.flatMap((i) => (i.nodeId ? [i.nodeId] : []))), [issues]);
  const info = useMemo(() => ({ pools, triggerEvent, fields, flagged }), [pools, triggerEvent, fields, flagged]);

  const onConnect = useCallback(
    (c: Connection) => {
      if (readOnly || !c.source || !c.target || c.source === c.target) return;
      const target = nodes.find((n) => n.id === c.target);
      if (target?.type === "trigger") return;
      setEdges((eds) => [
        // One edge per (step, branch): reconnecting replaces the old one.
        ...eds.filter((e) => !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null))),
        {
          id: `e_${c.source}_${c.sourceHandle ?? "out"}_${c.target}`,
          source: c.source,
          target: c.target,
          sourceHandle: c.sourceHandle ?? null,
        },
      ]);
    },
    [nodes, readOnly, setEdges],
  );

  const addNode = (spec: ReturnType<typeof addable>[number]) => {
    const box = pane.current?.getBoundingClientRect();
    const position =
      rf.current && box
        ? rf.current.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 })
        : { x: 0, y: 0 };
    const id = newId(spec.type);
    setNodes((ns) => [...ns, { id, type: spec.type, position, data: spec.data(), deletable: true }]);
    setSelectedId(id);
  };

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const patchData = (id: string, patch: Partial<LifecycleNodeData>) =>
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
  const removeNode = (id: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    setSelectedId(null);
  };

  return (
    <CanvasInfoContext.Provider value={info}>
      <div className="flex flex-col gap-3 lg:flex-row">
        <div className="min-w-0 flex-1 space-y-2">
          {!readOnly ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {ADDABLE.map((a) => (
                <Button key={a.type} onClick={() => addNode(a)}>
                  <Plus size={14} /> {a.label}
                </Button>
              ))}
              <span className="text-xs text-neutral-500">Drag from a handle to connect · select + Backspace to delete</span>
            </div>
          ) : null}
          <div ref={pane} className="h-[560px] rounded-lg border border-neutral-200 dark:border-neutral-800">
            <ReactFlow<RFNode, Edge>
              nodes={nodes.map((n) => ({ ...n, selected: n.id === selectedId }))}
              edges={labelledEdges}
              nodeTypes={lifecycleNodeTypes}
              onNodesChange={readOnly ? undefined : onNodesChange}
              onEdgesChange={readOnly ? undefined : onEdgesChange}
              onConnect={onConnect}
              onInit={(inst) => {
                rf.current = inst;
              }}
              onNodeClick={(_, n) => setSelectedId(n.id)}
              onPaneClick={() => setSelectedId(null)}
              nodesDraggable={!readOnly}
              nodesConnectable={!readOnly}
              elementsSelectable
              deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
              fitView
              minZoom={0.2}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        </div>
        <aside className="w-full shrink-0 space-y-3 rounded-lg border border-neutral-200 p-3 lg:w-80 dark:border-neutral-800">
          {selected ? (
            <Inspector
              node={selected}
              pools={pools}
              fields={fields}
              triggerEvent={triggerEvent}
              readOnly={readOnly}
              issues={issues.filter((i) => i.nodeId === selected.id)}
              waitlist={waitlist}
              onPatch={(patch) => patchData(selected.id, patch)}
              onRemove={() => removeNode(selected.id)}
              onRemoveBranchEdges={(branchId) =>
                setEdges((es) => es.filter((e) => !(e.source === selected.id && e.sourceHandle === branchId)))
              }
              onEditContent={onEditContent}
            />
          ) : (
            <div className="space-y-2 text-sm text-neutral-500">
              <p className="font-medium text-neutral-700 dark:text-neutral-300">Select a step to edit it.</p>
              {waitlist ? (
                <p>
                  <b>Wait</b> steps decide when the next email goes out (at any time of day). <b>Split</b> steps send
                  people down the first branch they match, using their signup details; everyone else takes{" "}
                  <b>Default</b>. An <b>Email</b> step sends its email, or each person&rsquo;s A/B variant.
                </p>
              ) : (
              <p>
                <b>Wait</b> steps decide when the next email may go out (always inside the recipient&rsquo;s send
                window). <b>Split</b> steps send people down the first branch they match; anyone else — including
                people whose data is unknown — takes <b>Default</b>. An <b>Email</b> step sends the next email from its
                content pool that the person hasn&rsquo;t had yet.
              </p>
              )}
            </div>
          )}
        </aside>
      </div>
    </CanvasInfoContext.Provider>
  );
}

function Inspector({
  node,
  pools,
  fields,
  triggerEvent,
  readOnly,
  issues,
  waitlist,
  onPatch,
  onRemove,
  onRemoveBranchEdges,
  onEditContent,
}: {
  node: RFNode;
  pools: ContentPool[];
  fields: FieldOption[];
  triggerEvent: string;
  readOnly: boolean;
  issues: GraphIssue[];
  waitlist: boolean;
  onPatch: (patch: Partial<LifecycleNodeData>) => void;
  onRemove: () => void;
  onRemoveBranchEdges: (branchId: string) => void;
  onEditContent: (poolId: string) => void;
}) {
  const d = node.data;
  const setWait = (patch: Partial<WaitConfig>) => onPatch({ wait: { minHours: 24, ...d.wait, ...patch } });
  const num = (v: string): number | undefined => (v.trim() === "" ? undefined : Math.max(0, Number(v)));
  const branches = d.branches ?? [];
  const setBranch = (i: number, patch: Partial<LifecycleBranch>) =>
    onPatch({ branches: branches.map((b, j) => (j === i ? { ...b, ...patch } : b)) });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{node.type}</span>
        {node.type !== "trigger" && !readOnly ? (
          <button type="button" className="text-neutral-400 hover:text-red-600" onClick={onRemove} aria-label="Delete step">
            <Trash2 size={15} />
          </button>
        ) : null}
      </div>
      {issues.length > 0 ? (
        <ul className="space-y-1 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {issues.map((i, k) => (
            <li key={k}>{i.code.replace(/_/g, " ")}{i.detail ? ` — ${i.detail}` : ""}</li>
          ))}
        </ul>
      ) : null}

      {node.type === "trigger" && waitlist ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">People enter when they join the waitlist (once their email is verified).</p>
      ) : node.type === "trigger" ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          People enter when <code className="font-mono text-xs">{triggerEvent}</code> arrives from the product. Change the
          event on the Settings tab.
        </p>
      ) : (
        <Field label="Label">
          <input className={inputClass} value={d.label ?? ""} disabled={readOnly} onChange={(e) => onPatch({ label: e.target.value.slice(0, 120) })} />
        </Field>
      )}

      {node.type === "email" ? (
        <>
          <Field label="Sends from" hint="Each person gets the next email in this pool they haven't had yet.">
            <select className={inputClass} value={d.poolId ?? ""} disabled={readOnly} onChange={(e) => onPatch({ poolId: e.target.value || undefined })}>
              <option value="">Choose content…</option>
              {pools.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.items.length})
                </option>
              ))}
            </select>
          </Field>
          {d.poolId ? (
            <Button onClick={() => onEditContent(d.poolId!)}>Edit this content</Button>
          ) : null}
        </>
      ) : null}

      {node.type === "wait" && waitlist ? (
        <div className="space-y-2">
          <Field label="Wait (hours)">
            <input className={inputClass} type="number" min={0} step="0.25" disabled={readOnly} value={d.wait?.minHours ?? 0} onChange={(e) => setWait({ minHours: num(e.target.value) ?? 0 })} />
          </Field>
          <Field label="Counting from">
            <select
              className={inputClass}
              disabled={readOnly}
              value={d.wait?.after ?? "previous_email"}
              onChange={(e) => setWait({ after: e.target.value === "previous_step" ? "previous_step" : undefined })}
            >
              <option value="previous_step">The previous step</option>
              <option value="previous_email">The previous email</option>
            </select>
          </Field>
        </div>
      ) : node.type === "wait" ? (
        <div className="space-y-2">
          <Field label="At least (hours) after the previous email">
            <input className={inputClass} type="number" min={0} step="0.25" disabled={readOnly} value={d.wait?.minHours ?? 0} onChange={(e) => setWait({ minHours: num(e.target.value) ?? 0 })} />
          </Field>
          <Field label="And at least (hours) after sign-up" hint="Optional — keeps emails on the right day of the sequence.">
            <input className={inputClass} type="number" min={0} disabled={readOnly} value={d.wait?.sinceEnrolHours ?? ""} onChange={(e) => setWait({ sinceEnrolHours: num(e.target.value) })} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled={readOnly} checked={Boolean(d.wait?.differentLocalDay)} onChange={(e) => setWait({ differentLocalDay: e.target.checked || undefined })} />
            On a later day than the previous email
          </label>
          <Field label="Send right away within (hours of sign-up)" hint="Ignores the send window early on — for a welcome email.">
            <input className={inputClass} type="number" min={0} max={48} step="0.25" disabled={readOnly} value={d.wait?.windowExemptHours ?? ""} onChange={(e) => setWait({ windowExemptHours: num(e.target.value) })} />
          </Field>
        </div>
      ) : null}

      {node.type === "condition" ? (
        <div className="space-y-3">
          {branches.map((b, i) => (
            <div key={b.id} className="space-y-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
              <div className="flex items-center gap-2">
                <input
                  className={`${inputClass} flex-1`}
                  value={b.label ?? ""}
                  placeholder={`Branch ${i + 1}`}
                  disabled={readOnly}
                  onChange={(e) => setBranch(i, { label: e.target.value.slice(0, 80) })}
                  aria-label="Branch name"
                />
                {!readOnly ? (
                  <button
                    type="button"
                    className="text-neutral-400 hover:text-red-600"
                    onClick={() => {
                      onPatch({ branches: branches.filter((_, j) => j !== i) });
                      onRemoveBranchEdges(b.id);
                    }}
                    aria-label="Remove branch"
                  >
                    <Trash2 size={14} />
                  </button>
                ) : null}
              </div>
              {b.conditions.length > 1 ? (
                <select className={`${inputClass} w-auto`} value={b.match ?? "all"} disabled={readOnly} onChange={(e) => setBranch(i, { match: e.target.value as "all" | "any" })}>
                  <option value="all">All of these</option>
                  <option value="any">Any of these</option>
                </select>
              ) : null}
              <ConditionList
                conditions={b.conditions}
                fields={fields}
                disabled={readOnly}
                waitlist={waitlist}
                onChange={(conditions) => setBranch(i, { conditions: conditions.length ? conditions : b.conditions })}
              />
            </div>
          ))}
          {!readOnly && branches.length < 10 ? (
            <Button
              onClick={() =>
                onPatch({
                  branches: [
                    ...branches,
                    {
                      id: newId("br"),
                      label: "",
                      match: "all",
                      conditions: [waitlist ? { field: "signup.madeReferral", operator: "is_true" } : { field: "onboarding.complete", operator: "is_true" }],
                    },
                  ],
                })
              }
            >
              <Plus size={14} /> Branch
            </Button>
          ) : null}
          <p className="text-xs text-neutral-500">
            {waitlist
              ? "Default: everyone who matches no branch."
              : "Default: everyone who matches no branch — including anyone whose data is unknown."}
          </p>
        </div>
      ) : null}

      {node.type === "exit" && waitlist ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            disabled={readOnly}
            checked={d.exitTarget === "weekly"}
            onChange={(e) => onPatch({ exitTarget: e.target.checked ? "weekly" : undefined })}
          />
          Then add them to the weekly newsletter
        </label>
      ) : null}
    </div>
  );
}
