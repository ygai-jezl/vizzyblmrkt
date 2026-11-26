import { forTenant } from "@/lib/tenant";
import { loopDayId, mergeLoopDay } from "@/lib/tenant/loops";
import { getPatternVersion } from "@/lib/tenant/patternVersions";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ImageAsset } from "@/lib/types/imageAsset";
import type { BrandPointers, LookRead, VersionCheck, VersionTotals } from "@/lib/types/loopDay";
import type { LoopStamp } from "@/lib/types/loopStamp";
import { proposeGoBack, type ProposeCardOutcome } from "./cards";
import { priorOf } from "./defaults";
import { versionCheckOf } from "./learners/votes";
import { imageScopeOf } from "./read";
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
 * - Outputs: a style's images (an image's scope is imageScopeOf its style, so images with no style
 *   are the brand look's), leaving out held back images, images made with "Use learned brand
 *   style" off, customised images and uploads, made at least LOOP_RULES.outcomeDays ago.
 * - The check: images voted within 14 days of being made; a hit is an up vote. The guard: every
 *   such image; a hit is a remake within 14 days. So each outcome is fixed in the order the images
 *   were made, as the verdict needs.
 * - Before: the images made while the version before was in use, read newest first back from the
 *   version's start (the `(tenantId, createdAt desc)` index); the images before those set where
 *   the scope's warm up ends. After: the images since its start, read oldest first, which needs
 *   the `(tenantId, createdAt asc)` index (firestore.indexes.json): a composite index serves one
 *   sort direction only. Both reads are projected to the fields used, at most
 *   LOOP_RULES.verdictRows rows each.
 * - It runs for a version with no read yet, and again once its made or voted counters moved (at
 *   most daily) or once images too new at the last read are old enough, within the run's budget
 *   of LOOP_RULES.laneVerdictReads reads.
 * Server only.
 */

const DAY_MS = 86_400_000;

const FIELDS = ["kind", "style", "createdAt", "made", "brandVote", "firstVotedAt", "remadeAt"] as const satisfies ReadonlyArray<keyof ImageAsset>;
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
  if (!Number.isFinite(at)) return { due: true, at: null };
  const moved = (check.seen ?? -1) !== seenOf(t);
  const daily = at + DAY_MS;
  const aged = check.pending ? at + LOOP_RULES.outcomeDays * DAY_MS : Infinity;
  const next = Math.min(moved ? daily : Infinity, aged);
  if (next <= now.getTime()) return { due: true, at: null };
  return { due: false, at: Number.isFinite(next) ? new Date(next).toISOString() : null };
}

/** The image's stamp, when it has one. */
const stampOf = (r: Row): LoopStamp | null => (r.made && !("unstamped" in r.made) ? (r.made as LoopStamp) : null);

/** Whether an image is one of the scope's outputs. */
function isOutput(scope: string, r: Row): boolean {
  if (r.kind === "customized" || r.kind === "upload") return false;
  if (imageScopeOf(r.style) !== scope) return false;
  const s = stampOf(r);
  if (s?.arm === "holdback" || (s?.sources ?? []).includes("person_off")) return false;
  return true;
}

const within = (from: string, to: string | null | undefined) => Boolean(to) && Date.parse(to!) - Date.parse(from) <= LOOP_RULES.outcomeDays * DAY_MS;
const checkEntry = (r: Row): boolean | null => (r.brandVote && within(r.createdAt, r.firstVotedAt) ? r.brandVote === "up" : null);
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

const oldestFirst = (a: Row, b: Row) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/**
 * Read one version: the images either side of its start, the verdict, its check, and its read.
 * Two reads of image rows.
 */
export async function readVersionVerdict(
  ctx: TenantContext,
  input: {
    scope: string;
    v: number;
    /** When the version began; null for a version carried over from before versions, whose outputs reach back to the scope's start. */
    adoptedAt: string | null;
    /** When the version before began; null when its outputs reach back to the scope's start (version 0, or a carried over one). */
    prevAdoptedAt: string | null;
    seen: number;
  },
  deps: { db?: FirestoreLike; now?: Date } = {},
): Promise<{ read: LookRead; check: VersionCheck; rows: number; verdictCall: string }> {
  const now = deps.now ?? new Date();
  const ripe = new Date(now.getTime() - LOOP_RULES.outcomeDays * DAY_MS).toISOString();
  const repo = forTenant(ctx, deps.db).imageAssets;
  const limit = LOOP_RULES.verdictRows;
  const start = input.adoptedAt;
  const [beforeRows, afterRows] = await Promise.all([
    start === null ? Promise.resolve([] as Row[]) : repo.findFields(FIELDS, { where: [["createdAt", "<", start]], orderBy: [["createdAt", "desc"]], limit }),
    repo.findFields(FIELDS, { where: start === null ? [] : [["createdAt", ">=", start]], orderBy: [["createdAt", "asc"]], limit }),
  ]);
  const mine = (rows: readonly Row[]) => rows.filter((r) => isOutput(input.scope, r));
  const before = mine(beforeRows).sort(oldestFirst);
  const after = mine(afterRows).sort(oldestFirst);
  const pending = [...before, ...after].some((r) => r.createdAt > ripe);
  const ripeOnly = (rows: Row[]) => rows.filter((r) => r.createdAt <= ripe);
  const prev = input.prevAdoptedAt;
  const earlier = entriesOf(ripeOnly(before.filter((r) => prev !== null && r.createdAt < prev)));
  const window = entriesOf(ripeOnly(before.filter((r) => prev === null || r.createdAt >= prev)));
  const since = entriesOf(ripeOnly(after));
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
  const read = lookReadOf(v, { usableBefore, after: since.check.length, at });
  const check: VersionCheck = {
    ...versionCheckOf({ beforeVotes: window.check.length, startsAt: startsAt.check, afterVotes: since.check.length, verdict: v, at }),
    seen: input.seen,
    pending,
  };
  return { read, check, rows: beforeRows.length + afterRows.length, verdictCall: v.call };
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
 * (or, under the attention rule, leaves it to the card's own notice).
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
    // A carried over version's outputs reach back to the scope's start: images made before the seed
    // used the same words. So it has nothing before it, and the version after it compares against all of them.
    const prevRow = pointer.v > 1 ? await getPatternVersion(ctx, scope, pointer.v - 1, deps.db) : null;
    const prevAdoptedAt = prevRow && prevRow.setBy !== "seeded" ? prevRow.createdAt : null;
    const adoptedAt = pointer.setBy === "seeded" ? null : pointer.adoptedAt;
    const got = await oneAtATime(run, () => readVersionVerdict(ctx, { scope, v: pointer.v, adoptedAt, prevAdoptedAt, seen: seenOf(totals) }, { db: deps.db, now }));
    out.rows += got.rows;
    const lookKey = String(got.read.look ?? 0);
    const item: ScopeVerdict = { scope, v: pointer.v, read: got.read, check: got.check };
    await mergeLoopDay(ctx, loopDayId.version(ctx.tenantId, scope, pointer.v), { check: got.check, looks: { [lookKey]: got.read } }, deps.db);
    if (got.check.pending) soonest(new Date(now.getTime() + LOOP_RULES.outcomeDays * DAY_MS).toISOString());

    // A worse read offers to go back, never on a look a person set, and never on too few.
    if (got.read.call === "worse" && got.read.look !== null && pointer.setBy !== "person") {
      const previous = totals?.card;
      const keptLater = pointer.keptAt && previous && previous.look >= got.read.look;
      if (!keptLater) {
        if (deps.noticeOnly && (await deps.noticeOnly().catch(() => false))) item.card = "notice";
        else {
          const version = await getPatternVersion(ctx, scope, pointer.v, deps.db).catch(() => null);
          const r = await proposeGoBack(
            ctx,
            {
              scope,
              from: pointer.v,
              to: pointer.v - 1,
              proposedThisWeek: proposed,
              previous: previous ? { id: previous.id } : null,
              basis: { read: got.read, since: pointer.adoptedAt, evidence: version?.evidenceCounts ? { liked: version.evidenceCounts.liked, disliked: version.evidenceCounts.disliked, newestAt: version.evidenceCounts.newestAt } : null },
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
