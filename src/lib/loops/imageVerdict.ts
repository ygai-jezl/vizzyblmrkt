import { forTenant } from "@/lib/tenant";
import { loopDayId, mergeLoopDay } from "@/lib/tenant/loops";
import { getPatternVersion } from "@/lib/tenant/patternVersions";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ImageAsset } from "@/lib/types/imageAsset";
import { AFTER_ENTRIES_MAX, type AfterRead, type BrandPointers, type LookRead, type VersionCheck, type VersionTotals } from "@/lib/types/loopDay";
import type { LearnedPatternVersion } from "@/lib/types/learnedPatternVersion";
import type { LoopStamp } from "@/lib/types/loopStamp";
import { proposeGoBack, type ProposeCardOutcome } from "./cards";
import { priorOf } from "./defaults";
import { versionCheckOf } from "./learners/votes";
import { BRAND_SCOPE, imageScopeOf } from "./read";
import { BY_LEARNER, IMAGE_STYLE_SCOPES, LOOP_RULES } from "./registry";
import { verdict, type Outputs } from "./verdict";
import { lookReadOf } from "./verdictWords";

/**
 * The verdict for image looks (learning loops step 4, 3.8 of the plan for steps 4 and 5): for the
 * version each style uses, the loops lane reads the style's images either side of the version's
 * start and runs the one verdict (src/lib/loops/verdict.ts) on liked share, guarded by remade
 * share, at band 0.15. The read is kept on the version's `lv:` (its check, which the votes
 * learner's hold reads, and the read at each look), and a worse read offers a Go back card.
 *
 * - Outputs: images with a stamp, made at least LOOP_RULES.outcomeDays ago, leaving out held back
 *   images, images made with "Use learned brand style" off, customised images and uploads, and
 *   images the look never reached: a drawn fallback (`fallback_drawn`) or a path that never learns
 *   (`not_learning`). Images made before versions have no stamp, and no first vote or remake was
 *   kept for them, so they are never outputs. The brand look's are the images stamped with its
 *   scope, whatever their style: every painted style with no look of its own uses it. A style's
 *   are its images (imageScopeOf its style); before its version began, every image of the style,
 *   those made with the brand look too. Since its version began, only those stamped with its own
 *   scope and version, and while that version has a look, only arm learned: the look reached them.
 * - The check: images voted within 14 days of being made; a hit is an up vote, as the vote stood
 *   at 14 days (`outcomeVote`). The guard: every such image; a hit is a remake within 14 days. So
 *   each outcome is fixed in the order the images were made, as the verdict needs.
 * - Before: the images made while the version before was in use, read newest first back from the
 *   version's start (the `(tenantId, createdAt desc)` index); the images before those set where
 *   the scope's warm up ends. A version the seed carried over from before versions has nothing
 *   before it, and the version after it reads back to the scope's start. After: the images since
 *   its start (for a carried over version, since the seed), read oldest first, which needs
 *   the `(tenantId, createdAt asc)` index (firestore.indexes.json): a composite index serves one
 *   sort direction only. The after side is paged across runs: each run reads on from the last
 *   image the one before read (AfterRead, kept on `lv:`), taking only images old enough that their
 *   outcomes are fixed, until it holds the last look's entries. So a style that makes a small share
 *   of a busy brand's images still reaches its outputs. Both reads are projected to the fields
 *   used, at most LOOP_RULES.verdictRows rows each.
 * - It runs for a version with no read yet, again once its made or voted counters moved (at most
 *   daily) or once images too new at the last read are old enough, and on the next visit while its
 *   after side has more to page through, within the run's budget of LOOP_RULES.laneVerdictReads
 *   reads.
 * Server only.
 */

const DAY_MS = 86_400_000;

const FIELDS = ["kind", "style", "createdAt", "made", "brandVote", "outcomeVote", "firstVotedAt", "remadeAt"] as const satisfies ReadonlyArray<keyof ImageAsset>;
type Row = Pick<ImageAsset, (typeof FIELDS)[number] | "id">;

/** The verdict reads a run has left, shared by every brand it visits; reads wait on each other, so one at a time is held. */
export interface VerdictRun {
  readsLeft: number;
  queue: Promise<void>;
}

export const newVerdictRun = (): VerdictRun => ({ readsLeft: LOOP_RULES.laneVerdictReads, queue: Promise.resolve() });

export interface ImageVerdictDeps {
  db?: FirestoreLike;
  now?: Date;
  /** Go back cards the brand's open week has counted, for the weekly budget. */
  proposedThisWeek?: number;
  /** Cards drop to a notice on the card instead of Review (the attention rule). */
  noticeOnly?: () => Promise<boolean>;
}

export interface ScopeVerdict {
  scope: string;
  v: number;
  read: LookRead;
  check: VersionCheck;
  card?: ProposeCardOutcome | "notice";
}

export interface ImageVerdictResult {
  verdicts: ScopeVerdict[];
  /** Image rows read. */
  rows: number;
  /** A version that was due waited for the next run's budget. */
  deferred: boolean;
  /** The soonest a read waiting on images to age is due. */
  dueAt: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** A version's made and voted counters across its kinds and arms: what moves when its images are made or voted on. */
export function seenOf(t: VersionTotals | undefined): number {
  let n = 0;
  for (const byArm of Object.values(t?.c ?? {})) {
    for (const signals of Object.values(byArm ?? {})) {
      if (!isObj(signals)) continue;
      for (const key of ["made", "voted"] as const) if (typeof signals[key] === "number") n += signals[key] as number;
    }
  }
  return n;
}

/** Whether a version's read is due now, and if not, when a read waiting on images to age will be. */
export function verdictDue(t: VersionTotals | undefined, now: Date): { due: boolean; at: string | null } {
  const check = t?.check;
  if (!check) return { due: true, at: null };
  const at = Date.parse(check.at);
  if (!Number.isFinite(at) || check.more) return { due: true, at: null };
  const moved = (check.seen ?? -1) !== seenOf(t);
  const daily = at + DAY_MS;
  const aged = check.pending ? at + LOOP_RULES.outcomeDays * DAY_MS : Infinity;
  const next = Math.min(moved ? daily : Infinity, aged);
  if (next <= now.getTime()) return { due: true, at: null };
  return { due: false, at: Number.isFinite(next) ? new Date(next).toISOString() : null };
}

/** The image's stamp, when it has one. */
const stampOf = (r: Row): LoopStamp | null => (r.made && !("unstamped" in r.made) ? (r.made as LoopStamp) : null);

/** Sources that say the look never reached the image, or that a person turned it off: never an output. */
const NOT_OUTPUT_SOURCES: ReadonlySet<string> = new Set(["person_off", "fallback_drawn", "not_learning"]);

/** The version an after side reads for: its number, and whether it has a look (a Forget and an Undo of a first look don't). */
interface AfterOf {
  v: number;
  hasLook: boolean;
}

/**
 * Whether an image is one of the scope's outputs, before the version's start or since it. An image
 * with no stamp was made before versions (or with them off), when no first vote or remake was kept,
 * so its outcomes aren't known and it is never one. Since the version began, an image is its output
 * only if it was made with that version, and, while the version has a look, only if the look
 * reached it (arm learned, 3.3): arm none is kept only for a version with no look of its own.
 */
function isOutput(scope: string, r: Row, side: "before" | { after: AfterOf }): boolean {
  if (r.kind === "customized" || r.kind === "upload") return false;
  const s = stampOf(r);
  if (!s) return false;
  if (s.arm === "holdback" || (s.sources ?? []).some((x) => NOT_OUTPUT_SOURCES.has(x))) return false;
  if (side !== "before") {
    if (s.scope !== scope || s.v !== side.after.v) return false;
    if (side.after.hasLook && s.arm !== "learned") return false;
  }
  // The brand look's images carry the style they were painted in: its stamp says they used it.
  if (scope === BRAND_SCOPE) return s.scope === BRAND_SCOPE;
  // Before the version began, the style's images made with the brand look count too.
  return imageScopeOf(r.style) === scope;
}

/** Whether a version row has a look: a rule item with words, which an Undo of a first look and a Forget don't. */
const hasLook = (row: LearnedPatternVersion | null): boolean => Boolean(row?.items?.some((i) => i.type === "rule" && typeof i.text === "string" && i.text.trim().length > 0));

/** A row that once held words a Forget took out: going back to it is refused. */
const wordsRemoved = (row: LearnedPatternVersion | null): boolean => Boolean(row?.items?.length) && !hasLook(row);

const within = (from: string, to: string | null | undefined) => Boolean(to) && Date.parse(to!) - Date.parse(from) <= LOOP_RULES.outcomeDays * DAY_MS;
/** The vote as it stood 14 days after the image was made; a row from before `outcomeVote` was kept reads its vote. */
const outcomeVoteOf = (r: Row) => (r.outcomeVote !== undefined ? r.outcomeVote : r.brandVote);
const checkEntry = (r: Row): boolean | null => {
  const vote = outcomeVoteOf(r);
  return vote && within(r.createdAt, r.firstVotedAt) ? vote === "up" : null;
};
const guardEntry = (r: Row): boolean => within(r.createdAt, r.remadeAt);

/** The check's and guard's entries of some images, oldest first. */
function entriesOf(rows: readonly Row[]): { check: boolean[]; guard: boolean[] } {
  const check: boolean[] = [];
  const guard: boolean[] = [];
  for (const r of rows) {
    const c = checkEntry(r);
    if (c !== null) check.push(c);
    guard.push(guardEntry(r));
  }
  return { check, guard };
}

/** Oldest first, then by id as Firestore orders document ids, so the after side's cursor matches the read's order. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const oldestFirst = (a: Row, b: Row) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id);

const readAfresh = (from: string): AfterRead => ({ from, through: null, check: "", guard: "", votes: 0 });

/**
 * One page of a version's images since it began, read on from where the last run stopped: only
 * images old enough that their outcomes are fixed join the entries and move the cursor; a newer
 * output makes the read pending. `more` when the page was full and every image on it was old
 * enough, so the next visit reads on.
 */
async function readAfterPage(
  repo: ReturnType<typeof forTenant>["imageAssets"],
  scope: string,
  of: AfterOf,
  start: string,
  kept: AfterRead | undefined,
  ripe: string,
): Promise<{ after: AfterRead; rows: number; pending: boolean; more: boolean }> {
  const after: AfterRead = kept && kept.from === start ? { ...kept, through: kept.through ? { ...kept.through } : null } : readAfresh(start);
  if (after.check.length >= AFTER_ENTRIES_MAX) return { after, rows: 0, pending: false, more: false };
  const limit = LOOP_RULES.verdictRows;
  const through = after.through;
  const page = await repo.findFields(FIELDS, { where: [["createdAt", ">=", through?.at ?? start]], orderBy: [["createdAt", "asc"]], limit });
  // The images at the cursor's own time that the last page read come back: they are left out.
  const fresh = page.filter((r) => !through || r.createdAt > through.at || (r.createdAt === through.at && r.id > through.id)).sort(oldestFirst);
  let pending = false;
  let tooNew = false;
  for (const r of fresh) {
    const output = isOutput(scope, r, { after: of });
    if (r.createdAt > ripe) {
      tooNew = true;
      if (output) pending = true;
      continue;
    }
    after.through = { at: r.createdAt, id: r.id };
    if (!output) continue;
    const c = checkEntry(r);
    if (c !== null) {
      after.votes += 1;
      if (after.check.length < AFTER_ENTRIES_MAX) after.check += c ? "1" : "0";
    }
    if (after.guard.length < AFTER_ENTRIES_MAX) after.guard += guardEntry(r) ? "1" : "0";
  }
  const more = page.length >= limit && fresh.length > 0 && !tooNew && after.check.length < AFTER_ENTRIES_MAX;
  return { after, rows: page.length, pending, more };
}

const entriesFrom = (bits: string): boolean[] => [...bits].map((b) => b === "1");

/**
 * Read one version: the images either side of its start, the verdict, its check, and its read.
 * Two reads of image rows: the window before, and the next page of the images since it began.
 */
export async function readVersionVerdict(
  ctx: TenantContext,
  input: {
    scope: string;
    v: number;
    /** When the version began: for one the seed carried over from before versions, the seed. */
    adoptedAt: string;
    /** Carried over by the seed: nothing came before it, so it reads no before window. */
    carriedOver?: boolean;
    /** When the version before began; null when its outputs reach back to the scope's start (version 0, or a carried over one). */
    prevAdoptedAt: string | null;
    seen: number;
    /** Whether the version has a look (true when left out): while it does, only images its look reached are its outputs. */
    hasLook?: boolean;
    /** What earlier runs read of its images since it began (`lv:`), to read on from. */
    after?: AfterRead;
  },
  deps: { db?: FirestoreLike; now?: Date } = {},
): Promise<{ read: LookRead; check: VersionCheck; after: AfterRead; rows: number; verdictCall: string }> {
  const now = deps.now ?? new Date();
  const ripe = new Date(now.getTime() - LOOP_RULES.outcomeDays * DAY_MS).toISOString();
  const repo = forTenant(ctx, deps.db).imageAssets;
  const limit = LOOP_RULES.verdictRows;
  const start = input.adoptedAt;
  const of: AfterOf = { v: input.v, hasLook: input.hasLook ?? true };
  const [beforeRows, page] = await Promise.all([
    input.carriedOver ? Promise.resolve([] as Row[]) : repo.findFields(FIELDS, { where: [["createdAt", "<", start]], orderBy: [["createdAt", "desc"]], limit }),
    readAfterPage(repo, input.scope, of, start, input.after, ripe),
  ]);
  const before = beforeRows.filter((r) => isOutput(input.scope, r, "before")).sort(oldestFirst);
  const pending = page.pending || before.some((r) => r.createdAt > ripe);
  const ripeOnly = (rows: Row[]) => rows.filter((r) => r.createdAt <= ripe);
  const prev = input.prevAdoptedAt;
  const earlier = entriesOf(ripeOnly(before.filter((r) => prev !== null && r.createdAt < prev)));
  const window = entriesOf(ripeOnly(before.filter((r) => prev === null || r.createdAt >= prev)));
  const since = { check: entriesFrom(page.after.check), guard: entriesFrom(page.after.guard) };
  const afterVotes = page.after.votes;
  // A before read cut at its limit may not reach the scope's start: its warm up was spent long ago.
  const cut = beforeRows.length >= limit;
  const startsAt = {
    check: cut ? Math.max(earlier.check.length, LOOP_RULES.warmUp) : earlier.check.length,
    guard: cut ? Math.max(earlier.guard.length, LOOP_RULES.warmUp) : earlier.guard.length,
  };
  const line = BY_LEARNER.votes;
  const v = verdict({
    line,
    check: { before: window.check, after: since.check } satisfies Outputs,
    guard: { before: window.guard, after: since.guard } satisfies Outputs,
    prior: { check: priorOf(line.check), guard: priorOf(line.guard) },
    startsAt,
  });
  const at = now.toISOString();
  const usableBefore = Math.max(0, window.check.length - Math.max(0, LOOP_RULES.warmUp - startsAt.check));
  const read = lookReadOf(v, { usableBefore, after: afterVotes, at });
  const check: VersionCheck = {
    ...versionCheckOf({ beforeVotes: window.check.length, startsAt: startsAt.check, afterVotes, verdict: v, at }),
    seen: input.seen,
    pending,
    ...(page.more ? { more: true } : {}),
  };
  return { read, check, after: page.after, rows: beforeRows.length + page.rows, verdictCall: v.call };
}

function takeReads(run: VerdictRun): boolean {
  if (run.readsLeft < 2) return false;
  run.readsLeft -= 2;
  return true;
}

function oneAtATime<T>(run: VerdictRun, fn: () => Promise<T>): Promise<T> {
  const next = run.queue.then(fn, fn);
  run.queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Read each of the brand's learned versions that is due, within the run's budget, and keep what
 * it read on the version's `lv:`. A worse read on a look the brand didn't set offers a Go back card
 * (or, under the attention rule, leaves it to the card's own notice), unless the person kept the
 * look at that read or a later one. No card is offered for a version with no look of its own (a
 * Forget, or an Undo of a first look), nor back to a look whose words a Forget took out: Go back
 * could never act on it.
 */
export async function runImageVerdicts(
  ctx: TenantContext,
  pointers: BrandPointers,
  versions: Partial<Record<string, VersionTotals>>,
  run: VerdictRun,
  deps: ImageVerdictDeps = {},
): Promise<ImageVerdictResult> {
  const now = deps.now ?? new Date();
  const out: ImageVerdictResult = { verdicts: [], rows: 0, deferred: false, dueAt: null };
  const soonest = (at: string | null) => {
    if (at && (!out.dueAt || at < out.dueAt)) out.dueAt = at;
  };
  let proposed = deps.proposedThisWeek ?? 0;
  for (const scope of IMAGE_STYLE_SCOPES) {
    const pointer = pointers.scopes[scope];
    if (!pointer || pointer.v <= 0) continue;
    const totals = versions[scope];
    const due = verdictDue(totals, now);
    if (!due.due) {
      soonest(due.at);
      continue;
    }
    if (!takeReads(run)) {
      out.deferred = true;
      continue;
    }
    // Only the seed's own version 1 is carried over (an Undo back to it is a version of its own): it
    // has nothing before it, its outputs start at the seed, and the version after it compares
    // against every image of the scope before its own start.
    const [row, prevRow] = await Promise.all([
      getPatternVersion(ctx, scope, pointer.v, deps.db),
      pointer.v > 1 ? getPatternVersion(ctx, scope, pointer.v - 1, deps.db) : Promise.resolve(null),
    ]);
    const carriedOver = row?.createdBy === "seed";
    const prevAdoptedAt = prevRow && prevRow.createdBy !== "seed" ? prevRow.createdAt : null;
    const got = await oneAtATime(run, () =>
      readVersionVerdict(
        ctx,
        { scope, v: pointer.v, adoptedAt: pointer.adoptedAt, carriedOver, prevAdoptedAt, seen: seenOf(totals), hasLook: hasLook(row), ...(totals?.after ? { after: totals.after } : {}) },
        { db: deps.db, now },
      ),
    );
    out.rows += got.rows;
    const lookKey = String(got.read.look ?? 0);
    const item: ScopeVerdict = { scope, v: pointer.v, read: got.read, check: got.check };
    // The check is replaced whole, so a read with no more to page through clears `more`.
    await mergeLoopDay(ctx, loopDayId.version(ctx.tenantId, scope, pointer.v), { check: { more: false, ...got.check }, looks: { [lookKey]: got.read }, after: got.after }, deps.db);
    if (got.check.pending) soonest(new Date(now.getTime() + LOOP_RULES.outcomeDays * DAY_MS).toISOString());
    // More of its images since it began are waiting to be read: the next visit reads on.
    if (got.check.more) soonest(now.toISOString());

    // A worse read offers to go back, never on a look a person set, and never on too few; only from
    // a look in use, to a look that can still come back.
    const canGoBack = hasLook(row) && row?.createdBy !== "forget" && (pointer.v - 1 === 0 || (prevRow !== null && !wordsRemoved(prevRow)));
    if (got.read.call === "worse" && got.read.look !== null && pointer.setBy !== "person" && canGoBack) {
      const previous = totals?.card;
      // Kept at this read or a later one, from a card or from the card's own notice.
      const keptLook = pointer.keptAt ? Math.max(pointer.keptLook ?? -1, previous?.look ?? -1) : -1;
      if (keptLook < got.read.look) {
        if (deps.noticeOnly && (await deps.noticeOnly().catch(() => false))) item.card = "notice";
        else {
          const r = await proposeGoBack(
            ctx,
            {
              scope,
              from: pointer.v,
              to: pointer.v - 1,
              proposedThisWeek: proposed,
              previous: previous ? { id: previous.id } : null,
              basis: { read: got.read, since: pointer.adoptedAt, evidence: row?.evidenceCounts ? { liked: row.evidenceCounts.liked, disliked: row.evidenceCounts.disliked, newestAt: row.evidenceCounts.newestAt } : null },
            },
            { db: deps.db, now },
          );
          item.card = r.outcome;
          if (r.outcome === "proposed" && r.id) {
            proposed += 1;
            await mergeLoopDay(ctx, loopDayId.version(ctx.tenantId, scope, pointer.v), { card: { id: r.id, look: got.read.look, at: now.toISOString() } }, deps.db);
          }
        }
      }
    }
    out.verdicts.push(item);
  }
  return out;
}
