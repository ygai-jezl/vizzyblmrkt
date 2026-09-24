import { DEFAULT_BRANCH } from "@/lib/journey/conditions";
import { RESERVED_EVENTS } from "@/lib/connect/protocol";
import { ConnectionCatalogSchema, type ConnectionCatalog } from "@/lib/types/productConnection";
import type {
  ContentPool,
  JourneyAudience,
  LifecycleCondition,
  LifecycleGraph,
  LifecycleNode,
  LifecycleSettings,
} from "@/lib/types/lifecycle";

/**
 * Lifecycle graph traversal + the publish-time validator. A graph must be a DAG
 * from ONE trigger, every node reachable, every condition fully routed (a
 * "default" edge AND an edge per branch), every email backed by a non-empty pool,
 * no two waits in a row, and every condition field known to the connection's
 * catalog — otherwise a recipient could silently dead-end. Drafts may be
 * incomplete; publishing is refused until the issues are fixed.
 *
 * Waitlist journeys (engine move) read only `signup.*` and `enrolment.*`
 * fields, and may use A/B pools, weekly exits, waits over 60 days and no hard
 * stop; product journeys may not.
 */

export function nodeMap(graph: LifecycleGraph): Map<string, LifecycleNode> {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}

export function findTrigger(graph: LifecycleGraph): LifecycleNode | null {
  return graph.nodes.find((n) => n.type === "trigger") ?? null;
}

/**
 * The node reached from `fromId`. For a condition, pass the chosen branch handle;
 * an unwired branch falls back to the "default" edge.
 */
export function nextNodeId(graph: LifecycleGraph, fromId: string, handle?: string): string | null {
  const outs = graph.edges.filter((e) => e.source === fromId);
  if (handle !== undefined) {
    const edge =
      outs.find((e) => (e.sourceHandle ?? null) === handle) ??
      outs.find((e) => e.sourceHandle === DEFAULT_BRANCH);
    return edge?.target ?? null;
  }
  return outs[0]?.target ?? null;
}

export interface GraphIssue {
  code: string;
  nodeId?: string;
  detail?: string;
}

const RESERVED = new Set<string>(Object.values(RESERVED_EVENTS));
/** A product journey's longest wait (its hard stop is at most 60 days). */
const PRODUCT_MAX_WAIT_HOURS = 24 * 60;
/** What a waitlist journey is validated against: it has no product. */
export const NO_CATALOG: ConnectionCatalog = ConnectionCatalogSchema.parse({});

type AudienceKind = JourneyAudience["kind"];

/** Why a condition field isn't valid for this catalog, or null when it is. */
export function fieldProblem(field: string, catalog: ConnectionCatalog): string | null {
  const dot = field.indexOf(".");
  const family = field.slice(0, dot);
  const key = field.slice(dot + 1);
  if (family === "trait" && !catalog.traits.some((t) => t.key === key)) return `unknown trait "${key}"`;
  if (family === "step" && !catalog.onboardingSteps.some((s) => s.id === key)) return `unknown step "${key}"`;
  if (family === "milestone" && !RESERVED.has(key) && !catalog.events.some((e) => e.name === key)) {
    return `unknown event "${key}"`;
  }
  if (family === "onboarding" && catalog.onboardingSteps.length === 0) return "the catalog has no onboarding steps";
  return null;
}

function checkConditions(
  conds: LifecycleCondition[],
  catalog: ConnectionCatalog,
  nodeId: string,
  issues: GraphIssue[],
  audience: AudienceKind,
): void {
  for (const c of conds) {
    const family = c.field.slice(0, c.field.indexOf("."));
    if (audience === "waitlist" && family !== "signup" && family !== "enrolment") {
      issues.push({ code: "field_not_for_waitlist", nodeId, detail: c.field });
      continue;
    }
    if (audience === "product" && family === "signup") {
      issues.push({ code: "field_not_for_product", nodeId, detail: c.field });
      continue;
    }
    const p = fieldProblem(c.field, catalog);
    if (p) issues.push({ code: "unknown_field", nodeId, detail: p });
  }
}

export function validateLifecycleDraft(
  draft: { graph: LifecycleGraph; pools: ContentPool[]; settings?: LifecycleSettings },
  catalog: ConnectionCatalog,
  opts: { audience?: AudienceKind } = {},
): { ok: boolean; issues: GraphIssue[] } {
  const { graph, pools } = draft;
  const audience = opts.audience ?? "product";
  const issues: GraphIssue[] = [];
  if (audience === "product" && draft.settings && draft.settings.sendPolicy.hardStopDays === null) {
    issues.push({ code: "hard_stop_required" });
  }
  const byId = new Map<string, LifecycleNode>();
  for (const n of graph.nodes) {
    if (byId.has(n.id)) issues.push({ code: "duplicate_node", nodeId: n.id });
    byId.set(n.id, n);
  }
  for (const e of graph.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) issues.push({ code: "dangling_edge", detail: e.id });
  }

  const triggers = graph.nodes.filter((n) => n.type === "trigger");
  if (triggers.length === 0) return { ok: false, issues: [...issues, { code: "no_trigger" }] };
  if (triggers.length > 1) issues.push({ code: "multiple_triggers" });
  const trigger = triggers[0]!;
  if (graph.edges.some((e) => e.target === trigger.id)) issues.push({ code: "trigger_has_incoming", nodeId: trigger.id });

  const outs = (id: string) => graph.edges.filter((e) => e.source === id && byId.has(e.target));

  // Reachability + cycle detection (iterative DFS with an explicit colour map).
  const colour = new Map<string, "grey" | "black">();
  const stack: Array<{ id: string; next: number }> = [{ id: trigger.id, next: 0 }];
  colour.set(trigger.id, "grey");
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const children = outs(top.id);
    if (top.next < children.length) {
      const child = children[top.next]!.target;
      top.next += 1;
      const c = colour.get(child);
      if (c === "grey") issues.push({ code: "cycle", nodeId: child });
      else if (!c) {
        colour.set(child, "grey");
        stack.push({ id: child, next: 0 });
      }
    } else {
      colour.set(top.id, "black");
      stack.pop();
    }
  }
  for (const n of graph.nodes) {
    if (!colour.has(n.id)) issues.push({ code: "unreachable", nodeId: n.id });
  }
  if (outs(trigger.id).length === 0) issues.push({ code: "trigger_leads_nowhere", nodeId: trigger.id });

  const poolById = new Map(pools.map((p) => [p.id, p]));
  let emails = 0;
  for (const n of graph.nodes) {
    const o = outs(n.id);
    switch (n.type) {
      case "email": {
        emails += 1;
        const pool = n.data.poolId ? poolById.get(n.data.poolId) : undefined;
        if (!pool) issues.push({ code: "pool_missing", nodeId: n.id });
        if (o.length > 1) issues.push({ code: "multiple_outgoing", nodeId: n.id });
        break;
      }
      case "wait": {
        if (!n.data.wait) issues.push({ code: "wait_without_config", nodeId: n.id });
        if (o.length !== 1) issues.push({ code: "wait_leads_nowhere", nodeId: n.id });
        else if (byId.get(o[0]!.target)?.type === "wait") issues.push({ code: "consecutive_waits", nodeId: n.id });
        const w = n.data.wait;
        if (audience === "product" && w && Math.max(w.minHours, w.sinceEnrolHours ?? 0) > PRODUCT_MAX_WAIT_HOURS) {
          issues.push({ code: "wait_too_long", nodeId: n.id });
        }
        break;
      }
      case "condition": {
        const branches = n.data.branches ?? [];
        if (branches.length === 0) issues.push({ code: "condition_without_branches", nodeId: n.id });
        const ids = new Set<string>();
        for (const b of branches) {
          if (b.id === DEFAULT_BRANCH || ids.has(b.id)) issues.push({ code: "bad_branch_id", nodeId: n.id, detail: b.id });
          ids.add(b.id);
          checkConditions(b.conditions, catalog, n.id, issues, audience);
        }
        // A DEFAULT edge is always required: anyone matching no branch — including
        // every recipient whose field is unknown (three-state) — takes it. Without
        // it they'd silently finish the journey early.
        const handles = new Set(o.map((e) => e.sourceHandle ?? null));
        if (!handles.has(DEFAULT_BRANCH)) issues.push({ code: "condition_missing_default_edge", nodeId: n.id });
        for (const b of branches) {
          if (!handles.has(b.id)) issues.push({ code: "branch_unwired", nodeId: n.id, detail: b.id });
        }
        break;
      }
      case "exit":
        if (o.length > 0) issues.push({ code: "exit_has_outgoing", nodeId: n.id });
        if (audience === "product" && n.data.exitTarget) issues.push({ code: "exit_target_waitlist_only", nodeId: n.id });
        break;
      case "trigger":
        break;
    }
  }
  if (emails === 0) issues.push({ code: "no_email" });

  const seenPools = new Set<string>();
  for (const p of pools) {
    if (seenPools.has(p.id)) issues.push({ code: "duplicate_pool", detail: p.id });
    seenPools.add(p.id);
    if (p.abTest && audience === "product") issues.push({ code: "ab_test_waitlist_only", detail: p.id });
    else if (p.abTest && p.items.length < 2) issues.push({ code: "ab_test_needs_variants", detail: p.id });
    const itemIds = new Set<string>();
    for (const item of p.items) {
      if (itemIds.has(item.id)) issues.push({ code: "duplicate_pool_item", detail: `${p.id}/${item.id}` });
      itemIds.add(item.id);
      if (!item.subject.trim() || !item.body.trim()) {
        issues.push({ code: "pool_item_empty", detail: `${p.id}/${item.id}` });
      }
      if (item.eligibility) checkConditions(item.eligibility.conditions, catalog, `${p.id}/${item.id}`, issues, audience);
    }
  }
  return { ok: issues.length === 0, issues };
}
