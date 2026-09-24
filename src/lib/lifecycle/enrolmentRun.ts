import type { TenantCollection } from "@/lib/tenant/repository";
import type { DeliveryMode, EnrolmentRuntime, LifecycleVersion, SentItem } from "@/lib/types/lifecycle";
import { afterSend, afterSkip, type Decision, type WalkResult, type WalkState } from "./planner";
import { nextNodeId } from "./graph";

/**
 * The per-enrolment machinery every lifecycle audience shares — product users
 * (runner.ts) and waitlist signups (waitlist/runner.ts):
 *
 *   lease → [the audience's gates] → walk loop → [the audience's delivery] → commit
 *
 * Exactly-once-or-never: a send is claimed (`pendingSend`) before the provider
 * call. If the process dies before the commit, the next lease records it as
 * `unknown` and moves on — it is never resent. At most one email per run.
 */

export const DAY_MS = 86_400_000;
const LEASE_MS = 3 * 60_000;
export const MAX_FAILURES = 8;
const MAX_LOG = 40;

export type EnrolmentRunOutcome =
  | "not_due"
  | "waiting"
  | "held"
  | "sent"
  | "completed"
  | "exited"
  | "failed"
  | "lost_lease";

type RuntimeDoc = Omit<EnrolmentRuntime, "id" | "tenantId">;
type LogEntry = EnrolmentRuntime["log"][number];
type Patch<E extends EnrolmentRuntime> = Partial<Omit<E, "id" | "tenantId">>;

export const iso = (ms: number) => new Date(ms).toISOString();
export const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));
export const cursorOf = (nodeId: string | null) => (nodeId ? { nodeId } : null);

export function withLog(log: LogEntry[], entries: LogEntry[]): LogEntry[] {
  const out = [...log];
  for (const e of entries) {
    const last = out[out.length - 1];
    // A repeated hold (paused journey, waiting for consent…) is logged once.
    if (last && last.event === e.event && (last.detail ?? null) === (e.detail ?? null)) continue;
    out.push(e);
  }
  return out.slice(-MAX_LOG);
}

export function backoffMs(failures: number): number {
  return Math.min(5 * 60_000 * 2 ** Math.max(0, failures - 1), 6 * 3600_000);
}

export function nextUtcMidnight(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS + DAY_MS;
}

/**
 * Lease one due enrolment, single-flight across overlapping ticks. A send that
 * started but never finished has an unknown outcome: it's recorded as such and
 * NEVER resent. Null = not due, or leased elsewhere.
 */
export async function leaseEnrolment<E extends EnrolmentRuntime>(
  repo: TenantCollection<E>,
  enrolmentId: string,
  a: { nowMs: number; leaseId: string; version: Pick<LifecycleVersion, "graph"> | null },
): Promise<E | null> {
  const nowIso = iso(a.nowMs);
  return repo.claim(enrolmentId, (cur) => {
    if (cur.status !== "active" || !cur.nextRunAt || cur.nextRunAt > nowIso) return null;
    if (cur.leaseUntil && cur.leaseUntil > nowIso) return null;
    const patch: Partial<RuntimeDoc> = { leaseId: a.leaseId, leaseUntil: iso(a.nowMs + LEASE_MS) };
    const p = cur.pendingSend;
    if (p) {
      patch.sentItems = [
        ...cur.sentItems,
        { nodeId: p.nodeId, poolId: p.poolId, itemId: p.itemId, at: p.at, status: "unknown" as const, mode: cur.mode, reason: "interrupted" },
      ].slice(-60);
      patch.pendingSend = null;
      patch.lastSentAt = p.at;
      patch.windowExemptUntil = null;
      if (a.version) patch.cursor = cursorOf(nextNodeId(a.version.graph, p.nodeId));
      patch.log = withLog(cur.log, [{ at: nowIso, event: "send_unknown", detail: `${p.poolId}/${p.itemId}: interrupted` }]);
    }
    return patch as Patch<E>;
  });
}

/** One leased run: its log, and the ways it can end. `X`: the audience's own enrolment fields. */
export interface EnrolmentRun<X = object> {
  readonly nowMs: number;
  log(event: string, detail?: string | null): void;
  /** Write the run's outcome and release the lease (only if we still hold it). */
  commit(patch: Partial<RuntimeDoc> & Partial<X>): Promise<boolean>;
  /** Finish the enrolment early (exited), or completed. */
  stop(reason: string, status?: "exited" | "completed"): Promise<EnrolmentRunOutcome>;
  /** Run again at `untilMs`, from where this run started. */
  hold(untilMs: number, event: string, detail?: string): Promise<EnrolmentRunOutcome>;
  /** A run that threw: back off, or exit after MAX_FAILURES. */
  fail(err: unknown, failuresSoFar: number): Promise<EnrolmentRunOutcome>;
}

export function openRun<E extends EnrolmentRuntime>(
  repo: TenantCollection<E>,
  enrolmentId: string,
  a: {
    leaseId: string;
    nowMs: number;
    clock: () => number;
    /** Label for error logs, e.g. `${tenantId}/${enrolmentId}`. */
    label: string;
    /** After the enrolment finished (stopped, completed or exited). */
    onFinished?: () => Promise<unknown>;
  },
): EnrolmentRun<Omit<E, keyof EnrolmentRuntime>> {
  const nowIso = iso(a.nowMs);
  const pendingLog: LogEntry[] = [];
  const log = (event: string, detail?: string | null) =>
    pendingLog.push({ at: nowIso, event: event.slice(0, 80), detail: detail ? detail.slice(0, 300) : null });
  const commit = async (patch: Partial<RuntimeDoc> & Record<string, unknown>): Promise<boolean> => {
    const done = await repo.claim(enrolmentId, (cur) => {
      if (cur.leaseId !== a.leaseId) return null;
      return { ...patch, log: withLog(cur.log, pendingLog), leaseId: null, leaseUntil: null, updatedAt: iso(a.clock()) } as Patch<E>;
    });
    return done !== null;
  };
  const stop = async (reason: string, status: "exited" | "completed" = "exited"): Promise<EnrolmentRunOutcome> => {
    log(status === "completed" ? "completed" : "stopped", status === "completed" ? null : reason);
    const ok = await commit({
      status,
      stopReason: status === "completed" ? null : reason.slice(0, 120),
      cursor: null,
      nextRunAt: null,
      pendingSend: null,
    });
    if (ok) await a.onFinished?.();
    return ok ? status : "lost_lease";
  };
  const hold = async (untilMs: number, event: string, detail?: string): Promise<EnrolmentRunOutcome> => {
    log(event, detail);
    return (await commit({ nextRunAt: iso(untilMs), failures: 0 })) ? "held" : "lost_lease";
  };
  const fail = async (err: unknown, failuresSoFar: number): Promise<EnrolmentRunOutcome> => {
    const m = err instanceof Error ? err.message.slice(0, 200) : "error";
    console.error(`[lifecycle] run failed ${a.label}: ${m}`);
    log("run_failed", m);
    const failures = failuresSoFar + 1;
    if (failures >= MAX_FAILURES) {
      return (await commit({ status: "exited", stopReason: "run_failed", cursor: null, nextRunAt: null }).catch(() => false))
        ? "exited"
        : "lost_lease";
    }
    const ok = await commit({ failures, nextRunAt: iso(a.nowMs + backoffMs(failures)) }).catch(() => false);
    return ok ? "failed" : "lost_lease";
  };
  // The audience's own fields (e.g. a waitlist enrolment's hold) are typed at the edge.
  return { nowMs: a.nowMs, log, commit: commit as EnrolmentRun<Omit<E, keyof EnrolmentRuntime>>["commit"], stop, hold, fail };
}

export type SendDecision = Extract<Decision, { kind: "send" }>;

/** What delivering one email came to. */
export type DeliverResult =
  | {
      kind: "sent";
      status: "sent" | "unknown";
      reason: string | null;
      insightId: string | null;
      atMs: number;
      version?: "standard" | "ai" | "fallback";
    }
  | { kind: "skipped"; reason: string }
  | { kind: "hold"; untilMs: number; event: string; detail?: string }
  | { kind: "exclude"; reason: string }
  | { kind: "exit"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "lost_lease" };

export interface WalkLoopHooks {
  /** The enrolment as leased. */
  enrolment: Pick<EnrolmentRuntime, "sentItems" | "usedInsightIds" | "lastSentAt" | "failures">;
  mode: DeliveryMode;
  /** Pool items the walk must not pick again this run (their email couldn't be rendered). */
  excluded: Set<string>;
  clock: () => number;
  /** Walk on from a state, with the audience's environment. */
  walk: (state: WalkState) => WalkResult;
  deliver: (d: SendDecision, state: WalkState, usedInsightIds: string[]) => Promise<DeliverResult>;
  /** A wait was booked until `runAtMs` (and committed). */
  onWaitBooked?: (state: WalkState, runAtMs: number) => Promise<void>;
  /** The path reached its end or an exit node — runs BEFORE the commit (a throw fails the run). */
  beforeComplete?: (d: Extract<Decision, { kind: "complete" }>) => Promise<void>;
  /** After the enrolment finished (completed or exited). */
  onFinished?: () => Promise<unknown>;
}

/**
 * Follow the walk from `first` until the run has something to wait for: a
 * future run time, the end, or a hold. At most one email is sent per run.
 */
export async function runWalkLoop(run: EnrolmentRun, first: WalkResult, h: WalkLoopHooks): Promise<EnrolmentRunOutcome> {
  const { log, commit, stop, hold } = run;
  let walk = first;
  let state = first.state;
  const sentItems: SentItem[] = [...h.enrolment.sentItems];
  const usedInsightIds = [...h.enrolment.usedInsightIds];
  let lastSentAt = h.enrolment.lastSentAt ?? null;
  let sentOne = false;
  const progress = () => ({
    sentItems: sentItems.slice(-60),
    usedInsightIds: usedInsightIds.slice(-60),
    lastSentAt,
    pendingSend: null,
    failures: 0,
  });

  for (let guard = 0; guard < 12; guard += 1) {
    for (const s of walk.skipped) log("nothing_to_send", `${s.nodeId} (${s.poolId})`);
    const d: Decision = walk.decision;
    state = walk.state;

    if (d.kind === "run_at") {
      const ok = await commit({
        ...progress(),
        cursor: cursorOf(state.cursor),
        nextRunAt: iso(d.runAtMs),
        windowExemptUntil: isoOrNull(state.windowExemptUntilMs),
      });
      if (ok && d.reason === "wait") await h.onWaitBooked?.(state, d.runAtMs);
      return ok ? (sentOne ? "sent" : "waiting") : "lost_lease";
    }
    if (d.kind === "complete" || d.kind === "exit") {
      if (d.kind === "complete") await h.beforeComplete?.(d);
      log(d.kind === "complete" ? "completed" : "stopped", d.kind === "exit" ? d.reason : null);
      const ok = await commit({
        ...progress(),
        status: d.kind === "complete" ? "completed" : "exited",
        stopReason: d.kind === "exit" ? d.reason : null,
        cursor: null,
        nextRunAt: null,
      });
      if (ok) await h.onFinished?.();
      return ok ? (sentOne ? "sent" : d.kind === "complete" ? "completed" : "exited") : "lost_lease";
    }

    // An email is due.
    if (sentOne) {
      // One email per run; the next one goes on the next tick.
      const ok = await commit({
        ...progress(),
        cursor: cursorOf(state.cursor),
        nextRunAt: iso(h.clock() + 60_000),
        windowExemptUntil: isoOrNull(state.windowExemptUntilMs),
      });
      return ok ? "sent" : "lost_lease";
    }
    const r = await h.deliver(d, state, usedInsightIds);
    switch (r.kind) {
      case "lost_lease":
        return "lost_lease";
      case "exit":
        return await stop(r.reason);
      case "hold":
        // Resume from where this run started, so conditions are re-checked
        // against fresh context next time.
        return await hold(r.untilMs, r.event, r.detail);
      case "exclude":
        h.excluded.add(`${d.pool.id}:${d.item.id}`);
        log("item_skipped", `${d.item.id}: ${r.reason}`);
        walk = h.walk(state);
        continue;
      case "failed": {
        log("send_failed", r.reason);
        const failures = h.enrolment.failures + 1;
        if (failures >= MAX_FAILURES) return await stop("send_failed");
        const ok = await commit({ pendingSend: null, failures, nextRunAt: iso(run.nowMs + backoffMs(failures)) });
        return ok ? "failed" : "lost_lease";
      }
      case "skipped":
        sentItems.push({
          nodeId: d.nodeId,
          poolId: d.pool.id,
          itemId: d.item.id,
          at: iso(h.clock()),
          status: "skipped",
          mode: h.mode,
          reason: r.reason,
        });
        log("email_skipped", `${d.item.label}: ${r.reason.replace(/_/g, " ")}`);
        state = afterSkip(state, d);
        walk = h.walk(state);
        continue;
      case "sent": {
        sentItems.push({
          nodeId: d.nodeId,
          poolId: d.pool.id,
          itemId: d.item.id,
          at: iso(r.atMs),
          status: r.status,
          mode: h.mode,
          reason: r.reason,
          ...(r.version ? { version: r.version } : {}),
        });
        if (r.insightId) usedInsightIds.push(r.insightId);
        lastSentAt = iso(r.atMs);
        log(r.status === "sent" ? "sent" : "send_unknown", `${d.item.label} (${h.mode})${r.reason ? ` · ${r.reason}` : ""}`);
        sentOne = true;
        state = afterSend(state, d, r.atMs, r.status);
        walk = h.walk(state);
        continue;
      }
    }
  }
  log("stopped", "too_many_steps");
  return (await commit({ ...progress(), status: "exited", stopReason: "too_many_steps", cursor: null, nextRunAt: null }))
    ? "exited"
    : "lost_lease";
}
