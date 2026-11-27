import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { meaningsOf, numberKeys } from "@/lib/metrics/meanings";
import { isRateLimited, type TenantContext } from "@/lib/tenant";
import { isoWeekStart, loopDayId, readLoopDays } from "@/lib/tenant/loops";
import type { FirestoreLike } from "@/lib/tenant/types";
import { BrandPointersSchema, LOOP_SIGNALS, type BrandPointers, type LoopDayDoc, type LoopSignal, type ScopePointer } from "@/lib/types/loopDay";
import type { VersionSetBy } from "@/lib/types/learnedPatternVersion";
import { loopWeekOf } from "./count";
import { isLoopsEnabled } from "./flags";
import { addTree, oldestKeptWeek, weekBefore } from "./fold";
import { isImageKind } from "./imageKinds";
import { lookName } from "./learnedWords";
import { keyWords, kindLabel, reasonWords, unstampedWords } from "./reasonWords";
import { decisionKind, IMAGE_STYLE_SCOPES, LOOP_RULES, LOOPS, type Decision, type DecisionKind, type LoopKind } from "./registry";
import { IMAGE_POOL, looksInUse, ROW_KINDS, rowKindOf, rowLine, rowsOfWeek, rowStage, STAGE_WEEKS, type LookInUse, type RowWeek, type Stage, type StuckStep } from "./stages";
import { tallyByKind, unusedForWeek } from "./tally";
import { shortDay } from "./verdictWords";

/**
 * For Vizzy's get_learning (/api/agent/learning, LOOPS_ENABLED, learning loops step 5, 4.10 of the
 * plan for steps 4 and 5): this brand's own learning, by kind of choice YouGrow makes for it. Each
 * kind comes with its line in the learning registry (how it learns, or why it doesn't), how far
 * learning got, where it is stuck and why, and its counts: what was made, what the team kept,
 * changed or turned down, what learners learned or refused, and the image looks in use.
 *
 * It reads only the brand's own `loop_days` documents by id (src/lib/tenant/loops.ts): `lb:` (its
 * pointers), `lt:` (its folded weeks), `lw:` (the shards of the open week, and of a closed week not
 * yet folded) and `lv:` (the totals of the looks in use). Never `ls:`, never `lk:`, and never the
 * counts across brands (`fleet_cells`), which no brand's agent reads. At most two batched reads of
 * small counter documents, bounded by the weeks asked for. By default the last 90 days, with the
 * kinds the brand made something with, learning kinds first; the rest come by name or all at once.
 * Raw keys stay here, beside their plain words. Read only; the brand comes from the signed canvas
 * token, never from the request. Server only.
 */

export type ApiResult = { status: number; body: unknown };

const LIMIT = { prefix: "learning_agent", burstLimit: 10, hourlyLimit: 120 };

/** The days get_learning covers: 90 unless asked, from 7 up to 182 (26 weeks of folded counts). */
export const LEARNING_DAYS = { fallback: 90, min: 7, max: 182 } as const;

/** Kinds asked for by name, at most. */
export const KINDS_ASKED_MAX = 20;

/**
 * The documents one answer reads at most, in two batched reads: the pointers, the closed weeks'
 * folded copies (25 at 182 days) and the open week's shards; then the 8 looks and the shards of the
 * closed weeks not yet folded whose shards may still be kept (10).
 */
export const LEARNING_READS_MAX =
  1 + (Math.ceil(LEARNING_DAYS.max / 7) - 1) + LOOP_RULES.shards + IMAGE_STYLE_SCOPES.length + Math.floor(LOOP_RULES.shardDays / 7) * LOOP_RULES.shards;

// ----- Words -----

/** The image pool's line: the five image kinds learn one look per painted style. */
export const POOL_HOW = "Learns a look for each painted image style from your team's votes, uses it in new images and checks each new look against the one before.";

/** A learns line outside a pool (none yet). */
const LEARNS_HOW = "Learns for this brand from what your team does with it, and checks each change.";

/** How far learning got for a kind in these weeks, in words. */
export const STATUS_WORDS = {
  nothing_made: "Nothing made in these weeks.",
  stamped: {
    learns: "Made, and your team hasn't kept, changed, turned down or voted on any of it yet.",
    own: "Made. It learns from your team in its own way, as its line says.",
    gap: "Made. It doesn't learn from your team yet, as its line says.",
    none: "Made. It never learns from people, as its line says.",
    fleet: "Made. It is improved for every brand at once, never for one brand.",
  } satisfies Record<DecisionKind, string>,
  signalled: "Your team kept, changed, turned down or voted on some of it, and nothing was learned from that in these weeks.",
  learning: "Learning: something was learned in these weeks, or a learned look is in use.",
  checked: "Checked: a check has read a learned look in use.",
} as const;

/** Where a kind is stuck, by the per brand rule over the last closed weeks, and the learner's most common reason. */
export function stuckWords(at: StuckStep, topReason: string | null): string {
  const rule = `for ${STAGE_WEEKS} weeks, or while ${LOOP_RULES.stallOutputs} more were made`;
  const line =
    at === "stamped"
      ? `Stuck: made ${rule}, with nothing kept, changed, turned down or voted on.`
      : `Stuck: your team answered it ${rule}, and nothing was learned.`;
  return topReason ? `${line} The learner's most common reason: ${reasonWords(topReason, "inline")}.` : line;
}

/** Who set a look in use. */
export const SET_BY_WORDS: Record<VersionSetBy, string> = {
  learned: "Learned from your team's votes",
  person: "Written by your team",
  seeded: "Carried over from before YouGrow kept versions",
  fleet: "Set for every brand on this copy",
};

/** What each count in an answer means. */
export const COUNT_WORDS = {
  days: "The days these counts cover, ending today, read as whole weeks from Monday.",
  weeksNotYetAddedUp: "Closed weeks whose counts were read from their weekly counters, because the daily adding up hasn't reached them yet.",
  made: "Things of this kind YouGrow made for the brand and saved, or handed to your team to save.",
  kept: "Used with no change.",
  edited: "Used after a person changed them.",
  declined: "Turned down: dismissed, skipped or swapped by a person.",
  voted: "Images voted On-brand or Off-brand.",
  liked: "Images voted On-brand. A changed vote moves the count.",
  remade: "Images made again in the same place within 14 days.",
  undone: "Learned looks or versions a person undid.",
  reversed: "Learned looks a person sent back to an earlier one with Go back.",
  learned: "Times a learner learned something new for the brand.",
  times: "How many times, in these weeks.",
  heldBack: "Images made without the learned look, about 1 in 20, so YouGrow can check that learning helps.",
  version: "The look's version, counted from 1.",
  moreKinds: "Other kinds in the learning registry with nothing to show in these weeks: ask for them by name, or for all of them.",
} as const;

export const NOTE =
  "This brand's own counts, never another brand's. Each kind is one place YouGrow makes a choice for the brand, with its line in `line` (learns, own, gap, none or fleet) and how it learns, or why it doesn't, in `how`. " +
  "Learning kinds come first. `status` is how far learning got in these weeks, and `stuck` reads the last 4 closed weeks. " +
  "Counts start when learning counts were turned on for this copy, and image counts once image style versions are, so weeks before read 0. They may undercount a little: a count that fails is let go. " +
  "Shares are of things made in these weeks, and an answer in these weeks can be for something made just before them. `unusedShare` counts only weeks with 2 closed weeks after them. " +
  "A look's counts run through its last added up week. For each look's words and its checks in words, call get_image_style. " +
  "Keys such as `kind`, `reason` and `why` are for asking again: say the labels and words.";

// ----- The gate and the query -----

export async function learningAgentGate(req: Request): Promise<{ ok: true; ctx: TenantContext } | { ok: false; result: ApiResult }> {
  if (!isLoopsEnabled()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  const ctx = tenantContextFromCanvasToken(verified.claims);
  if (await isRateLimited(`tenant:${ctx.tenantId}`, LIMIT)) return { ok: false, result: { status: 429, body: { error: "rate_limited" } } };
  return { ok: true, ctx };
}

export interface LearningQuery {
  /** Kinds by key or label, such as `edit_mode` or "Post images"; `image_style` or "Image style" for the image looks. */
  kinds?: string[];
  /** Every kind in the learning registry, made or not. */
  all?: boolean;
  days?: number;
}

/** `?kinds=a,b&all=1&days=90`, each part optional. */
export function parseLearningQuery(params: URLSearchParams): LearningQuery {
  const kinds = (params.get("kinds") ?? "")
    .split(",")
    .map((k) => k.trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, KINDS_ASKED_MAX);
  const all = ["1", "true", "yes"].includes((params.get("all") ?? "").trim().toLowerCase());
  const raw = params.get("days");
  const days = raw !== null && raw.trim() !== "" ? Number(raw) : NaN;
  return { ...(kinds.length ? { kinds } : {}), ...(all ? { all } : {}), ...(Number.isFinite(days) ? { days } : {}) };
}

/** The days an answer covers: 90 unless asked, kept from 7 to 182. */
export function daysOf(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days) || days <= 0) return LEARNING_DAYS.fallback;
  return Math.min(LEARNING_DAYS.max, Math.max(LEARNING_DAYS.min, Math.round(days)));
}

// ----- Kinds by name -----

const isLoopKind = (k: string): k is LoopKind => Object.prototype.hasOwnProperty.call(LOOPS, k);

/** Every row's key and label, lower case, to the row: a kind in the image pool finds the pool. */
const BY_NAME: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  const put = (name: string, row: string) => {
    const k = name.trim().toLowerCase();
    if (k && !m.has(k)) m.set(k, row);
  };
  put(IMAGE_POOL, IMAGE_POOL);
  put(kindLabel(IMAGE_POOL), IMAGE_POOL);
  for (const kind of Object.keys(LOOPS)) {
    const row = rowKindOf(kind);
    if (row) put(kind, row);
  }
  for (const kind of Object.keys(LOOPS)) {
    const row = rowKindOf(kind);
    if (row) put(kindLabel(kind), row);
  }
  return m;
})();

/** The row a name asks for: a kind's key or label, or the image pool's; null for none. */
export function rowOfName(name: string): string | null {
  return BY_NAME.get(name.trim().toLowerCase()) ?? null;
}

/** A row's line: which of the five, how it learns or why not, and a gap's date to look again. */
function lineOf(row: string): { line: DecisionKind; how: string; revisit?: string } {
  if (row === IMAGE_POOL || !isLoopKind(row)) return { line: "learns", how: POOL_HOW };
  const d = LOOPS[row] as Decision;
  const line = decisionKind(d);
  if ("own" in d) return { line, how: d.why };
  if ("none" in d) return { line, how: d.none };
  if ("gap" in d) return { line, how: d.gap, revisit: d.revisit };
  if ("fleet" in d) return { line, how: d.fleet };
  return { line, how: LEARNS_HOW };
}

const LINE_ORDER: Record<DecisionKind, number> = { learns: 0, own: 1, fleet: 2, gap: 3, none: 4 };

// ----- Adding up a row's weeks -----

type Counts = Record<string, number>;
type Tree = Record<string, unknown>;
const isObj = (v: unknown): v is Tree => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const addInto = (into: Counts, from: Counts) => {
  for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n;
};
const share = (n: number, of: number): number | null => (of > 0 ? Math.round(Math.min(1, Math.max(0, n / of)) * 100) / 100 : null);
const dayOf = (iso: string | undefined): string | null => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

interface RowTotals {
  made: number;
  learned: number;
  refused: Counts;
  /** By signal, every arm added up. */
  out: Counts;
  unstamped: Counts;
  declinedWhy: Counts;
  cards: Counts;
  own: Counts;
}

function totalsOf(weeks: ReadonlyArray<RowWeek | undefined>): RowTotals {
  const t: RowTotals = { made: 0, learned: 0, refused: {}, out: {}, unstamped: {}, declinedWhy: {}, cards: {}, own: {} };
  for (const w of weeks) {
    if (!w) continue;
    t.made += w.made;
    t.learned += w.learned;
    addInto(t.refused, w.refused);
    for (const signals of Object.values(w.out)) addInto(t.out, signals);
    addInto(t.unstamped, w.unstamped);
    addInto(t.declinedWhy, w.declinedWhy);
    addInto(t.cards, w.cards);
    addInto(t.own, w.own);
  }
  return t;
}

/** A count list, most first, each key kept beside its words. */
function listOf(counts: Counts, key: "reason" | "why", words: (k: string) => string): Array<Record<string, string | number>> {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => ({ [key]: k, words: words(k), times: n }));
}

/** A look in use, as Vizzy reads it: counts only, the words through get_image_style. */
function lookOf(scope: string, p: ScopePointer, d: unknown) {
  const c = isObj(d) && isObj(d.c) ? d.c : {};
  const sum = (arm: string, signal: string) =>
    Object.values(c).reduce<number>((n, byArm) => n + (isObj(byArm) && isObj(byArm[arm]) ? num((byArm[arm] as Tree)[signal]) : 0), 0);
  const made = sum("learned", "made");
  const voted = sum("learned", "voted");
  const liked = sum("learned", "liked");
  const remade = sum("learned", "remade");
  const checked = isObj(d) && isObj(d.looks) && Object.keys(d.looks).some((look) => look !== "0");
  const through = isObj(d) && typeof d.throughWeek === "string" ? d.throughWeek : null;
  return {
    scope,
    style: lookName(scope),
    version: p.v,
    setBy: p.setBy,
    setByWords: SET_BY_WORDS[p.setBy],
    since: dayOf(p.adoptedAt),
    ...(p.keptAt ? { keptSince: dayOf(p.keptAt) } : {}),
    checked,
    made,
    voted,
    liked,
    remade,
    heldBack: sum("holdback", "made"),
    likedShare: share(liked, voted),
    remadeShare: share(remade, made),
    countedThrough: through,
  };
}

const parsePointers = (d: unknown): BrandPointers => {
  const p = BrandPointersSchema.safeParse(d ?? {});
  return p.success ? p.data : BrandPointersSchema.parse({});
};

// ----- The answer -----

export interface LearningDeps {
  db?: FirestoreLike;
  now?: Date;
  /** Reads the brand's loop documents by id (readLoopDays by default): tests see which ids are read. */
  read?: (ids: readonly string[]) => Promise<Array<LoopDayDoc | null>>;
}

/** The signals a kind shows, beside made: words kinds' answers, and images' votes. */
const PERSON_SIGNALS = LOOP_SIGNALS.filter((s): s is Exclude<LoopSignal, "made"> => s !== "made");

export async function agentLearning(ctx: TenantContext, q: LearningQuery = {}, deps: LearningDeps = {}): Promise<ApiResult> {
  const now = deps.now ?? new Date();
  const read = deps.read ?? ((ids: readonly string[]) => readLoopDays(ctx, ids, deps.db));
  const days = daysOf(q.days);
  const open = loopWeekOf(now);
  // The weeks shown cover the days asked; the weeks read also hold the stuck rule's closed weeks.
  const shown = Math.ceil(days / 7);
  const span = Math.max(shown, STAGE_WEEKS + 1);
  const weeks: string[] = [];
  for (let w = open, i = 0; i < span; i++, w = weekBefore(w)) weeks.unshift(w);
  const closed = weeks.slice(0, -1);
  const shardsOf = (w: string) => Array.from({ length: LOOP_RULES.shards }, (_, i) => loopDayId.week(ctx.tenantId, w, i));
  const addUp = (docs: ReadonlyArray<LoopDayDoc | null>): Tree | undefined => {
    if (!docs.some(Boolean)) return undefined;
    const sum: Tree = {};
    for (const doc of docs) addTree(sum, doc?.d);
    return sum;
  };

  // 1. The pointers, the folded weeks and the open week's shards, in one batched read.
  const first = await read([loopDayId.brand(ctx.tenantId), ...closed.map((w) => loopDayId.folded(ctx.tenantId, w)), ...shardsOf(open)]);
  const pointers = parsePointers(first[0]?.d);
  const data = new Map<string, unknown>(closed.map((w, i) => [w, first[1 + i]?.d]));
  data.set(open, addUp(first.slice(1 + closed.length)));

  // 2. The looks in use, and the shards of closed weeks the lane hasn't folded yet, in one more.
  // With image style versions off, images use the look on the brand record (decision 22), so no
  // learned look is in use: none is read or listed, whatever the pointers still hold.
  const versionsOn = isImageStyleVersionsOn();
  const scopes = versionsOn
    ? IMAGE_STYLE_SCOPES.filter((s) => (pointers.scopes[s]?.v ?? 0) >= 1 && pointers.forgot?.[s]?.at !== pointers.scopes[s]?.adoptedAt)
    : [];
  const oldest = oldestKeptWeek(now);
  const unfolded = closed.filter((w) => data.get(w) === undefined && w >= oldest);
  const second = [...scopes.map((s) => loopDayId.version(ctx.tenantId, s, pointers.scopes[s]!.v)), ...unfolded.flatMap(shardsOf)];
  const more = second.length ? await read(second) : [];
  const totals = new Map<string, unknown>(scopes.map((s, i) => [s, more[i]?.d]));
  let notYetAddedUp = 0;
  unfolded.forEach((w, i) => {
    const sum = addUp(more.slice(scopes.length + i * LOOP_RULES.shards, scopes.length + (i + 1) * LOOP_RULES.shards));
    if (sum) {
      data.set(w, sum);
      if (weeks.indexOf(w) >= weeks.length - shown) notYetAddedUp += 1;
    }
  });

  // Each week read by row once.
  const byRow = weeks.map((w) => rowsOfWeek(data.get(w)));
  const shownAt = weeks.length - shown;
  const shownRows = byRow.slice(shownAt);
  const stuckRows = byRow.slice(-1 - STAGE_WEEKS, -1);
  const looks: LookInUse[] = versionsOn ? looksInUse(pointers, totals) : [];
  const lastClosedEnd = isoWeekStart(open);

  // Made per image kind in the pool, and made and unused per words kind, from weeks with 2 closed after them.
  const poolMade: Counts = {};
  const unusedMade: Counts = {};
  const unused: Counts = {};
  for (let j = shownAt; j < weeks.length; j++) {
    const d = data.get(weeks[j]!);
    const tally = tallyByKind(d);
    for (const [kind, t] of tally) if (rowKindOf(kind) === IMAGE_POOL && t.made > 0) poolMade[kind] = (poolMade[kind] ?? 0) + t.made;
    if (j + 2 > weeks.length - 2) continue;
    for (const [kind, n] of unusedForWeek([d, data.get(weeks[j + 1]!), data.get(weeks[j + 2]!)])) {
      const row = rowKindOf(kind);
      if (!row) continue;
      unusedMade[row] = (unusedMade[row] ?? 0) + Math.max(0, tally.get(kind)?.made ?? 0);
      unused[row] = (unused[row] ?? 0) + n;
    }
  }

  // Which kinds: asked by name, all of them, or those with something made or learned in these weeks.
  const notFound: string[] = [];
  let rows: string[];
  if (q.all) rows = [...ROW_KINDS];
  else if (q.kinds?.length) {
    const asked = new Set<string>();
    for (const name of q.kinds) {
      const row = rowOfName(name);
      if (row) asked.add(row);
      else notFound.push(name);
    }
    rows = [...asked];
  } else {
    const active = new Set<string>();
    for (const m of shownRows) {
      for (const [row, w] of m) if (w.made > 0 || w.learned > 0 || Object.keys(w.refused).length > 0) active.add(row);
    }
    if (scopes.length > 0) active.add(IMAGE_POOL);
    rows = [...active].filter((r) => ROW_KINDS.includes(r));
  }

  const entries = rows.map((row) => {
    const line = lineOf(row);
    const t = totalsOf(shownRows.map((m) => m.get(row)));
    const pool = row === IMAGE_POOL;
    const rowLooks = pool ? looks : [];
    const reached: Stage | null = rowStage(row, shownRows.map((m) => m.get(row)), rowLooks, now).reached;
    const st = rowStage(row, stuckRows.map((m) => m.get(row)), rowLooks, lastClosedEnd);
    const status = reached ?? "nothing_made";
    const statusWords = reached === null ? STATUS_WORDS.nothing_made : reached === "stamped" ? STATUS_WORDS.stamped[line.line] : STATUS_WORDS[reached];
    const counts: Record<string, number> = { made: Math.max(0, t.made) };
    for (const s of PERSON_SIGNALS) if ((t.out[s] ?? 0) > 0) counts[s] = t.out[s]!;
    const words = !pool && !isImageKind(row);
    const learner = rowLine(row).learns || t.learned > 0 || Object.keys(t.refused).length > 0;
    return {
      kind: row,
      label: kindLabel(row),
      line: line.line,
      how: line.how,
      ...(line.revisit ? { revisit: line.revisit } : {}),
      status,
      statusWords,
      stuck: st.stuck ? { at: st.stuck, words: stuckWords(st.stuck, st.topReason), reason: st.topReason, reasonWords: st.topReason ? reasonWords(st.topReason) : null } : null,
      counts,
      ...(words
        ? {
            shares: {
              keptShare: share(counts.kept ?? 0, counts.made!),
              editShare: share(counts.edited ?? 0, counts.made!),
              declineShare: share(counts.declined ?? 0, counts.made!),
              unusedShare: share(unused[row] ?? 0, unusedMade[row] ?? 0),
            },
          }
        : {}),
      ...(learner ? { learner: { learned: t.learned, refused: listOf(t.refused, "reason", (r) => reasonWords(r)) } } : {}),
      ...(Object.keys(t.declinedWhy).length ? { declinedWhy: listOf(t.declinedWhy, "why", keyWords) } : {}),
      ...(Object.keys(t.unstamped).length ? { unstamped: listOf(t.unstamped, "reason", unstampedWords) } : {}),
      ...(pool
        ? {
            byKind: Object.entries(poolMade)
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .map(([kind, made]) => ({ kind, label: kindLabel(kind), made })),
            looks: scopes.map((s) => lookOf(s, pointers.scopes[s]!, totals.get(s))),
            ...(Object.keys(t.own).length ? { ownImages: { voted: t.own.voted ?? 0, liked: t.own.liked ?? 0 } } : {}),
            ...(Object.keys(t.cards).length ? { goBackCards: t.cards } : {}),
          }
        : {}),
    };
  });
  entries.sort((a, b) => LINE_ORDER[a.line] - LINE_ORDER[b.line] || b.counts.made! - a.counts.made! || a.label.localeCompare(b.label));

  const optOut = pointers.fleetOptOut?.at;
  const paused = pointers.pause?.image_style?.at;
  const body = {
    days,
    weeks: { from: weeks[shownAt]!, to: open, startsOn: dayOf(isoWeekStart(weeks[shownAt]!).toISOString()), openWeek: open, weeksNotYetAddedUp: notYetAddedUp },
    countsAcrossBrands: optOut
      ? { included: false, since: dayOf(optOut), words: `Left out of the counts across brands since ${shortDay(optOut)}: this brand's counts stay with this brand.` }
      : { included: true, words: "Counted, with every other brand on this copy, as counts of organisations only." },
    imageLearning: paused ? { paused: true, since: dayOf(paused), words: `Image learning paused since ${shortDay(paused)}: the looks in use stay, and nothing new is learned.` } : { paused: false },
    kinds: entries,
    ...(notFound.length ? { notFound } : {}),
    moreKinds: Math.max(0, ROW_KINDS.length - entries.length),
    note: NOTE,
    countWords: COUNT_WORDS,
  };
  return { status: 200, body: { ...body, meanings: meaningsOf(numberKeys(body)) } };
}
