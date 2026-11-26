import { randomUUID } from "node:crypto";
import { transitionAgentAction, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { readBrandMap } from "@/lib/brandMap/store";
import { BRAND_KIT_MAP_ROUTE } from "@/lib/content/brandKit";
import { pageAgentActions } from "@/lib/ontology/agentActions";
import type { EventActor } from "@/lib/ontology/events";
import type { AgentAction } from "@/lib/types/agentAction";
import { satisfiedKeys } from "@/lib/brandMap/changes";
import { keyHash } from "./fingerprints";
import { actAsSystem, closeAsSystem, MAX_RUN_KEYS, recordDraft, type RecordDeps, type RecordOutcome } from "./record";
import { RECORD_SYSTEM } from "./sources";

/**
 * Agent record (ADR-0026), the brand map: one record per research run or Vizzy chat call
 * (decision 5), with a hash of each key it filed on the map's suggestions and the ids of the
 * proposals it made on the map's records. It closes from the map's own lists, never by a hook in
 * each of the screens that accept or dismiss:
 * - a key is accepted only when the decided map now holds its change (satisfiedKeys), dismissed
 *   when it is on the map's dismissed list, and gone otherwise: the map dropped it on its own (a
 *   source's cap, the size fit, the dismissed list's cap), which is nobody's decision;
 * - none of its keys or proposals still waiting: acted if any were accepted, superseded if a newer
 *   research run replaced some, dismissed if a person dismissed some, else stale;
 * - a newer research run replaces research's waiting suggestions, so it closes the runs before it
 *   first, their waiting keys counted as replaced. A run whose proposals still wait stays open: it
 *   is recorded again without the replaced keys, keeping how many were replaced.
 * A proposal that is gone was withdrawn: gone too.
 */

export type MapRunAction = "brand_map.suggest" | "brand_map.research";

/** How a run's suggestions stand on the map now. */
export interface RunState {
  /** Its suggestions still waiting on the brand's record (research replaces its own). */
  waitingKeys: number;
  /** Its proposals still waiting on the map's records (nothing replaces them). */
  waitingRefs: number;
  /** Accepted: the decided map holds the change, or a proposal was kept. */
  kept: number;
  dismissed: number;
  /** Gone without anyone deciding: dropped by the map, or a proposal withdrawn. */
  gone: number;
  /** Replaced by a newer research run while the run waited (kept on the record). */
  replaced: number;
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

/** The map's lists, read once for every run checked, each key hashed as the record holds it. */
export interface MapLists {
  waiting: Set<string>;
  dismissed: Set<string>;
  /** The keys of the changes the decided map holds. */
  accepted: Set<string>;
}

export async function readMapLists(ctx: TenantContext, db?: FirestoreLike): Promise<MapLists | null> {
  const read = await readBrandMap(ctx, db);
  if (read.state === "unreadable") return null;
  if (read.state === "none") return { waiting: new Set(), dismissed: new Set(), accepted: new Set() };
  const map = read.map;
  return {
    waiting: new Set(map.suggestions.map((s) => keyHash(s.key))),
    dismissed: new Set(map.dismissed.map(keyHash)),
    accepted: new Set([...satisfiedKeys(map)].map(keyHash)),
  };
}

/** Where a run's suggestions stand: its keys against the map's lists, its proposals by record. */
export async function runState(ctx: TenantContext, a: AgentAction, lists: MapLists, db?: FirestoreLike): Promise<RunState> {
  const replaced = typeof a.proposal?.replaced === "number" ? a.proposal.replaced : 0;
  const s: RunState = { waitingKeys: 0, waitingRefs: 0, kept: 0, dismissed: 0, gone: 0, replaced };
  for (const k of listOf(a.proposal?.keys)) {
    if (lists.waiting.has(k)) s.waitingKeys += 1;
    else if (lists.dismissed.has(k)) s.dismissed += 1;
    else if (lists.accepted.has(k)) s.kept += 1;
    // Left the suggestions with nobody accepting or dismissing it: the map dropped it.
    else s.gone += 1;
  }
  const store = brandMapRecords(ctx, db);
  for (const r of listOf(a.proposal?.refs)) {
    const m = REF.exec(r);
    if (!m) continue;
    const rec = await store.get(m[1] as "sub" | "q" | "sit", m[2]!).catch(() => null);
    const status = rec?.status;
    if (!rec) s.gone += 1;
    else if (status === "proposed") s.waitingRefs += 1;
    else if (status === "dismissed") s.dismissed += 1;
    else s.kept += 1;
  }
  return s;
}

export type RunVerdict = { to: "acted"; result: { kept: number; dismissed: number } } | { to: "declined"; reason: "dismissed" | "superseded" | "stale" } | null;

/**
 * The closing rule. `replacing`: a newer research run is about to replace the suggestions still
 * waiting on the brand's record (never the proposals on the map's records), so they count as
 * replaced. Null while any still wait and nothing replaces them.
 */
export function runVerdict(s: RunState, replacing = false): RunVerdict {
  if (s.waitingRefs > 0 || (s.waitingKeys > 0 && !replacing)) return null;
  if (s.kept > 0) return { to: "acted", result: { kept: s.kept, dismissed: s.dismissed } };
  if (s.replaced > 0 || s.waitingKeys > 0) return { to: "declined", reason: "superseded" };
  if (s.dismissed > 0) return { to: "declined", reason: "dismissed" };
  return { to: "declined", reason: "stale" };
}

/** Close one run by the rule, as the system. True when it closed. Never throws. */
export async function closeMapRun(ctx: TenantContext, a: AgentAction, lists: MapLists, deps: RecordDeps = {}): Promise<boolean> {
  try {
    return await closeByState(ctx, a, await runState(ctx, a, lists, deps.db), deps);
  } catch (err) {
    console.warn("[agent-record] write_failed close map run:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return false;
  }
}

async function closeByState(ctx: TenantContext, a: AgentAction, state: RunState, deps: RecordDeps & { replacing?: boolean }): Promise<boolean> {
  const verdict = runVerdict(state, deps.replacing);
  if (!verdict) return false;
  if (verdict.to === "acted") return actAsSystem(ctx, a, verdict.result, deps);
  if (verdict.reason === "dismissed") {
    // None accepted and some on the map's dismissed list: a person's no, decided on the map.
    const at = new Date(deps.nowMs ?? Date.now()).toISOString();
    const r = await transitionAgentAction(ctx, a.id, { to: "declined", reason: "dismissed", by: RECORD_SYSTEM, at, expectRev: a.rev, clearDetails: true }, { db: deps.db });
    return r.ok;
  }
  return closeAsSystem(ctx, a, verdict.reason, deps);
}

/**
 * A newer research run is about to replace the suggestions this run still has waiting. With
 * nothing else waiting it closes by the rule. With proposals still waiting on the map's records it
 * stays open, recorded again without the replaced keys and with how many were replaced, so a later
 * close never counts them as accepted. True when it closed.
 */
async function replaceRun(ctx: TenantContext, a: AgentAction, lists: MapLists, deps: RecordDeps): Promise<boolean> {
  const state = await runState(ctx, a, lists, deps.db);
  if (state.waitingRefs === 0) return closeByState(ctx, a, state, { ...deps, replacing: true });
  if (state.waitingKeys === 0 || !a.draft) return false;
  await recordDraft(
    ctx,
    {
      action: a.action as MapRunAction,
      draft: { kind: "brand_map", ref: a.draft.ref },
      href: a.review?.href ?? BRAND_KIT_MAP_ROUTE,
      keys: listOf(a.proposal?.keys).filter((k) => !lists.waiting.has(k)),
      refs: listOf(a.proposal?.refs),
      replaced: state.replaced + state.waitingKeys,
      requestedBy: a.requestedBy,
    },
    deps,
  );
  return false;
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
 * still open close by the rule, the waiting ones counting as replaced, or stay open without them
 * while their proposals wait (replaceRun). Never throws.
 */
export async function closeResearchBefore(ctx: TenantContext, deps: RecordDeps = {}): Promise<number> {
  try {
    const open = await openRuns(ctx, "brand_map.research", deps.db);
    if (!open.length) return 0;
    const lists = await readMapLists(ctx, deps.db);
    if (!lists) return 0;
    let closed = 0;
    for (const a of open) if (await replaceRun(ctx, a, lists, deps)) closed += 1;
    return closed;
  } catch (err) {
    console.warn("[agent-record] write_failed close research runs:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return 0;
  }
}
