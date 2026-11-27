import { LOOP_SIGNALS, type BrandPointers } from "@/lib/types/loopDay";
import { LOOP_ARMS } from "@/lib/types/loopStamp";
import { IMAGE_STYLE_SCOPES, LOOP_RULES, LOOPS, type Decision, type LoopKind } from "./registry";

/**
 * How far learning gets for each kind of choice, per brand (learning loops step 5, 4.6 of the
 * plan for steps 4 and 5), read from the brand's folded weeks (`lt:`), never from records. Pure.
 *
 * - The kinds are the learning registry's, except that the five image kinds that learn one look
 *   count once, as their pool (`image_style`), and the image learner's own counts (`loop_learn`:
 *   its outcomes, cards, undone looks and the votes on a person's own images) count with them.
 * - The stages, over a window of 4 closed weeks (28 days), each reached through the ones before:
 *   Declared (the line exists: counted once, as the organisations that sent a heartbeat), Stamped
 *   (made at least once), Signalled (any person signal), Learning (something learned in the
 *   window, or a learned look in use), Checked (a verdict read at a look, too few included) and
 *   Proven (step 9). Signalled and Learning apply to kinds that learn and to the Memory Bank
 *   lines that log learning (`edit_mode` and `content_write`); Checked to kinds the verdict reads.
 * - Stuck, the design's per brand rule: at Stamped (made, no person signal) or at Signalled
 *   (signals, nothing learned) since the window's first week, or while LOOP_RULES.stallOutputs
 *   more are made there, whichever comes first. Only those two steps can be stuck: Declared to
 *   Stamped is use, and Learning to Checked is a wait, shown as one.
 */

/** The pool the five image kinds learn one look in, as one row of the counts across brands. */
export const IMAGE_POOL = "image_style" as const;

/** The stages a brand reaches from its counts, in order. Declared is the heartbeat itself, and Proven waits for step 9. */
export const STAGES = ["stamped", "signalled", "learning", "checked"] as const;
export type Stage = (typeof STAGES)[number];

/** The only steps a brand can be stuck at. */
export const STUCK_STEPS = ["stamped", "signalled"] as const;
export type StuckStep = (typeof STUCK_STEPS)[number];

/**
 * The own lines that log learning (learning loops step 2, MEMORY_BANK_KINDS in ./learnLog.ts,
 * which a test holds this to): their learn lines count as person signals and their learned lines
 * as learning.
 */
export const LOGGED_OWN_KINDS = ["edit_mode", "content_write"] as const satisfies readonly LoopKind[];

/** The weeks a brand's stages are read over: 4 closed weeks, the stages' 28 days. */
export const STAGE_WEEKS = LOOP_RULES.stallDays / 7;

const DAY_MS = 86_400_000;

const isLoopKind = (k: string): k is LoopKind => Object.prototype.hasOwnProperty.call(LOOPS, k);
const decisionOf = (k: LoopKind): Decision => LOOPS[k] as Decision;

/** The row a kind counts under: the pool of a line that learns in one, the image pool for the image learner, or the kind itself; null for a key that is no kind. */
export function rowKindOf(kind: string): string | null {
  if (!isLoopKind(kind)) return null;
  if (kind === "loop_learn") return IMAGE_POOL;
  const d = decisionOf(kind);
  return "loop" in d && d.loop.pool ? d.loop.pool : kind;
}

/** What a row's line lets it reach: Signalled and Learning, and Checked. */
export interface RowLine {
  learns: boolean;
  checks: boolean;
}

const ROW_LINES = new Map<string, RowLine>();
for (const kind of Object.keys(LOOPS) as LoopKind[]) {
  const row = rowKindOf(kind)!;
  const d = decisionOf(kind);
  const was = ROW_LINES.get(row) ?? { learns: false, checks: false };
  const loop = "loop" in d;
  ROW_LINES.set(row, { learns: was.learns || loop || (LOGGED_OWN_KINDS as readonly string[]).includes(kind), checks: was.checks || loop });
}

/** A row's line: whether it can reach Signalled and Learning, and Checked. */
export const rowLine = (row: string): RowLine => ROW_LINES.get(row) ?? { learns: false, checks: false };

/** Every row the counts across brands keep, by kind. */
export const ROW_KINDS: readonly string[] = [...ROW_LINES.keys()];

// ----- One week's counters, by row -----

type Tree = Record<string, unknown>;
const isObj = (v: unknown): v is Tree => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
type Counts = Record<string, number>;

/** A part of a counter's name that may become a key of the counts across brands: never a path or an id's separator. */
const PART = /^[A-Za-z0-9_.-]{1,60}$/;
const ARMS: ReadonlySet<string> = new Set(LOOP_ARMS);
const SIGNALS: ReadonlySet<string> = new Set(LOOP_SIGNALS);
/** What a person did with a made thing: every signal but made. */
const PERSON_SIGNALS: ReadonlySet<string> = new Set(LOOP_SIGNALS.filter((s) => s !== "made"));
/** The signals kept per image style, for the holdback months. */
const SCOPE_SIGNALS: ReadonlySet<string> = new Set(["made", "voted", "liked", "remade"]);
const SCOPE_PREFIX = `${IMAGE_POOL}.`;

/** One row's counters in one week. */
export interface RowWeek {
  made: number;
  /** Person signals: kept, edited, declined, voted, liked, remade, undone and reversed, plus a Memory Bank line's learn lines. */
  signals: number;
  /** Learned by a learner. */
  learned: number;
  /** Learner refusals, by reason. */
  refused: Counts;
  /** By arm, then signal (LOOP_SIGNALS). */
  out: Record<string, Counts>;
  /** The image pool only: by style, then arm, then made, voted, liked and remade. */
  scope: Record<string, Record<string, Counts>>;
  /** The image pool only: votes on a person's own images. */
  own: Counts;
  /** The why behind a vote, by reason. */
  liked: Counts;
  disliked: Counts;
  /** The why behind a dismissal, by Work's shared list. */
  declinedWhy: Counts;
  /** Saves with no stamp, by reason, `stamp_lost` and refused tokens included. */
  unstamped: Counts;
  /** Learning cards, by signal. */
  cards: Counts;
}

const emptyWeek = (): RowWeek => ({ made: 0, signals: 0, learned: 0, refused: {}, out: {}, scope: {}, own: {}, liked: {}, disliked: {}, declinedWhy: {}, unstamped: {}, cards: {} });
const add = (into: Counts, key: string, n: number) => {
  if (PART.test(key) && n !== 0) into[key] = (into[key] ?? 0) + n;
};

/** A week's counter tree (a folded `lt:` week, or shards added up) read by row. */
export function rowsOfWeek(d: unknown): Map<string, RowWeek> {
  const out = new Map<string, RowWeek>();
  const of = (row: string) => out.get(row) ?? out.set(row, emptyWeek()).get(row)!;
  const tree = isObj(d) ? d : {};
  if (isObj(tree.c)) {
    for (const [scope, byKind] of Object.entries(tree.c)) {
      if (!isObj(byKind)) continue;
      for (const [kind, byV] of Object.entries(byKind)) {
        const row = rowKindOf(kind);
        if (!row || !isObj(byV)) continue;
        const w = of(row);
        const style = row === IMAGE_POOL && scope.startsWith(SCOPE_PREFIX) ? scope.slice(SCOPE_PREFIX.length) : null;
        for (const byArm of Object.values(byV)) {
          if (!isObj(byArm)) continue;
          for (const [arm, signals] of Object.entries(byArm)) {
            if (!ARMS.has(arm) || !isObj(signals)) continue;
            for (const [signal, raw] of Object.entries(signals)) {
              const n = num(raw);
              if (n === 0) continue;
              if (SIGNALS.has(signal)) {
                add((w.out[arm] ??= {}), signal, n);
                if (signal === "made") w.made += n;
                else if (PERSON_SIGNALS.has(signal)) w.signals += n;
                if (style && PART.test(style) && SCOPE_SIGNALS.has(signal)) add(((w.scope[style] ??= {})[arm] ??= {}), signal, n);
                continue;
              }
              const dot = signal.indexOf(".");
              const head = dot > 0 ? signal.slice(0, dot) : "";
              const why = dot > 0 ? signal.slice(dot + 1) : "";
              if (head === "liked") add(w.liked, why, n);
              else if (head === "disliked") add(w.disliked, why, n);
              else if (head === "declined") add(w.declinedWhy, why, n);
            }
          }
        }
      }
    }
  }
  if (isObj(tree.u)) {
    for (const [kind, reasons] of Object.entries(tree.u)) {
      const row = rowKindOf(kind);
      if (!row || !isObj(reasons)) continue;
      for (const [reason, n] of Object.entries(reasons)) add(of(row).unstamped, reason, num(n));
    }
  }
  if (isObj(tree.r)) {
    for (const [kind, outcomes] of Object.entries(tree.r)) {
      const row = rowKindOf(kind);
      if (!row || !isObj(outcomes)) continue;
      const w = of(row);
      const logged = (LOGGED_OWN_KINDS as readonly string[]).includes(kind);
      for (const [outcome, raw] of Object.entries(outcomes)) {
        const n = num(raw);
        if (n <= 0) continue;
        if (outcome === "learned") w.learned += n;
        else add(w.refused, outcome, n);
        // A Memory Bank line is written when a person's edit reaches the learner: a person signal.
        if (logged) w.signals += n;
      }
    }
  }
  if (isObj(tree.k)) {
    for (const [kind, signals] of Object.entries(tree.k)) {
      const row = rowKindOf(kind);
      if (!row || !isObj(signals)) continue;
      for (const [signal, n] of Object.entries(signals)) add(of(row).cards, signal, num(n));
    }
  }
  if (isObj(tree.o) && isObj(tree.o.image)) {
    const w = of(IMAGE_POOL);
    for (const [signal, raw] of Object.entries(tree.o.image)) {
      const n = num(raw);
      add(w.own, signal, n);
      if (PERSON_SIGNALS.has(signal)) w.signals += n;
    }
  }
  return out;
}

// ----- A brand's stage for one row -----

/** A learned look a brand uses in one scope: when it began, and whether a verdict has read it at a look. */
export interface LookInUse {
  scope: string;
  adoptedAt: string;
  checked: boolean;
}

/**
 * The learned looks the brand uses, from its pointers (`lb:`) and those versions' totals (`lv:`
 * data, by scope): looks that reached an image, a Forget's version and a person's own words left
 * out. The heartbeat and get_learning read a brand's stage on the image pool with these.
 */
export function looksInUse(pointers: BrandPointers, totals: ReadonlyMap<string, unknown>): LookInUse[] {
  const out: LookInUse[] = [];
  for (const scope of IMAGE_STYLE_SCOPES) {
    const p = pointers.scopes[scope];
    if (!p || p.v < 1 || p.setBy === "person" || pointers.forgot?.[scope]?.at === p.adoptedAt) continue;
    // Read as counts and keys only, so one read this can't parse never hides the rest.
    const d = totals.get(scope);
    const c = isObj(d) && isObj(d.c) ? d.c : {};
    const reachedImage = Object.values(c).some((byArm) => isObj(byArm) && isObj(byArm.learned) && num(byArm.learned.made) > 0);
    if (!reachedImage) continue;
    const checked = isObj(d) && isObj(d.looks) && Object.keys(d.looks).some((look) => look !== "0");
    out.push({ scope, adoptedAt: p.adoptedAt, checked });
  }
  return out;
}

/** Where a brand is on one row, as of a closed week. */
export interface RowStage {
  /** The furthest stage reached in the window, or null for none. */
  reached: Stage | null;
  stuck: StuckStep | null;
  /** Learner refusals in the window, by reason, and the most common. */
  refused: Counts;
  topReason: string | null;
  /** A learning card was proposed in the window. */
  card: boolean;
  /** A learned look in use with no check yet: days since the oldest such look began. */
  waitDays: number | null;
}

const sum = (weeks: readonly RowWeek[], f: (w: RowWeek) => number) => weeks.reduce((n, w) => n + f(w), 0);

/**
 * A brand's stage on one row, from its weeks in the window, oldest first (the reported week
 * last; a week with no counts is undefined), and, for a row the verdict reads, the learned looks
 * it uses. `weekEnd` is when the reported week ended, for the wait.
 */
export function rowStage(row: string, weeks: ReadonlyArray<RowWeek | undefined>, looks: readonly LookInUse[], weekEnd: Date): RowStage {
  const line = rowLine(row);
  const ws = weeks.map((w) => w ?? emptyWeek());
  const made = Math.max(0, sum(ws, (w) => w.made));
  const signals = Math.max(0, sum(ws, (w) => w.signals));
  const learned = sum(ws, (w) => w.learned);
  const inUse = line.checks ? looks : [];
  const refused: Counts = {};
  for (const w of ws) for (const [r, n] of Object.entries(w.refused)) refused[r] = (refused[r] ?? 0) + n;
  const topReason = Object.entries(refused).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

  const learning = line.learns && (learned > 0 || inUse.length > 0);
  const checked = line.checks && inUse.some((l) => l.checked);
  const signalled = line.learns && (signals > 0 || learning);
  const stamped = made > 0 || signalled;
  const reached: Stage | null = checked ? "checked" : learning ? "learning" : signalled ? "signalled" : stamped ? "stamped" : null;

  let stuck: StuckStep | null = null;
  if (line.learns && reached === "stamped") {
    // Made, and no person signal since the window's first week, or 10 made with none.
    if ((ws[0]?.made ?? 0) > 0 || made >= LOOP_RULES.stallOutputs) stuck = "stamped";
  } else if (line.learns && reached === "signalled") {
    // Signals since the window's first week and nothing learned, or 10 made since the first signal.
    const first = ws.findIndex((w) => w.signals > 0);
    const since = first < 0 ? 0 : sum(ws.slice(first), (w) => w.made);
    if (first === 0 || since >= LOOP_RULES.stallOutputs) stuck = "signalled";
  }

  const waiting = inUse.filter((l) => !l.checked);
  const oldest = waiting.map((l) => Date.parse(l.adoptedAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const waitDays = waiting.length && oldest !== undefined ? Math.max(0, Math.floor((weekEnd.getTime() - oldest) / DAY_MS)) : null;
  const card = ws.some((w) => (w.cards.proposed ?? 0) > 0);
  return { reached, stuck, refused, topReason, card, waitDays };
}

/** Whether a stage is at or before another: the stages a brand reached, counted through the furthest. */
export const stagesThrough = (reached: Stage | null): Stage[] => (reached ? STAGES.slice(0, STAGES.indexOf(reached) + 1) : []);
