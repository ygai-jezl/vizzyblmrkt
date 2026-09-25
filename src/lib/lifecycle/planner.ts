import type { ConnectionCatalog, ConsentBasis } from "@/lib/types/productConnection";
import type {
  ContentPool,
  LifecycleGraph,
  PoolItem,
  SendPolicy,
  SentItem,
} from "@/lib/types/lifecycle";
import type { ProductContext } from "@/lib/connect/protocol";
import { findTrigger, nextNodeId, nodeMap } from "./graph";
import { selectLifecycleBranch, type RecipientContext } from "./fields";
import { pickPoolItem } from "./pools";
import { isInSendWindow, nextWindowAt, scheduleAfterWait } from "./sendWindow";

/**
 * The lifecycle WALK — one pure decision function shared by the runner and the
 * timeline preview, so what the preview shows is exactly what the runner does.
 *
 * `decideNext` moves the cursor through triggers, conditions and exhausted pools
 * until it reaches something with a time or a side effect: a future run time (a
 * wait, or the recipient's next send window), an email to send, an exit, or the
 * end. Consent, caps and approvals are the runner's business on top of this.
 */

const DAY_MS = 86_400_000;
const MAX_HOPS = 25;

export interface WalkState {
  cursor: string | null;
  nowMs: number;
  anchorMs: number;
  lastSentMs: number | null;
  windowExemptUntilMs: number | null;
  sent: Array<Pick<SentItem, "poolId" | "itemId" | "status">>;
}

export interface WalkEnv {
  graph: LifecycleGraph;
  pools: ContentPool[];
  policy: SendPolicy;
  tz: string;
  offsetMin: number;
  /** The recipient's context at a moment (stored profile + any live context). */
  recipientAt: (nowMs: number) => RecipientContext;
  /** Pool items (`poolId:itemId`) not to pick in this walk (see pickPoolItem). */
  excluded?: ReadonlySet<string>;
  /**
   * Picks what an email node sends, instead of the first unsent eligible item
   * (waitlist journeys: the person's A/B arm). Null = nothing left to send.
   */
  pickItem?: (a: {
    nodeId: string;
    pool: ContentPool;
    sent: WalkState["sent"];
    rc: RecipientContext;
    excluded?: ReadonlySet<string>;
  }) => PoolItem | null;
}

export type Decision =
  | { kind: "run_at"; runAtMs: number; reason: "wait" | "window" }
  | { kind: "send"; nodeId: string; pool: ContentPool; item: PoolItem; nextCursor: string | null }
  | { kind: "exit"; reason: string }
  /** `nodeId`: the exit node reached (absent when the path simply ended). */
  | { kind: "complete"; nodeId?: string };

export interface WalkResult {
  decision: Decision;
  /** State with the cursor moved (for run_at: the node to resume at). */
  state: WalkState;
  /** Email nodes passed over because their pool had nothing left for this user. */
  skipped: Array<{ nodeId: string; poolId: string }>;
}

export function decideNext(start: WalkState, env: WalkEnv): WalkResult {
  const state: WalkState = { ...start, sent: [...start.sent] };
  const byId = nodeMap(env.graph);
  const skipped: WalkResult["skipped"] = [];
  const hardStopMs = env.policy.hardStopDays === null ? Infinity : state.anchorMs + env.policy.hardStopDays * DAY_MS;

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    if (state.nowMs > hardStopMs) return { decision: { kind: "exit", reason: "hard_stop" }, state, skipped };
    if (state.cursor === null) return { decision: { kind: "complete" }, state, skipped };
    const node = byId.get(state.cursor);
    if (!node) return { decision: { kind: "exit", reason: "dead_end" }, state, skipped };

    switch (node.type) {
      case "trigger":
        state.cursor = nextNodeId(env.graph, node.id);
        continue;
      case "exit":
        return { decision: { kind: "complete", nodeId: node.id }, state, skipped };
      case "condition": {
        const handle = selectLifecycleBranch(node.data.branches, env.recipientAt(state.nowMs));
        state.cursor = nextNodeId(env.graph, node.id, handle);
        continue;
      }
      case "wait": {
        const next = nextNodeId(env.graph, node.id);
        if (!node.data.wait) {
          state.cursor = next;
          continue;
        }
        const s = scheduleAfterWait({
          wait: node.data.wait,
          anchorMs: state.anchorMs,
          lastSentMs: state.lastSentMs,
          nowMs: state.nowMs,
          tz: env.tz,
          policy: env.policy,
          offsetMin: env.offsetMin,
        });
        state.cursor = next;
        state.windowExemptUntilMs = s.windowExemptUntilMs;
        if (s.runAtMs > state.nowMs) {
          if (s.runAtMs > hardStopMs) return { decision: { kind: "exit", reason: "hard_stop" }, state, skipped };
          return { decision: { kind: "run_at", runAtMs: s.runAtMs, reason: "wait" }, state, skipped };
        }
        continue;
      }
      case "email": {
        const exempt = state.windowExemptUntilMs !== null && state.nowMs <= state.windowExemptUntilMs;
        if (!exempt && !isInSendWindow(state.nowMs, env.tz, env.policy, env.offsetMin)) {
          state.windowExemptUntilMs = null;
          const runAtMs = nextWindowAt(state.nowMs, env.tz, env.policy, env.offsetMin);
          if (runAtMs > hardStopMs) return { decision: { kind: "exit", reason: "hard_stop" }, state, skipped };
          return { decision: { kind: "run_at", runAtMs, reason: "window" }, state, skipped };
        }
        const pool = env.pools.find((p) => p.id === node.data.poolId);
        const item = !pool
          ? null
          : env.pickItem
            ? env.pickItem({ nodeId: node.id, pool, sent: state.sent, rc: env.recipientAt(state.nowMs), excluded: env.excluded })
            : pickPoolItem(pool, state.sent, env.recipientAt(state.nowMs), env.excluded);
        const after = nextNodeId(env.graph, node.id);
        if (!pool || !item) {
          skipped.push({ nodeId: node.id, poolId: node.data.poolId ?? "" });
          state.cursor = after;
          continue;
        }
        return { decision: { kind: "send", nodeId: node.id, pool, item, nextCursor: after }, state, skipped };
      }
    }
  }
  return { decision: { kind: "exit", reason: "too_many_hops" }, state, skipped };
}

/** Apply a completed send to the walk state (the runner and the planner both do this). */
export function afterSend(state: WalkState, d: Extract<Decision, { kind: "send" }>, atMs: number, status: "sent" | "unknown"): WalkState {
  return {
    ...state,
    cursor: d.nextCursor,
    lastSentMs: atMs,
    windowExemptUntilMs: null,
    sent: [...state.sent, { poolId: d.pool.id, itemId: d.item.id, status }],
  };
}

/** An email that was deliberately not sent (e.g. staff skipped it): move on without it. */
export function afterSkip(state: WalkState, d: Extract<Decision, { kind: "send" }>): WalkState {
  return {
    ...state,
    cursor: d.nextCursor,
    windowExemptUntilMs: null,
    sent: [...state.sent, { poolId: d.pool.id, itemId: d.item.id, status: "skipped" }],
  };
}

/** The first node after the trigger — where a new enrolment starts. */
export function entryCursor(graph: LifecycleGraph): string | null {
  const trigger = findTrigger(graph);
  return trigger ? nextNodeId(graph, trigger.id) : null;
}

// ---- Timeline preview (dry run) ----------------------------------------------------------

export interface PlanScenario {
  anchorMs: number;
  tz: string;
  offsetMin: number;
  /** Step id → when the user completes it; absent = never. */
  stepsDoneAt?: Record<string, number>;
  /** Facts the product would return (enables fact.* conditions in the preview). */
  facts?: Record<string, string | number | boolean>;
  traits?: Record<string, string | number | boolean | null>;
  consentBasis?: ConsentBasis;
  /** The bases the connection accepts for marketing: given, marketing emails without one show as skipped. */
  marketingBases?: ConsentBasis[];
}

export interface PlannedStep {
  atMs: number;
  kind: "send" | "skip" | "exit" | "complete";
  nodeId?: string;
  poolId?: string;
  itemId?: string;
  label: string;
}

/** Simulate one recipient through a journey — what the runner WOULD do. */
export function planTimeline(
  draft: { graph: LifecycleGraph; pools: ContentPool[]; policy: SendPolicy },
  catalog: ConnectionCatalog,
  scenario: PlanScenario,
): PlannedStep[] {
  const steps = [...catalog.onboardingSteps].sort((a, b) => a.order - b.order);
  const recipientAt = (nowMs: number): RecipientContext => {
    const done = (id: string) => (scenario.stepsDoneAt?.[id] ?? Infinity) <= nowMs;
    const context: ProductContext | null = scenario.facts
      ? {
          asOf: new Date(nowMs).toISOString(),
          steps: steps.map((s) => ({ id: s.id, label: s.label, done: done(s.id), url: s.url ?? null })),
          nextStep: null,
          facts: Object.entries(scenario.facts).map(([id, value]) => ({ id, label: id, value })),
          insights: [],
        }
      : null;
    return {
      user: {
        traits: scenario.traits ?? {},
        steps: Object.fromEntries(steps.filter((s) => done(s.id)).map((s) => [s.id, { doneAt: "" }])),
        milestones: {},
        consent: { basis: scenario.consentBasis ?? "consent", at: "" },
      },
      catalog,
      context,
      emailsSent: 0,
      enrolledAtMs: scenario.anchorMs,
      nowMs,
    };
  };
  const env: WalkEnv = {
    graph: draft.graph,
    pools: draft.pools,
    policy: draft.policy,
    tz: scenario.tz,
    offsetMin: scenario.offsetMin,
    recipientAt,
  };

  const out: PlannedStep[] = [];
  let state: WalkState = {
    cursor: entryCursor(draft.graph),
    nowMs: scenario.anchorMs,
    anchorMs: scenario.anchorMs,
    lastSentMs: null,
    windowExemptUntilMs: null,
    sent: [],
  };
  for (let i = 0; i < 60; i += 1) {
    const r = decideNext(state, env);
    for (const s of r.skipped) out.push({ atMs: r.state.nowMs, kind: "skip", nodeId: s.nodeId, poolId: s.poolId, label: "Nothing left to send" });
    const d = r.decision;
    if (d.kind === "run_at") {
      state = { ...r.state, nowMs: d.runAtMs };
      continue;
    }
    if (d.kind === "send") {
      const basis = scenario.consentBasis ?? "consent";
      if (scenario.marketingBases && d.item.messageClass === "marketing" && !scenario.marketingBases.includes(basis)) {
        out.push({ atMs: r.state.nowMs, kind: "skip", nodeId: d.nodeId, poolId: d.pool.id, itemId: d.item.id, label: `${d.item.label}: no marketing consent` });
        state = afterSkip(r.state, d);
        continue;
      }
      out.push({ atMs: r.state.nowMs, kind: "send", nodeId: d.nodeId, poolId: d.pool.id, itemId: d.item.id, label: d.item.label });
      state = afterSend(r.state, d, r.state.nowMs, "sent");
      continue;
    }
    out.push({ atMs: r.state.nowMs, kind: d.kind, label: d.kind === "exit" ? `Stopped: ${d.reason}` : "Journey complete" });
    break;
  }
  return out;
}
