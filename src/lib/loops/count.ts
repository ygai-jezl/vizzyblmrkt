import { isoWeekOf } from "@/lib/connectors/period";
import { changedWords } from "@/lib/content/editMeasures";
import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { addToLoopDay, loopDayId, loopDayTtlAt } from "@/lib/tenant/loops";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { LOOP_SIGNALS, type CounterTree, type LoopSignal } from "@/lib/types/loopDay";
import { LoopStampSchema, SCOPE_MAX_CHARS, SCOPE_RE, UNSTAMPED_REASONS, type LoopStamp, type Made, type UnstampedReason } from "@/lib/types/loopStamp";
import { isLoopsEnabled } from "./flags";
import { isImageKind } from "./imageKinds";
import { LEARN_REASONS, type LearnReason } from "./learnLog";
import { isVoteReason } from "./reasons";
import { LOOP_RULES, LOOPS, type LoopKind } from "./registry";
import { STAMP_REFUSALS, type StampRefusal } from "./stamp";

/**
 * The Count step (learning loops step 4, 3.1 of the plan for steps 4 and 5): what happened to the
 * things YouGrow made, added to the brand's week in `loop_days` (src/lib/tenant/loops.ts). Each
 * count is one merged write of increments to one of the week's LOOP_RULES.shards shards, picked
 * at random: never a read, never a transaction, and it never fails the work it counts (the
 * meter's rule), so a count that can't be written is logged and let go.
 *
 * Under the shard's `d`:
 * - `c.<scope>.<kind>.v<v>.<arm>.<signal>`: a made thing's signals, by its stamp. The signals are
 *   LOOP_SIGNALS, plus `liked.<reason>` and `disliked.<reason>` for the why behind a vote (3.11),
 *   keyed by VOTE_REASONS (./reasons.ts), and `declined.<why>` for the why a person gave for
 *   dismissing a suggestion (Work's shared list on agent actions, counted as given). A changed vote
 *   adds a negative amount, so each thing counts once whatever week it moved in.
 * - `t.<type>.made`: made, by ontology type.
 * - `u.<kind>.<reason>`: saved with no stamp, by UNSTAMPED_REASONS, plus `stamp_lost` (a record
 *   lost after its output was used) and `token_<refusal>` (a stamp token a save brought back that
 *   was refused).
 * - `r.<kind>.<outcome>`: what a learner did, `learned` or a LEARN_REASONS refusal.
 * - `k.<kind>.<signal>`: what happened to a learning card.
 * - `o.image.<signal>`: votes on a person's own images (uploads), which no kind made, so they have
 *   no stamp: voted and liked only. The votes learner reads their likes, as every image teaches
 *   the brand look, so a new upload is noticed without reading image rows.
 *
 * Decision 22: image kinds (and the image learner's own loop_learn) count only with
 * IMAGE_STYLE_VERSIONS_ENABLED on; every other kind counts only with LOOPS_ENABLED on (step 5).
 * Notes and words are never counted. Batch senders add up a run's counts in a CountBuffer and
 * write each brand's once, at the end of the run (4.1). Server only.
 */

const KIND_KEY = /^[a-z0-9_]+(?:\.[a-z0-9_]+)?$/;

/** Whether this kind's counts are written at all (decision 22). */
export function countsFor(kind: LoopKind): boolean {
  if (isImageKind(kind) || kind === "loop_learn") return isImageStyleVersionsOn();
  return isLoopsEnabled();
}

/** A made thing's signal, the why behind a vote (`liked.<reason>`, `disliked.<reason>`), or the why behind a dismissal (`declined.<why>`). */
export type CountedSignal = LoopSignal | `liked.${string}` | `disliked.${string}` | `declined.${string}`;

const REASON_SIGNAL = /^(liked|disliked)\.([a-z_]+)$/;

/**
 * The why a person gave for dismissing a suggestion, as a key: Work's shared list on agent actions
 * (`declined.why`), a closed list the agent action's own schema checks before it is stored, so
 * only its short keys reach a count.
 */
const DECLINE_WHY_SIGNAL = /^declined\.[a-z_]{1,24}$/;

/** Whether a signal can be counted for this kind: a LOOP_SIGNALS key, the why behind a dismissal, or a reason this kind's votes can carry in that direction. */
export function isCountedSignal(kind: LoopKind, signal: string): signal is CountedSignal {
  if ((LOOP_SIGNALS as readonly string[]).includes(signal)) return true;
  if (DECLINE_WHY_SIGNAL.test(signal)) return true;
  const m = REASON_SIGNAL.exec(signal);
  // Only image votes carry reasons until step 7 adds them for posts and drafts.
  return Boolean(m && isImageKind(kind) && isVoteReason("image", m[1] === "liked" ? "up" : "down", m[2]!));
}

/** Why a saved thing has no stamp, as counted: an UNSTAMPED_REASONS key, a stamp lost, or a refused token. */
export const UNSTAMPED_COUNTS = [...UNSTAMPED_REASONS, "stamp_lost", ...STAMP_REFUSALS.map((r) => `token_${r}` as const)] as const;
export type UnstampedCount = UnstampedReason | "stamp_lost" | `token_${StampRefusal}`;

/** What a learner did, as counted. */
export type LearnOutcome = "learned" | LearnReason;
/** Read when counting, not when this file loads: ./learnLog.ts counts through this file too. */
const isLearnOutcome = (outcome: string): boolean => outcome === "learned" || (LEARN_REASONS as readonly string[]).includes(outcome);

/**
 * What happened to a learning card (Go back cards from step 4; the attention rule reads these):
 * proposed; acted (Go back); declined (Keep this look); expired, when it closed with no answer,
 * left 14 days or made moot by a person's own Undo, Forget or Edit; and ignored, when it was left
 * 14 days, the only one the attention rule counts against answers.
 */
export const CARD_SIGNALS = ["proposed", "expired", "acted", "declined", "ignored"] as const;
export type CardSignal = (typeof CARD_SIGNALS)[number];

export interface CountDeps {
  db?: FirestoreLike;
  /** The time the count belongs to, which picks the week. */
  now?: Date;
  /** A number from 0 up to 1 that picks the shard; Math.random by default. */
  random?: () => number;
}

/** The week a moment falls in, as `loop_days` names it: `2026-W48`. */
export const loopWeekOf = (now: Date): string => isoWeekOf(now.toISOString().slice(0, 10));

/** One of the week's shards, at random. */
export function shardOf(random: () => number = Math.random): number {
  const n = Math.floor(random() * LOOP_RULES.shards);
  return Number.isInteger(n) && n >= 0 && n < LOOP_RULES.shards ? n : 0;
}

/** Amounts worth writing: whole, finite and not zero. */
function amounts<K extends string>(deltas: Partial<Record<K, number>>, keep: (key: string) => boolean): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(deltas) as Array<[string, number | undefined]>) {
    if (typeof n === "number" && Number.isInteger(n) && n !== 0 && keep(k)) out[k] = n;
  }
  return out;
}

const isLoopKind = (k: string): k is LoopKind => Object.prototype.hasOwnProperty.call(LOOPS, k);

/** Add to this week's counters in one shard. Never throws. */
async function addToWeek(ctx: TenantContext, kind: LoopKind, tree: CounterTree, what: string, deps: CountDeps): Promise<void> {
  if (!isLoopKind(kind) || !countsFor(kind)) return;
  await writeWeek(ctx, tree, `${what} for ${kind}`, deps);
}

/** One merged write of increments to one of the week's shards. Never throws. */
async function writeWeek(ctx: TenantContext, tree: CounterTree, what: string, deps: CountDeps): Promise<void> {
  try {
    const week = loopWeekOf(deps.now ?? new Date());
    await addToLoopDay(ctx, loopDayId.week(ctx.tenantId, week, shardOf(deps.random)), tree, { ttlAt: loopDayTtlAt("week", week) }, deps.db);
  } catch (err) {
    // A count never fails the work it counts: the meter's rule.
    console.warn(`[loops] counting ${what} failed`, err instanceof Error ? err.message.slice(0, 200) : "error");
  }
}

/** A stamp whose parts can name counters, or null (with a warning) for one that can't. */
function countableStamp(stamp: LoopStamp): LoopStamp | null {
  const p = LoopStampSchema.safeParse(stamp);
  if (p.success && KIND_KEY.test(p.data.kind)) return p.data as LoopStamp;
  console.warn("[loops] a count was given a stamp it can't use, so nothing was counted");
  return null;
}

/**
 * Add to a made thing's signals by its stamp, in one write: `{ voted: 1, liked: 1 }`, or a changed
 * vote's `{ liked: -1, "liked.colours": -1 }`. Signals this kind can't carry are left out.
 */
export async function countSignals(ctx: TenantContext, stamp: LoopStamp, deltas: Partial<Record<CountedSignal, number>>, deps: CountDeps = {}): Promise<void> {
  const s = countableStamp(stamp);
  if (!s) return;
  const add = amounts(deltas, (k) => isCountedSignal(s.kind, k));
  if (Object.keys(add).length === 0) return;
  await addToWeek(ctx, s.kind, { c: { [s.scope]: { [s.kind]: { [`v${s.v}`]: { [s.arm]: add } } } } }, "signals", deps);
}

/** Add one to a made thing's signal. */
export function countSignal(ctx: TenantContext, stamp: LoopStamp, signal: CountedSignal, deps: CountDeps = {}): Promise<void> {
  return countSignals(ctx, stamp, { [signal]: 1 } as Partial<Record<CountedSignal, number>>, deps);
}

/** What a person did with a kept AI draft before it went out: kept it word for word, or edited it, and how many words changed. */
export interface DraftOutcome {
  signal: "kept" | "edited";
  wordsChanged: number;
}

/** A draft against the copy that went out, or null with no draft kept to compare. Pure. */
export function draftOutcome(draft: string | null | undefined, final: string): DraftOutcome | null {
  if (typeof draft !== "string" || !draft.trim()) return null;
  const wordsChanged = changedWords(draft, final ?? "");
  return { signal: wordsChanged === 0 ? "kept" : "edited", wordsChanged };
}

/**
 * Count what a person did with a made thing's words before it went out (4.4): kept when no word
 * changed, edited otherwise. Given the draft and the final copy, or the words changed when the
 * caller has measured them (an approval's AI original). Nothing without a stamp, and nothing
 * without a kept draft (the heartbeat says "no draft kept"); with the kind's switch off nothing is
 * compared or counted. Never throws. Returns what was counted, or null.
 */
export async function countDraftOutcome(
  ctx: TenantContext,
  made: Made | null | undefined,
  copy: { draft: string | null | undefined; final: string } | { wordsChanged: number },
  deps: CountDeps = {},
): Promise<DraftOutcome | null> {
  if (!made || "unstamped" in made || !isLoopKind(made.kind) || !countsFor(made.kind)) return null;
  let outcome: DraftOutcome | null;
  try {
    if ("wordsChanged" in copy) {
      const n = Number.isFinite(copy.wordsChanged) ? Math.max(0, Math.floor(copy.wordsChanged)) : 0;
      outcome = { signal: n === 0 ? "kept" : "edited", wordsChanged: n };
    } else {
      outcome = draftOutcome(copy.draft, copy.final);
    }
  } catch (err) {
    // A count never fails the work it counts.
    console.warn("[loops] comparing a draft failed", err instanceof Error ? err.message.slice(0, 200) : "error");
    return null;
  }
  if (!outcome) return null;
  await countSignal(ctx, made, outcome.signal, deps);
  return outcome;
}

/**
 * Add to the signals of things of a kind whose records keep no stamp yet (a brand map
 * suggestion): the cell their made count went to, since every kind but the image kinds is
 * stamped at version 0, arm none, in its own scope (learnedFor). Not for image kinds, whose
 * stamps name a style and a version. Never throws.
 */
export async function countKindSignals(ctx: TenantContext, kind: LoopKind, deltas: Partial<Record<CountedSignal, number>>, deps: CountDeps = {}): Promise<void> {
  if (!isLoopKind(kind) || isImageKind(kind) || kind === "loop_learn") return;
  const add = amounts(deltas, (k) => isCountedSignal(kind, k));
  if (Object.keys(add).length === 0) return;
  await addToWeek(ctx, kind, { c: { [kind]: { [kind]: { v0: { none: add } } } } }, "signals", deps);
}

/** The most things one count of made may add: a save that keeps several records from one model call. */
export const MADE_AT_ONCE_MAX = 100;

/**
 * Count a thing made and saved (or handed back to be saved): made against its stamp, or why it has
 * none, and made for its ontology type, in one write. `n` counts several records one save keeps
 * from the same call (such as the templates one deconstruct makes); 1 when left out.
 */
export async function countMade(ctx: TenantContext, kind: LoopKind, made: Made, opts: CountDeps & { type?: string; n?: number } = {}): Promise<void> {
  const m = madeTree(kind, made, opts.type, opts.n);
  if (m) await addToWeek(ctx, m.kind, m.tree, "made", opts);
}

/** The counters made things add, under the kind they count for, or null for a stamp that can't name any or a count of none. */
function madeTree(kind: LoopKind, made: Made, type?: string, n = 1): { kind: LoopKind; tree: CounterTree } | null {
  if (!Number.isInteger(n) || n < 1) return null;
  const k = Math.min(n, MADE_AT_ONCE_MAX);
  const t: CounterTree = type && KIND_KEY.test(type) ? { t: { [type]: { made: k } } } : {};
  if ("unstamped" in made) return { kind, tree: { u: { [kind]: { [made.unstamped]: k } }, ...t } };
  const s = countableStamp(made);
  if (!s) return null;
  return { kind: s.kind, tree: { c: { [s.scope]: { [s.kind]: { [`v${s.v}`]: { [s.arm]: { made: k } } } } }, ...t } };
}

/** The signals a person's own image can count: it was never made, kept or edited by YouGrow. */
const OWN_IMAGE_SIGNALS: ReadonlySet<string> = new Set(["voted", "liked"]);

/**
 * Count a vote on a person's own image (an upload), which has no stamp: `{ voted: 1, liked: 1 }`,
 * or a changed vote's negative amounts. With image style versions on only. Never throws.
 */
export async function countOwnImage(ctx: TenantContext, deltas: Partial<Record<CountedSignal, number>>, deps: CountDeps = {}): Promise<void> {
  const add = amounts(deltas, (k) => OWN_IMAGE_SIGNALS.has(k));
  if (Object.keys(add).length === 0) return;
  // An own image teaches only the image learner: it counts while image style versions are on.
  await addToWeek(ctx, "loop_learn", { o: { image: add } }, "an own image's vote", deps);
}

/** Count a save with no stamp: an UNSTAMPED_REASONS reason, a stamp lost, or a refused token. */
export async function countUnstamped(ctx: TenantContext, kind: LoopKind, reason: UnstampedCount, deps: CountDeps = {}): Promise<void> {
  if (!(UNSTAMPED_COUNTS as readonly string[]).includes(reason)) return;
  await addToWeek(ctx, kind, { u: { [kind]: { [reason]: 1 } } }, "unstamped", deps);
}

/** Count a stamp token a save brought back and stamp.ts refused, by its reason. */
export function countRefusedToken(ctx: TenantContext, kind: LoopKind, refusal: StampRefusal, deps: CountDeps = {}): Promise<void> {
  return countUnstamped(ctx, kind, `token_${refusal}`, deps);
}

/** Count what a learner did for a kind: learned, or why it refused. */
export async function countLearnOutcome(ctx: TenantContext, kind: LoopKind, outcome: LearnOutcome, deps: CountDeps = {}): Promise<void> {
  if (!isLearnOutcome(outcome)) return;
  await addToWeek(ctx, kind, { r: { [kind]: { [outcome]: 1 } } }, "a learn", deps);
}

/** Count what happened to a learning card for a kind. */
export async function countCard(ctx: TenantContext, kind: LoopKind, signal: CardSignal, deps: CountDeps = {}): Promise<void> {
  if (!(CARD_SIGNALS as readonly string[]).includes(signal)) return;
  await addToWeek(ctx, kind, { k: { [kind]: { [signal]: 1 } } }, "a card", deps);
}

/**
 * Add one to a learned version's own signal, such as undone or reversed: a person's action on the
 * look itself rather than on one image, counted under the image learner's kind
 * (`c.<scope>.loop_learn.v<v>.learned.<signal>`). Never throws.
 */
export async function countVersionSignal(ctx: TenantContext, scope: string, v: number, signal: "undone" | "reversed", deps: CountDeps = {}): Promise<void> {
  await countLearnedSignal(ctx, "loop_learn", scope, v, signal, deps);
}

/**
 * The same for a learner of another kind, such as a person reverting a post channel's learned
 * patterns (`c.<scope>.<kind>.v<v>.learned.<signal>`). Never throws.
 */
export async function countLearnedSignal(ctx: TenantContext, kind: LoopKind, scope: string, v: number, signal: "undone" | "reversed", deps: CountDeps = {}): Promise<void> {
  if (!Number.isInteger(v) || v < 0 || scope.length > SCOPE_MAX_CHARS || !SCOPE_RE.test(scope)) return;
  await addToWeek(ctx, kind, { c: { [scope]: { [kind]: { [`v${v}`]: { learned: { [signal]: 1 } } } } } }, signal, deps);
}

// ----- A batch run's counts (4.1) -----

/** Add one tree of counters into another, in place. */
function addInto(into: CounterTree, add: CounterTree): void {
  for (const [k, v] of Object.entries(add)) {
    const cur = into[k];
    if (typeof v === "number") {
      into[k] = (typeof cur === "number" ? cur : 0) + v;
    } else {
      const next: CounterTree = cur && typeof cur === "object" ? cur : {};
      addInto(next, v);
      into[k] = next;
    }
  }
}

/** The most brands one buffer holds: a run past it writes the oldest brand's counts early. */
const BUFFER_BRANDS_MAX = 200;

/**
 * A batch run's counts, added up and written once per brand when the run ends (4.1 of the plan
 * for steps 4 and 5): the lifecycle runner, the waitlist runner, the email job worker and the
 * invite sender add one made per email here instead of one write each. Each count is checked
 * against its kind's switch as it is added, so an off kind adds nothing. `flush` writes each
 * brand's tree in one merged write and never throws; a run that ends without flushing loses only
 * its counts, never its work. Small: a brand's tree holds counters, never words.
 */
export class CountBuffer {
  private readonly brands = new Map<string, { ctx: TenantContext; tree: CounterTree }>();

  constructor(private readonly deps: CountDeps = {}) {}

  private add(ctx: TenantContext, kind: LoopKind, tree: CounterTree): void {
    if (!isLoopKind(kind) || !countsFor(kind)) return;
    let brand = this.brands.get(ctx.tenantId);
    if (!brand) {
      if (this.brands.size >= BUFFER_BRANDS_MAX) void this.flushOldest();
      brand = { ctx, tree: {} };
      this.brands.set(ctx.tenantId, brand);
    }
    addInto(brand.tree, tree);
  }

  /** Count a thing made and saved (or sent): made against its stamp, or why it has none. */
  made(ctx: TenantContext, kind: LoopKind, made: Made, opts: { type?: string } = {}): void {
    const m = madeTree(kind, made, opts.type);
    if (m) this.add(ctx, m.kind, m.tree);
  }

  /** Count a save with no stamp, or a stamp lost. */
  unstamped(ctx: TenantContext, kind: LoopKind, reason: UnstampedCount): void {
    if (!(UNSTAMPED_COUNTS as readonly string[]).includes(reason)) return;
    this.add(ctx, kind, { u: { [kind]: { [reason]: 1 } } });
  }

  /** Brands with counts not yet written. */
  get size(): number {
    return this.brands.size;
  }

  private async flushOldest(): Promise<void> {
    const first = this.brands.entries().next();
    if (first.done) return;
    const [id, brand] = first.value;
    this.brands.delete(id);
    await writeWeek(brand.ctx, brand.tree, "a run's counts", this.deps);
  }

  /** Write each brand's counts in one merged write, and empty the buffer. Never throws. */
  async flush(): Promise<void> {
    const all = [...this.brands.values()];
    this.brands.clear();
    await Promise.all(all.map((b) => (Object.keys(b.tree).length ? writeWeek(b.ctx, b.tree, "a run's counts", this.deps) : Promise.resolve())));
  }
}
