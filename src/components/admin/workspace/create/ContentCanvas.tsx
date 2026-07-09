"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ContentNode, ContentPlan, ContentNodeType } from "@/lib/types/contentPlan";
import { frameworkLabel } from "@/lib/content/frameworks";
import {
  HubNode,
  PromoNode,
  SpokeNode,
  TriggerNode,
  EmailNode,
  WaitNode,
  ConditionNode,
  type ContentNodeData,
} from "./contentNodes";
import { ContentNodeInspector } from "./ContentNodeInspector";
import { AddNodePalette } from "./AddNodePalette";
import { EmailLayoutEditor } from "./email-layout/EmailLayoutEditor";
import { ContentPreviewModal } from "./preview/ContentPreviewModal";
import type { EmailLayout } from "@/lib/types/emailLayout";
import type { TemplateOption } from "./types";

/**
 * Create Canvas — the visual hub-and-spoke builder (React Flow). The Architect seeds
 * the graph; the HUB is generated + reviewed FIRST, then promos + spokes (they
 * atomize the hub, so editing the hub before they exist is intentional). Nodes are
 * draggable, freely connectable, and addable from the left palette; each node's
 * template is shown + editable in the inspector. Saved graph is Distribute-shaped.
 */
const RF_TYPE: Record<ContentNodeType, string> = {
  hub: "hub",
  promo_pre: "promo",
  promo_post: "promo",
  spoke: "spoke",
  trigger: "trigger",
  email: "email",
  wait: "wait",
  condition: "condition",
};

const GEN_ORDER: Record<ContentNodeType, number> = {
  hub: 0,
  promo_pre: 1,
  promo_post: 2,
  spoke: 3,
  email: 4,
  trigger: 5,
  wait: 6,
  condition: 7,
};

// Node types that carry an atomizing brief we can auto-write from upstream context (the
// hub is the root; structural + email nodes are out of scope). Mirrors the API guard.
const BRIEFABLE_TYPES = new Set<ContentNodeType>(["spoke", "promo_pre", "promo_post"]);

function roleFor(type: ContentNodeType, channel: string): string {
  if (type === "hub") return "Hub";
  if (type === "promo_pre") return "Pre-Hub Teaser";
  if (type === "promo_post") return "Post-Hub Promo";
  return `Spoke: ${channel}`;
}

function blockFor(type: ContentNodeType): string {
  if (type === "hub") return "full-post";
  if (type === "promo_post") return "cta";
  return "hook";
}

export function ContentCanvas({
  workspaceId,
  initial,
  templates,
  brandName,
}: {
  workspaceId: string;
  initial: ContentPlan;
  templates: TemplateOption[];
  /** Workspace name — the display identity in channel previews. */
  brandName?: string;
}) {
  const router = useRouter();
  const planId = initial.id;

  // Stable per-node generate handler (via a ref) so the nodes array passed to
  // ReactFlow keeps identity and stays draggable — no per-render re-mapping.
  const generateRef = useRef<(id: string) => Promise<void>>(async () => {});
  const onGenerate = useCallback((id: string) => generateRef.current(id), []);

  const seeded = useMemo(
    () => ({
      nodes: initial.graph.nodes.map<Node>((cn) => ({
        id: cn.id,
        type: RF_TYPE[cn.type],
        position: cn.position,
        data: { cn, onGenerate, workspaceId, planId: initial.id } as ContentNodeData,
      })),
      edges: initial.graph.edges.map<Edge>((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        // Condition-branch labels (Yes/No) render on the wire.
        label: e.label ?? undefined,
      })),
    }),
    [initial, onGenerate, workspaceId],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(seeded.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(seeded.edges);
  const [name, setName] = useState(initial.name);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [layoutEditorFor, setLayoutEditorFor] = useState<string | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Synchronous mirror of nodes/edges for the async brief pipeline. React commits renders
  // on a macrotask, which lags the pipeline's microtask hand-off — so `applyNodes` below
  // keeps nodesRef.current current SYNCHRONOUSLY on every data mutation. Without that, one
  // serialized pipeline's full-graph save would persist a snapshot missing the PREVIOUS
  // pipeline's just-written brief and silently clobber it in Firestore. Positions
  // (onNodesChange) stay on the raw setter and reconcile via the render assignment.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  // Serializes the connect→save→brief→patch pipelines (one at a time).
  const briefChainRef = useRef<Promise<void>>(Promise.resolve());

  // Every node-DATA mutation funnels through here so nodesRef.current updates synchronously
  // (see above). Value-set (not functional) computed from the synchronous ref, so sequential
  // calls compose correctly and the pipeline never reads a stale node array.
  const applyNodes = useCallback(
    (fn: (nds: Node[]) => Node[]) => {
      const next = fn(nodesRef.current);
      nodesRef.current = next;
      setNodes(next);
    },
    [setNodes],
  );

  // Same synchronous-ref discipline for edges, so the pipeline's full-graph save persists
  // the just-drawn edge (and every later one) instead of a render-lagged snapshot.
  const applyEdges = useCallback(
    (fn: (eds: Edge[]) => Edge[]) => {
      const next = fn(edgesRef.current);
      edgesRef.current = next;
      setEdges(next);
    },
    [setEdges],
  );

  const nodeTypes = useMemo(
    () => ({
      hub: HubNode,
      promo: PromoNode,
      spoke: SpokeNode,
      trigger: TriggerNode,
      email: EmailNode,
      wait: WaitNode,
      condition: ConditionNode,
    }),
    [],
  );
  const isSequence = initial.strategy.objective === "email_sequence";

  // Connecting a fresh node auto-writes its brief from what it's wired to (its upstream
  // context up to the hub) — when the target is an empty, briefable, idle node. We add
  // the edge with a COMPACT id (React Flow's default `xy-edge__<src>-<tgt>` id can top
  // the 96-char edge-id schema cap with ~46-char node ids and 400 the whole-graph save),
  // then hand off to the serialized brief pipeline.
  function onConnect(c: Connection) {
    if (!c.source || !c.target || c.source === c.target) return;
    const edge: Edge = { id: `e_${crypto.randomUUID()}`, source: c.source, target: c.target };
    const before = edgesRef.current.length;
    applyEdges((eds) => addEdge(edge, eds)); // updates edgesRef.current synchronously
    if (edgesRef.current.length === before || isSequence) return; // addEdge dedups; sequences self-brief
    const briefId = pickBriefTarget(c.target, c.source);
    if (briefId) enqueueBrief(briefId);
  }

  // A node qualifies for AUTO briefing only if it's briefable, still brief-less, and idle.
  function canAutoBrief(id: string): boolean {
    const n = nodesRef.current.find((x) => x.id === id);
    if (!n) return false;
    const d = n.data as ContentNodeData;
    return (
      BRIEFABLE_TYPES.has(d.cn.type) &&
      !d.cn.brief?.trim() &&
      !d.busy &&
      !d.briefBusy &&
      d.cn.status !== "generating"
    );
  }

  // Prefer the downstream TARGET (hub→spoke direction); fall back to the source if the
  // user dragged the other way. Returns null when neither end should be auto-briefed.
  function pickBriefTarget(targetId: string, sourceId: string): string | null {
    if (canAutoBrief(targetId)) return targetId;
    if (canAutoBrief(sourceId)) return sourceId;
    return null;
  }

  // Serialize connect→save→brief→patch so rapid connects don't let one full-graph save
  // (a render snapshot) clobber another node's freshly-written brief.
  function enqueueBrief(id: string): void {
    briefChainRef.current = briefChainRef.current
      .catch(() => {})
      .then(() => runBriefPipeline(id));
  }

  async function runBriefPipeline(id: string): Promise<void> {
    patchNode(id, { briefBusy: true });
    try {
      // Persist the node (it may be brand-new) + its current config + the new edge BEFORE
      // the server reads the plan. save() reads the synchronous node/edge refs, so a prior
      // pipeline's just-written brief (and every drawn edge) survives this full-graph save.
      // save() can REJECT on a network error (fetch throws) — the finally still clears
      // briefBusy so the node can't get stuck mid-"writing brief…".
      const ok = await save();
      if (!ok) {
        setMsg("Save failed — brief not written.");
        return;
      }
      const res = await fetch(
        `/api/admin/workspace/${workspaceId}/content-plans/${planId}/nodes/${id}/brief`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      const data = (await res.json().catch(() => ({}))) as { node?: ContentNode };
      // Patch only the brief (not the whole node) so a concurrent local edit isn't lost.
      if (res.ok && data.node) updateCn(id, { brief: data.node.brief ?? null });
      else setMsg("Couldn't write the brief — try again.");
    } catch {
      setMsg("Couldn't write the brief — try again.");
    } finally {
      patchNode(id, { briefBusy: false });
    }
  }

  // Manual "Suggest brief" — force a (re)write from the node's current connections,
  // overwriting any existing brief (skips the empty-only guard the auto path uses).
  function suggestBrief(id: string): void {
    const d = nodesRef.current.find((n) => n.id === id)?.data as ContentNodeData | undefined;
    if (!d || d.briefBusy) return;
    enqueueBrief(id);
  }

  const patchNode = useCallback(
    (id: string, patch: Partial<ContentNodeData>) =>
      applyNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n))),
    [applyNodes],
  );

  const updateCn = useCallback(
    (id: string, patch: Partial<ContentNode>) =>
      applyNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n;
          const cur = (n.data as ContentNodeData).cn;
          const next = { ...cur, ...patch };
          // Editing the reviewable copy of an approved node un-approves it (forces
          // re-review; a hub edit can change what the spokes should atomize). For email
          // nodes the subject / preview / framework are part of what was approved too.
          const contentEdited =
            patch.body !== undefined ||
            (cur.type === "email" &&
              (patch.subject !== undefined ||
                patch.previewText !== undefined ||
                patch.framework !== undefined));
          if (contentEdited && patch.status === undefined && cur.status === "approved") {
            next.status = "generated";
          }
          return { ...n, data: { ...n.data, cn: next } };
        }),
      ),
    [applyNodes],
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
          patchNode(id, { busy: false });
          updateCn(id, { status: "error", warnings: ["request_failed"] });
        }
      } catch {
        patchNode(id, { busy: false });
      }
    },
    [workspaceId, planId, patchNode, updateCn],
  );
  // Persist the graph (fresh brief/channel/template) BEFORE the server reads the node,
  // then generate. Every SINGLE-node generate entry point funnels through here so an
  // edited-but-unsaved brief isn't silently ignored (the generate route reads the
  // PERSISTED node from Firestore, not the request body).
  async function saveThenGenerate(id: string): Promise<void> {
    // Claim the busy flag synchronously so a second click is disabled during the save
    // window (generateOne only sets busy AFTER the save). Short-circuit if already busy or
    // mid-brief-write (else Generate would race the brief the connect just triggered).
    const d = nodesRef.current.find((n) => n.id === id)?.data as ContentNodeData | undefined;
    if (!d || d.busy || d.briefBusy || d.cn.status === "generating") return;
    patchNode(id, { busy: true });
    const ok = await save();
    if (!ok) {
      // Don't generate against a stale brief — clear busy, keep status as-is, tell the user.
      patchNode(id, { busy: false });
      setMsg("Save failed — not generated. Check your connection and retry.");
      return;
    }
    await generateOne(id); // re-sets busy:true then clears it — harmless
  }

  // Keep the node-card Generate button (which fires through the stable generateRef) on
  // the latest saveThenGenerate, so it persists before generating like the other paths.
  useEffect(() => {
    generateRef.current = saveThenGenerate;
  });

  function addNode(
    type: ContentNodeType,
    channel: string,
    opts?: { framework?: string | null; templateId?: string | null },
  ) {
    const id = `${type}_${crypto.randomUUID()}`;
    const framework = type === "spoke" ? opts?.framework ?? null : null;
    const cn: ContentNode = {
      id,
      type,
      channel,
      format: null,
      blockType: blockFor(type),
      role: framework ? `${frameworkLabel(framework)} → ${channel}` : roleFor(type, channel),
      position: { x: 24, y: 24 + nodes.length * 6 },
      templateId: opts?.templateId ?? null,
      framework,
      brief: null,
      body: "",
      placeholderValues: {},
      status: "empty",
      scheduledAt: null,
      warnings: [],
      subject: null,
      previewText: null,
      subjectVariants: [],
      waitConfig: null,
      conditionConfig: null,
    };
    applyNodes((nds) => [
      ...nds,
      { id, type: RF_TYPE[type], position: cn.position, data: { cn, onGenerate } as ContentNodeData },
    ]);
    setSelectedId(id);
  }

  function deleteNode(id: string) {
    applyNodes((nds) => nds.filter((n) => n.id !== id));
    applyEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    if (selectedId === id) setSelectedId(null);
  }

  const cnOf = (n: Node) => (n.data as ContentNodeData).cn;
  const hubNode = nodes.find((n) => cnOf(n).type === "hub");
  const hubCn = hubNode ? cnOf(hubNode) : null;
  const hubHasBody = Boolean(hubCn?.body);
  const hubApproved = hubCn?.status === "approved";

  async function genHub() {
    if (!hubCn) return;
    setBusy(true);
    setMsg(null);
    // Persist first so the generate route reads the current (possibly edited) hub brief.
    const ok = await save();
    if (!ok) {
      setBusy(false);
      setMsg("Save failed — hub not generated.");
      return;
    }
    await generateOne(hubCn.id);
    setBusy(false);
    setMsg("Hub drafted — review it, then approve to build the spokes.");
  }

  async function genRest() {
    // Defence in depth: the hub must be approved before spokes/promos generate (the
    // button is also disabled, but guard the function so a direct call can't bypass it).
    if (!hubApproved) return;
    setBusy(true);
    setMsg(null);
    // Persist ONCE up front so each generate reads the current briefs. Saving inside the
    // loop would clobber freshly-generated bodies with the stale render-snapshot nodes.
    const ok = await save();
    if (!ok) {
      setBusy(false);
      setMsg("Save failed — nothing generated.");
      return;
    }
    // Promos + spokes that aren't approved yet, hub excluded; promos before spokes.
    const targets = nodes
      .map(cnOf)
      .filter((cn) => cn.type !== "hub" && cn.status !== "approved")
      .sort((a, b) => (GEN_ORDER[a.type] ?? 9) - (GEN_ORDER[b.type] ?? 9));
    for (const cn of targets) await generateOne(cn.id);
    setBusy(false);
    setMsg(targets.length ? "Spokes & promos generated." : "Nothing left to generate.");
    router.refresh();
  }

  // Sequence mode: no hub / approval gate — fill every email node in order.
  async function genAllEmails() {
    setBusy(true);
    setMsg(null);
    const ok = await save();
    if (!ok) {
      setBusy(false);
      setMsg("Save failed — nothing generated.");
      return;
    }
    const targets = nodes.map(cnOf).filter((cn) => cn.type === "email" && cn.status !== "approved");
    for (const cn of targets) await generateOne(cn.id);
    setBusy(false);
    setMsg(targets.length ? "Emails generated." : "Nothing left to generate.");
    router.refresh();
  }

  // Defaults to the synchronous refs (not the render-lagged `nodes`/`edges` closures) so
  // any save — brief pipeline, toolbar Save, generate — persists the latest committed graph
  // and can't clobber a concurrently-written brief/body. `nodesOverride` still lets the
  // layout editor persist a just-computed list.
  async function save(nodesOverride?: Node[], edgesOverride?: Edge[]): Promise<boolean> {
    const src = nodesOverride ?? nodesRef.current;
    const edgeSrc = edgesOverride ?? edgesRef.current;
    const graph = {
      nodes: src.map((n) => ({ ...cnOf(n), position: n.position })),
      edges: edgeSrc.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        // Preserve the branch label so the first save doesn't strip it from Firestore.
        label: typeof e.label === "string" ? e.label : null,
      })),
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

  const selectedRf = selectedId ? nodes.find((n) => n.id === selectedId) : undefined;
  const selectedCn = selectedRf ? (selectedRf.data as ContentNodeData).cn : null;
  const selectedBusy = Boolean(selectedRf && (selectedRf.data as ContentNodeData).busy);
  const total = nodes.length;
  const generated = nodes.filter((n) => {
    const s = cnOf(n).status;
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
        {isSequence ? (
          <button
            type="button"
            onClick={genAllEmails}
            disabled={busy}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
          >
            {busy ? "Generating…" : "✨ Generate all emails"}
          </button>
        ) : !hubHasBody ? (
          <button
            type="button"
            onClick={genHub}
            disabled={busy}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
          >
            {busy ? "Generating…" : "✨ Generate hub"}
          </button>
        ) : (
          <button
            type="button"
            onClick={genRest}
            disabled={busy || !hubApproved}
            title={hubApproved ? "" : "Approve the hub first"}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {busy ? "Generating…" : "✨ Generate spokes & promos"}
          </button>
        )}
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
        {!isSequence && hubHasBody && !hubApproved ? (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            Review &amp; approve the hub to generate the rest.
          </span>
        ) : msg ? (
          <span className="text-xs text-neutral-500">{msg}</span>
        ) : null}
      </div>

      <div className="h-[640px] rounded-md border border-neutral-200 dark:border-neutral-800">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) => setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          colorMode="system"
          proOptions={{ hideAttribution: true }}
          fitView
        >
          <Background />
          <Controls />
          <Panel position="top-left">
            <AddNodePalette onAdd={addNode} templates={templates} />
          </Panel>
        </ReactFlow>
      </div>

      {selectedCn ? (
        <ContentNodeInspector
          node={selectedCn}
          workspaceId={workspaceId}
          planId={planId}
          templates={templates}
          busy={selectedBusy || selectedCn.status === "generating"}
          briefBusy={Boolean(selectedRf && (selectedRf.data as ContentNodeData).briefBusy)}
          onUpdate={(patch) => updateCn(selectedCn.id, patch)}
          onGenerate={() => saveThenGenerate(selectedCn.id)}
          onSuggestBrief={() => suggestBrief(selectedCn.id)}
          onApprove={() => updateCn(selectedCn.id, { status: "approved" })}
          onDelete={() => deleteNode(selectedCn.id)}
          onClose={() => setSelectedId(null)}
          onOpenLayout={
            selectedCn.type === "email" ? () => setLayoutEditorFor(selectedCn.id) : undefined
          }
          onOpenPreview={
            selectedCn.type === "trigger" ||
            selectedCn.type === "wait" ||
            selectedCn.type === "condition"
              ? undefined
              : () => setPreviewFor(selectedCn.id)
          }
        />
      ) : null}

      {(() => {
        if (!previewFor) return null;
        const previewNode = nodes.map(cnOf).find((cn) => cn.id === previewFor);
        if (!previewNode) return null;
        return (
          <ContentPreviewModal
            node={previewNode}
            brandName={brandName}
            workspaceId={workspaceId}
            fullEbook={previewNode.channel === "ebook" ? initial.ebookDraft ?? null : null}
            onClose={() => setPreviewFor(null)}
          />
        );
      })()}

      {(() => {
        if (!layoutEditorFor) return null;
        const editNode = nodes.map(cnOf).find((cn) => cn.id === layoutEditorFor);
        if (!editNode) return null;
        return (
          <EmailLayoutEditor
            node={editNode}
            workspaceId={workspaceId}
            planId={planId}
            onSave={async (layout: EmailLayout, body: string) => {
              // Layout is the source of truth; body is its rendered HTML. Build the next
              // node list explicitly (setState is async → stale closure) and PERSIST it
              // first; only commit to canvas state + close on success so the UI never
              // shows an un-saved layout and the operator's edits survive a failed save.
              const nextNodes = nodes.map((n) => {
                if (n.id !== layoutEditorFor) return n;
                const cur = (n.data as ContentNodeData).cn;
                const status = cur.status === "approved" ? "generated" : cur.status;
                return { ...n, data: { ...n.data, cn: { ...cur, layout, body, status } } };
              });
              const ok = await save(nextNodes);
              if (ok) {
                applyNodes(() => nextNodes);
                setLayoutEditorFor(null);
                setMsg("Layout saved.");
              } else {
                setMsg("Save failed — retry.");
              }
            }}
            onClose={() => setLayoutEditorFor(null)}
          />
        );
      })()}
    </div>
  );
}
