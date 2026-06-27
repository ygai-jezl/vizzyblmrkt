import type {
  JourneyGraph,
  JourneyBranch,
  JourneyCondition,
  JourneyEdge,
  JourneyNode,
} from "@/lib/types/journey";
import { CONDITION_FIELD_BY_KEY, DEFAULT_BRANCH } from "@/lib/journey/conditions";

/**
 * Pure, idempotent repair for the journey condition dead-end bug
 * (see scripts/diagnose-journey.ts + the incident write-up): condition branches
 * were authored with invalid field keys and no `default` else-edge, so every
 * branch evaluated false → `selectBranch` returned "default" → `resolveNextStep`
 * found no edge → the chain silently dead-ended.
 *
 * `fixJourneyGraph`:
 *   1. rewrites each condition branch to its intended multi-factor rule set
 *      (`opts.branchRules`, keyed by branch id), clearing the legacy single
 *      `condition`; and
 *   2. guarantees every condition node has a wired "default" else-edge.
 *
 * It returns a NEW graph (the input is never mutated) plus the list of changes,
 * which is EMPTY on an already-fixed graph — so `fix(fix(g)) === fix(g)` and a
 * re-run is a safe no-op. A branch with an unknown field but NO provided rule is
 * left untouched and surfaced as a `warning`, never silently changed.
 */

/** Intended rule set for one branch (replaces its legacy single rule). */
export interface BranchRule {
  /** "all" = AND (default), "any" = OR. */
  match?: "all" | "any";
  conditions: JourneyCondition[];
}

export interface FixOptions {
  /** branchId → intended multi-factor rule set. */
  branchRules?: Record<string, BranchRule>;
  /** conditionNodeId → fallback ("default") target node id. */
  defaultTargets?: Record<string, string>;
}

export type GraphFixChange =
  | { kind: "branch_rewritten"; nodeId: string; branchId: string; after: BranchRule }
  | { kind: "default_edge_added"; nodeId: string; edgeId: string; target: string }
  | { kind: "warning"; nodeId: string; branchId?: string; message: string };

function condEq(a: JourneyCondition, b: JourneyCondition): boolean {
  return (
    a.field === b.field &&
    a.operator === b.operator &&
    (a.value ?? null) === (b.value ?? null) &&
    (a.questionValue ?? null) === (b.questionValue ?? null)
  );
}

/** Order-stable structural compare so a re-run detects "already fixed". */
function alreadyApplied(b: JourneyBranch, rule: BranchRule): boolean {
  if ((b.match ?? "all") !== (rule.match ?? "all")) return false;
  const bc = b.conditions ?? [];
  if (bc.length !== rule.conditions.length) return false;
  if (b.condition !== undefined) return false; // legacy rule not yet cleared
  return bc.every((c, i) => condEq(c, rule.conditions[i]!));
}

export function fixJourneyGraph(
  graph: JourneyGraph,
  opts: FixOptions = {},
): { graph: JourneyGraph; changes: GraphFixChange[] } {
  const branchRules = opts.branchRules ?? {};
  const defaultTargets = opts.defaultTargets ?? {};
  const changes: GraphFixChange[] = [];

  // 1. Rewrite condition branches.
  const nodes: JourneyNode[] = graph.nodes.map((n) => {
    if (n.type !== "condition") return n;
    const branches = (n.data.branches ?? []).map((b): JourneyBranch => {
      const rule = branchRules[b.id];
      if (rule) {
        if (alreadyApplied(b, rule)) return b; // idempotent
        changes.push({ kind: "branch_rewritten", nodeId: n.id, branchId: b.id, after: rule });
        return {
          id: b.id,
          ...(b.label !== undefined ? { label: b.label } : {}),
          ...(rule.match ? { match: rule.match } : {}),
          conditions: rule.conditions,
          // legacy `condition` intentionally dropped
        };
      }
      // No explicit rule: flag (don't touch) any branch with an unknown field.
      const rules = b.conditions ?? (b.condition ? [b.condition] : []);
      for (const r of rules) {
        if (!CONDITION_FIELD_BY_KEY.has(r.field)) {
          changes.push({
            kind: "warning",
            nodeId: n.id,
            branchId: b.id,
            message: `branch references unknown field "${r.field}" and has no provided rule — left unchanged`,
          });
        }
      }
      return b;
    });
    return { ...n, data: { ...n.data, branches } };
  });

  // 2. Ensure every condition node has a wired "default" else-edge.
  const edges: JourneyEdge[] = [...graph.edges];
  for (const n of nodes) {
    if (n.type !== "condition") continue;
    const hasDefault = edges.some(
      (e) => e.source === n.id && (e.sourceHandle ?? null) === DEFAULT_BRANCH,
    );
    if (hasDefault) continue;
    const target = defaultTargets[n.id] ?? inferDefaultTarget(n.id, edges);
    if (!target) {
      changes.push({
        kind: "warning",
        nodeId: n.id,
        message: `no default-edge target provided or inferable — condition still has no "default" edge`,
      });
      continue;
    }
    const edgeId = `edge_default_${n.id}`;
    edges.push({ id: edgeId, source: n.id, target, sourceHandle: DEFAULT_BRANCH });
    changes.push({ kind: "default_edge_added", nodeId: n.id, edgeId, target });
  }

  return { graph: { nodes, edges }, changes };
}

/**
 * Fallback "default" target when one isn't supplied: the target of the most
 * catch-all-looking branch edge (handle mentions none / no-referral / no-voice),
 * else the last outgoing branch edge's target.
 */
function inferDefaultTarget(nodeId: string, edges: JourneyEdge[]): string | undefined {
  const outs = edges.filter(
    (e) => e.source === nodeId && (e.sourceHandle ?? null) !== DEFAULT_BRANCH,
  );
  if (outs.length === 0) return undefined;
  const catchAll = outs.find((e) =>
    /none|no.?_?vc|no.?_?ref|no.?_?voice/i.test(String(e.sourceHandle ?? "")),
  );
  return (catchAll ?? outs[outs.length - 1]!).target;
}
