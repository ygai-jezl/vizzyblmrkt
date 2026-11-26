import { randomUUID } from "node:crypto";
import { transitionAgentAction, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { readBrandMap } from "@/lib/brandMap/store";
import { BRAND_KIT_MAP_ROUTE } from "@/lib/content/brandKit";
import { pageAgentActions } from "@/lib/ontology/agentActions";
import type { EventActor } from "@/lib/ontology/events";
import type { AgentAction } from "@/lib/types/agentAction";
import { keyHash } from "./fingerprints";
import { actAsSystem, closeAsSystem, MAX_RUN_KEYS, recordDraft, type RecordDeps, type RecordOutcome } from "./record";
import { RECORD_SYSTEM } from "./sources";

/**
 * Agent record (ADR-0026), the brand map: one record per research run or Vizzy chat call
 * (decision 5), with a hash of each key it filed on the map's suggestions and the ids of the
 * proposals it made on the map's records. It closes from the map's own lists, never by a hook in
 * each of the screens that accept or dismiss:
 * - none of its keys still waiting: acted if any were accepted, dismissed if all went to the map's
 *   dismissed list;
 * - a newer research run replaces research's waiting suggestions, so it closes the run before
 *   first: superseded when nothing was accepted or dismissed.
 * A key that left the suggestions without being dismissed was accepted (research replaces only its
 * own, and closes its last run first). A proposal that is gone was withdrawn: stale.
 */

export type MapRunAction = "brand_map.suggest" | "brand_map.research";

/** How a run's suggestions stand on the map now. */
export interface RunState {
  waiting: number;
  kept: number;
  dismissed: number;
  /** Proposals withdrawn from the records (gone without a decision). */
  gone: number;
}

const REF = /^(sub|q|sit):([A-Za-z0-9_.-]{1,120})$/;

/**
 * Record a run's suggestions, when it filed any. `keys` are the suggestions' keys as filed (hashed
 * here: a key can hold a name); `refs` the proposals, as `sub:<id>`, `q:<id>` or `sit:<id>`.
 */
export async function recordMapRun(
  ctx: TenantContext,
  input: { action: MapRunAction; keys: readonly string[]; refs: readonly string[]; requestedBy?: EventActor },
  deps: RecordDeps = {},
): Promise<RecordOutcome | "none"> {
  const keys = input.keys.map(keyHash);
  const refs = input.refs.filter((r) => REF.test(r));
  if (!keys.length && !refs.length) return "none";
  return recordDraft(
    ctx,
    {
      action: input.action,
      // Each run is a draft of its own: two runs are open side by side until the map decides them.
      draft: { kind: "brand_map", ref: `run_${randomUUID().replace(/-/g, "").slice(0, 20)}` },
      href: BRAND_KIT_MAP_ROUTE,
      keys: keys.slice(0, MAX_RUN_KEYS),
      refs: refs.slice(0, MAX_RUN_KEYS - Math.min(keys.length, MAX_RUN_KEYS)),
      ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
    },
    deps,
  );
}

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The map's lists, read once for every run checked. */
export interface MapLists {
  waiting: Set<string>;
  dismissed: Set<string>;
}

export async function readMapLists(ctx: TenantContext, db?: FirestoreLike): Promise<MapLists | null> {
  const read = await readBrandMap(ctx, db);
  if (read.state === "unreadable") return null;
  const map = read.state === "ok" ? read.map : { suggestions: [], dismissed: [] };
  return { waiting: new Set(map.suggestions.map((s) => keyHash(s.key))), dismissed: new Set(map.dismissed.map(keyHash)) };
}

/** Where a run's suggestions stand: its keys against the map's lists, its proposals by record. */
export async function runState(ctx: TenantContext, a: AgentAction, lists: MapLists, db?: FirestoreLike): Promise<RunState> {
  const s: RunState = { waiting: 0, kept: 0, dismissed: 0, gone: 0 };
  for (const k of listOf(a.proposal?.keys)) {
    if (lists.waiting.has(k)) s.waiting += 1;
    else if (lists.dismissed.has(k)) s.dismissed += 1;
    else s.kept += 1;
  }
  const store = brandMapRecords(ctx, db);
  for (const r of listOf(a.proposal?.refs)) {
    const m = REF.exec(r);
    if (!m) continue;
    const rec = await store.get(m[1] as "sub" | "q" | "sit", m[2]!).catch(() => null);
    const status = rec?.status;
    if (!rec) s.gone += 1;
    else if (status === "proposed") s.waiting += 1;
    else if (status === "dismissed") s.dismissed += 1;
    else s.kept += 1;
  }
  return s;
}

export type RunVerdict = { to: "acted"; result: { kept: number; dismissed: number } } | { to: "declined"; reason: "dismissed" | "superseded" | "stale" } | null;

/**
 * The closing rule. `replacing`: a newer research run is about to replace the waiting ones. Null
 * while any still wait (and nothing replaces them).
 */
export function runVerdict(s: RunState, replacing = false): RunVerdict {
  if (s.waiting > 0 && !replacing) return null;
  if (s.kept > 0) return { to: "acted", result: { kept: s.kept, dismissed: s.dismissed } };
  if (s.dismissed > 0 && s.waiting === 0) return { to: "declined", reason: "dismissed" };
  if (replacing && s.waiting > 0) return { to: "declined", reason: "superseded" };
  return { to: "declined", reason: "stale" };
}

/** Close one run by the rule, as the system. True when it closed. Never throws. */
export async function closeMapRun(ctx: TenantContext, a: AgentAction, lists: MapLists, deps: RecordDeps & { replacing?: boolean } = {}): Promise<boolean> {
  try {
    const verdict = runVerdict(await runState(ctx, a, lists, deps.db), deps.replacing);
    if (!verdict) return false;
    if (verdict.to === "acted") return actAsSystem(ctx, a, verdict.result, deps);
    if (verdict.reason === "dismissed") {
      // Everything went to the map's dismissed list: a person's no, decided on the map.
      const at = new Date(deps.nowMs ?? Date.now()).toISOString();
      const r = await transitionAgentAction(ctx, a.id, { to: "declined", reason: "dismissed", by: RECORD_SYSTEM, at, expectRev: a.rev, clearDetails: true }, { db: deps.db });
      return r.ok;
    }
    return closeAsSystem(ctx, a, verdict.reason, deps);
  } catch (err) {
    console.warn("[agent-record] write_failed close map run:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return false;
  }
}

/** This brand's open runs of one action, a few pages in id order (equality only). */
export async function openRuns(ctx: TenantContext, action: MapRunAction, db?: FirestoreLike): Promise<AgentAction[]> {
  const out: AgentAction[] = [];
  let after: string | null = null;
  for (let page = 0; page < 4; page++) {
    const r = await pageAgentActions(ctx, { action, state: "proposed" }, { after, limit: 50, db });
    out.push(...r.actions);
    if (!r.more) break;
    after = r.last;
  }
  return out;
}

/**
 * Before a research run files (and replaces research's waiting suggestions): the research runs
 * still open close by the rule, the waiting ones counting as replaced. Never throws.
 */
export async function closeResearchBefore(ctx: TenantContext, deps: RecordDeps = {}): Promise<number> {
  try {
    const open = await openRuns(ctx, "brand_map.research", deps.db);
    if (!open.length) return 0;
    const lists = await readMapLists(ctx, deps.db);
    if (!lists) return 0;
    let closed = 0;
    for (const a of open) if (await closeMapRun(ctx, a, lists, { ...deps, replacing: true })) closed += 1;
    return closed;
  } catch (err) {
    console.warn("[agent-record] write_failed close research runs:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return 0;
  }
}
