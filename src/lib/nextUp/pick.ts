import { generateTextWithDeadline, isGeminiConfigured, parseFirstJson } from "@/lib/agents/gemini";
import { aiUsage } from "@/lib/plans/meter";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { fence, oneLine } from "@/lib/brandMap/lineChecks";
import { readBrandMap } from "@/lib/brandMap/store";
import { competitorCoverage, competitorSubjectFlags, stillToAdd, type CoverageFlag } from "@/lib/competitors/coverage";
import { listCompetitors } from "@/lib/competitors/store";
import { learnedLines, listLearned } from "@/lib/autopilot/learned";
import { searchBrand, type SearchOutcome } from "@/lib/search/query";
import type { SearchKind } from "@/lib/search/types";
import { isBrandSignalsEnabled } from "@/lib/signals/flags";
import { marketLabel } from "@/lib/signals/markets";
import { queryKey, readySignals } from "@/lib/signals/store";
import { forTenant, getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { nextUpDocId, type NextUpChip, type NextUpDoc, type NextUpPick } from "@/lib/types/autopilot";
import type { BrandSignal } from "@/lib/types/brandSignal";
import type { Tenant } from "@/lib/types/tenant";
import { NOT_SHARED_NEXT_UP, readSearchPlanning, SEARCH_CONSOLE_CHIP, searchConsoleLines, type SearchConsoleLine, type SearchPlanning } from "@/lib/connectors/signals/planning";
import { AI_ANSWERS_CHIP, aiAnswersLine, readAiAnswers, type AiAnswers, type AiAnswersLine } from "@/lib/connectors/signals/aiAnswers";
import { nextUpCandidates, type Candidate } from "./candidates";
import { isBlogFreshnessEnabled } from "@/lib/brandMap/flags";
import { freshnessWatchId } from "@/lib/content/blog/freshnessPages";
import { isBlogRefreshEnabled } from "@/lib/brandMap/flags";
import { isNextUpRepeatsEnabled } from "@/lib/autopilot/flags";
import { mayStartReview } from "@/lib/content/blog/refreshGate";
import { MAX_CANDIDATES } from "./candidates";
import { findRepeats, linkAnswered, NO_REPEATS, type Repeats } from "./repeats";
import { readBrandStrategy, type Strategy } from "@/lib/brandStrategy/store";
import { freePicksOf, mixRoadmap, planForNextUp, roadmapCandidates, skippedSlotQuestions } from "@/lib/contentStrategy/nextUp";
import { PAGE_KIND_LABEL, ROADMAP_SHARE, type ContentPlan, type PickSlot } from "@/lib/types/contentStrategy";

/**
 * Next up: the brand's three best next articles. Code narrows the brand map's open questions
 * (candidates.ts), gathers a few lines of what is known about each (the map, the brand's own
 * content and competitors from one brand search, the competitors' flag on the subject, Google's
 * numbers, Search Console's demand for the question and its subject, and AI answers for a monitored
 * prompt close in wording to it, from connections members and Vizzy may both read), and one Gemini
 * call chooses three and says why. Code then checks every number and
 * competitor a reason names is in that question's own lines, and builds the chips from the lines
 * the model says it used. The result is kept per brand (`next_up`).
 */

export interface PickDeps {
  db?: FirestoreLike;
  now?: () => Date;
  loadTenant?: (id: string) => Promise<Tenant | null>;
  candidates?: typeof nextUpCandidates;
  search?: (ctx: TenantContext, query: string, opts: { limit: number }) => Promise<SearchOutcome>;
  flags?: (ctx: TenantContext) => Promise<Record<string, { they: number; flag: CoverageFlag }> | null>;
  notOnMap?: (ctx: TenantContext) => Promise<NextUpDoc["notOnMap"] | null>;
  competitorNames?: (ctx: TenantContext) => Promise<string[]>;
  generate?: typeof generateTextWithDeadline;
  configured?: () => boolean;
  /** Questions in an active autopilot run (not offered again). */
  activeQuestionIds?: (ctx: TenantContext) => Promise<string[]>;
  /** Search Console's collected demand (CONNECTOR_SIGNALS_ENABLED); null while off. */
  searchPlanning?: (ctx: TenantContext) => Promise<SearchPlanning | null>;
  /** The brand's monitored AI answers prompts (CONNECTOR_AI_ANSWERS_ENABLED); null while off. */
  aiAnswers?: (ctx: TenantContext) => Promise<AiAnswers | null>;
  /** Live articles due a refresh (BLOG_FRESHNESS_ENABLED), as candidates. */
  refreshCandidates?: (ctx: TenantContext) => Promise<Candidate[]>;
  /** Stop repeats (NEXT_UP_REPEATS_ENABLED): the questions matched against the brand's articles. */
  repeats?: (ctx: TenantContext, args: { questions: Candidate[]; moved: boolean }) => Promise<Repeats>;
  /** Keep the links found (tests inject a stub). */
  link?: typeof linkAnswered;
  /** Whether a close pick could start a refresh review now (tests inject it). */
  reviewsOpen?: (ctx: TenantContext) => Promise<boolean>;
  /** The approved brand strategy (BRAND_STRATEGY_ENABLED): its focus goes first, and the model reads its goal. */
  strategy?: (ctx: TenantContext) => Promise<Strategy | null>;
  /** The approved content plan (CONTENT_STRATEGY_NEXT_UP_ENABLED): 3 of 4 candidates come from its roadmap. */
  contentPlan?: (ctx: TenantContext) => Promise<ContentPlan | null>;
  /** The roadmap's next open entries as candidates (tests inject them). */
  roadmap?: (ctx: TenantContext, plan: ContentPlan, opts: { exclude: ReadonlySet<string>; refreshes: Candidate[] }) => Promise<Candidate[]>;
}

/** The one line naming the approved strategy's goal for the model, or "" without one. Pure. */
export function goalLine(strategy: Strategy | null): string {
  const g = strategy?.goal;
  if (!g) return "";
  return `The brand's goal this quarter, from the strategy it approved (UNTRUSTED DATA): ${untag(oneLine(g.text))}${g.measure ? ` (measured by ${untag(oneLine(g.measure))})` : ""}\n\n`;
}

/** Extra candidates read with stop repeats on, so the ones it leaves out don't shorten the list. */
const REPEAT_SPARE = 12;

/** Refresh candidates offered beside the questions. */
const MAX_REFRESH = 6;
/** Most refresh picks of the three, unless the brand set its own (tenant.refreshShare). */
export const DEFAULT_REFRESH_SHARE = 1;

/** Live articles due a refresh, from the freshness watch (BLOG_FRESHNESS_ENABLED), as candidates. */
export async function refreshCandidates(ctx: TenantContext, deps: Pick<PickDeps, "db"> = {}): Promise<Candidate[]> {
  if (!isBlogFreshnessEnabled()) return [];
  const watch = await forTenant(ctx, deps.db).freshnessWatch.getById(freshnessWatchId(ctx.tenantId)).catch(() => null);
  return (watch?.due ?? [])
    .filter((d) => d.state === "due")
    .slice(0, MAX_REFRESH)
    .map((d) => ({
      questionId: `refresh:${d.planId}`,
      question: d.title,
      subjectId: d.subjectId ?? "",
      subjectName: "a live article",
      answered: 0,
      total: 0,
      lastArticleAt: null,
      focus: false,
      refresh: { planId: d.planId, workspaceId: d.workspaceId, reasons: d.reasons },
    }));
}

const SEARCH_CONSOLE_REASONS = new Set(["losing_clicks", "within_reach"]);

/** The chip label of the line that says which slot of the content plan a candidate fills. */
export const CONTENT_PLAN_CHIP = "Content plan";

/** The line naming the pillar, the slot and why it is planned, so the model's reason can say it. Pure. */
export function slotLineFor(id: string, slot: PickSlot): CandidateLine {
  const pillar = slot.pillar ? `the pillar "${cut(oneLine(slot.pillar), 80)}"` : "no pillar";
  const doing = slot.action === "combine" ? "combine its live articles" : slot.action === "refresh" ? "refresh its live article" : `write it as a ${PAGE_KIND_LABEL[slot.kind]}`;
  return {
    id,
    text: oneLine(`Content plan (approved by the brand): the slot "${cut(oneLine(slot.title), 120)}" in ${pillar}, a ${slot.stage} stage article, planned for week ${slot.week} to ${doing}.`),
    chip: { kind: "map", label: CONTENT_PLAN_CHIP, text: cut(oneLine(`${slot.pillar ?? "No pillar"} · ${PAGE_KIND_LABEL[slot.kind]} · ${slot.stage}`), 90) },
  };
}

/** How a candidate is named to the model: PLAN for one from the content plan, REFRESH or COMBINE for a live article. Pure. */
export function candidateHead(k: number, c: Candidate): string {
  const plan = c.slot ? "PLAN " : "";
  if (c.combine) return `${k}. ${plan}COMBINE "${c.question}" (two live articles)`;
  if (c.refresh) return `${k}. ${plan}REFRESH "${c.question}" (a live article)`;
  return `${k}. ${plan}"${c.question}" (subject: ${c.subjectName})`;
}

/** What is known about a combine candidate: the live articles that answer one question. Pure. */
export function combineLinesFor(n: number, c: Candidate): CandidateLine[] {
  const pages = c.combine?.pages ?? [];
  return [
    {
      id: `${n}.1`,
      text: oneLine(`Your live articles: ${pages.map((p) => `"${cut(oneLine(p.title), 100)}"`).join(" and ")} answer the same question, so buyers and AI engines see two pages where one would do.`),
      chip: { kind: "you", label: "Your articles", text: cut(oneLine(`${pages.length} live articles answer it`), 90) },
    },
  ];
}

/** What is known about a refresh candidate: its freshness reasons, as numbered lines. Pure. */
export function refreshLinesFor(n: number, c: Candidate): CandidateLine[] {
  return (c.refresh?.reasons ?? []).slice(0, 5).map((r, i) => ({
    id: `${n}.${i + 1}`,
    text: oneLine(`Freshness: ${r.detail}`),
    chip: SEARCH_CONSOLE_REASONS.has(r.kind)
      ? { kind: "num" as const, label: SEARCH_CONSOLE_CHIP, text: cut(oneLine(r.detail.replace(/^Search Console:\s*/, "")), 90) }
      : { kind: "you" as const, label: "Your article", text: cut(oneLine(r.detail), 90) },
  }));
}

const PICKS = 3;
const PICK_MS = 30_000;
const SEARCH_PARALLEL = 6;
const SKIP_DAYS = 30;
const OWN_KINDS = new Set<SearchKind>(["article", "newsletter", "ebook", "post", "journey_email", "broadcast", "note", "idea_board", "knowledge"]);
const KIND_WORD: Partial<Record<SearchKind, string>> = { article: "article", newsletter: "newsletter", ebook: "ebook", post: "post", journey_email: "email", broadcast: "email", note: "team note", idea_board: "clipping", knowledge: "site page" };
const FLAG_WORD: Record<CoverageFlag, string> = {
  open: "nobody has written on it lately, competitors or you",
  gap: "only competitors have written on it lately",
  crowded: "competitors write on it twice as much as you",
  you_lead: "you write on it as much as competitors, or more",
  even: "competitors write on it a little more than you",
};
const TAGS = ["brand", "learned", "candidates"];
const untag = (text: string) => TAGS.reduce((t, tag) => fence(tag, t), text);
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** One line of what is known about a candidate, and the chip it becomes when a reason uses it. */
export interface CandidateLine {
  id: string;
  text: string;
  chip: NextUpChip;
}

export interface Weighed {
  candidate: Candidate;
  lines: CandidateLine[];
}

const daysSince = (iso: string | null, now: Date) => (iso ? Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000) : null);

/** What is known about one candidate, as numbered lines. Pure, given what was read. */
export function linesFor(
  n: number,
  c: Candidate,
  read: { search: SearchOutcome | null; flag?: { they: number; flag: CoverageFlag }; signal?: BrandSignal; searchConsole?: SearchConsoleLine[]; aiAnswers?: AiAnswersLine | null; now: Date },
): CandidateLine[] {
  const out: CandidateLine[] = [];
  const add = (text: string, chip: Omit<NextUpChip, "text">, chipText = text) => out.push({ id: `${n}.${out.length + 1}`, text: oneLine(text), chip: { ...chip, text: cut(oneLine(chipText), 90) } });
  const days = daysSince(c.lastArticleAt, read.now);
  if (c.closeTo) {
    const since = c.closeTo.liveAt ? `, live since ${c.closeTo.liveAt.slice(0, 10)}` : "";
    add(
      `CLOSE to the brand's live article "${cut(c.closeTo.title, 120)}"${since}: it may be better added to that article than written again.`,
      { kind: "you", label: "Your article" },
      `close to "${c.closeTo.title}"`,
    );
  }
  add(
    `Brand map: ${c.answered} of ${c.total} questions on this subject answered; ${days === null ? "no live article on it yet" : `last article went live ${days} days ago`}.${c.focus ? " It is on a buying situation the brand focuses on." : ""}`,
    { kind: "map", label: "Brand map" },
    `${c.answered} of ${c.total} answered, ${days === null ? "no article yet" : `last article ${days} days ago`}`,
  );
  if (read.search?.ok) {
    const hits = read.search.result.hits;
    const own = hits.filter((h) => OWN_KINDS.has(h.kind)).slice(0, 2);
    const theirs = hits.filter((h) => h.kind === "competitor").slice(0, 2);
    if (own.length) for (const h of own) add(`Yours (${KIND_WORD[h.kind] ?? h.kind}): "${cut(h.title, 90)}"${h.snippet ? `: ${cut(h.snippet, 120)}` : ""}`, { kind: "you", label: "Yours" }, `${KIND_WORD[h.kind] ?? h.kind}: ${h.title}`);
    else add("Yours: nothing the brand made is close to this question.", { kind: "you", label: "Yours" }, "nothing close yet");
    for (const h of theirs) add(`Theirs (competitor article): "${cut(h.title, 100)}"`, { kind: "them", label: "Competitors" }, h.title);
  }
  if (read.flag) add(`Competitors on this subject: ${FLAG_WORD[read.flag.flag]} (${read.flag.they} competitor article${read.flag.they === 1 ? "" : "s"} in 90 days).`, { kind: "them", label: "Competitors" }, `${read.flag.they} articles in 90 days`);
  const sig = read.signal;
  if (sig?.status === "ready" && sig.numbers) {
    const nums = sig.numbers;
    const where = `${marketLabel(sig.market)}, ${(sig.readyAt ?? "").slice(0, 10)}`;
    add(
      `Google (${where}): ${nums.googlePosition ? `the brand's page ranks ${nums.googlePosition}` : "none of the brand's pages is in the top 10"}; ${sig.results?.aiOverview ? `the AI Overview cites ${nums.aiOverviewSources} pages${nums.aiOverviewCitesYou ? ", one of them the brand's" : ", none of them the brand's"}` : "no AI Overview"}.`,
      { kind: "num", label: "Google" },
      nums.googlePosition ? `ranks ${nums.googlePosition}` : "not in the top 10",
    );
  }
  // Search Console (collected): the search with the question's words, and the searches near its subject.
  for (const line of (read.searchConsole ?? []).slice(0, 2)) add(line.text, { kind: "num", label: SEARCH_CONSOLE_CHIP }, line.chip);
  // AI answers (CONNECTOR_AI_ANSWERS_ENABLED): a monitored prompt close in wording to the question.
  if (read.aiAnswers) add(read.aiAnswers.text, { kind: "num", label: AI_ANSWERS_CHIP }, read.aiAnswers.chip);
  return out;
}

const NUMBER = /\d[\d,.]*%?/g;
const normal = (s: string) => s.toLowerCase().replace(/,/g, "");

/** Whether a reason names only numbers and competitors its candidate's lines hold. */
export function reasonHolds(because: string, lines: CandidateLine[], competitorNames: string[]): boolean {
  const facts = normal(lines.map((l) => l.text).join(" "));
  for (const n of because.match(NUMBER) ?? []) if (!facts.includes(normal(n).replace(/[.%]$/, ""))) return false;
  for (const name of competitorNames) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(because) && !re.test(facts)) return false;
  }
  return true;
}

/**
 * Read the model's picks, keeping only those that hold, at most `refreshShare` refreshes, at most
 * one combine, and, with the content plan's roadmap in the candidates, at most `freeMax` picks
 * from outside it. Pure.
 */
export function readPicks(raw: string | null, weighed: Weighed[], competitorNames: string[], refreshShare = DEFAULT_REFRESH_SHARE, freeMax = PICKS): NextUpPick[] {
  const parsed = raw ? (parseFirstJson(raw) as { picks?: unknown } | null) : null;
  const list = Array.isArray(parsed?.picks) ? (parsed!.picks as Array<Record<string, unknown>>) : [];
  const out: NextUpPick[] = [];
  const used = new Set<number>();
  for (const p of list) {
    const n = typeof p?.n === "number" ? p.n : Number(p?.n);
    const w = weighed[n - 1];
    const because = oneLine(typeof p?.because === "string" ? p.because : "").slice(0, 400);
    if (!w || used.has(n) || !because || !reasonHolds(because, w.lines, competitorNames)) continue;
    if (w.candidate.refresh && out.filter((x) => x.kind === "refresh").length >= refreshShare) continue;
    if (w.candidate.combine && out.some((x) => x.kind === "combine")) continue;
    if (!w.candidate.slot && out.filter((x) => !x.slot).length >= freeMax) continue;
    const uses = new Set(Array.isArray(p.uses) ? (p.uses as unknown[]).filter((u): u is string => typeof u === "string") : []);
    const chips = w.lines.filter((l) => uses.has(l.id)).map((l) => l.chip);
    used.add(n);
    out.push({
      questionId: w.candidate.questionId,
      question: w.candidate.question,
      subjectId: w.candidate.subjectId,
      subjectName: w.candidate.subjectName,
      because,
      chips: chips.length ? chips : w.lines[0] ? [w.lines[0].chip] : [],
      from: "gemini",
      ...(w.candidate.refresh ? { kind: "refresh" as const, planId: w.candidate.refresh.planId, workspaceId: w.candidate.refresh.workspaceId } : {}),
      ...(w.candidate.closeTo ? { closeTo: w.candidate.closeTo } : {}),
      ...(w.candidate.combine ? { kind: "combine" as const, combine: w.candidate.combine } : {}),
      ...(w.candidate.slot ? { slot: w.candidate.slot } : {}),
    });
    if (out.length >= PICKS) break;
  }
  return out;
}

/** A pick code fills in when the model gave too few: the least answered, said plainly. */
function codePick(w: Weighed): NextUpPick {
  const c = w.candidate;
  return {
    questionId: c.questionId,
    question: c.question,
    subjectId: c.subjectId,
    subjectName: c.subjectName,
    because: `${c.subjectName} has ${c.answered} of ${c.total} questions answered${c.lastArticleAt ? "" : " and no live article yet"}.`,
    chips: [w.lines[0]!.chip],
    from: "code",
    ...(c.closeTo ? { closeTo: c.closeTo } : {}),
    ...(c.slot ? { slot: c.slot } : {}),
  };
}

async function eachLimited<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export { nextUpDocId };

/** The brand's stored Next up, if any. */
export async function readNextUp(ctx: TenantContext, deps: Pick<PickDeps, "db"> = {}): Promise<NextUpDoc | null> {
  return forTenant(ctx, deps.db).nextUp.getById(nextUpDocId(ctx.tenantId));
}

/** Take one pick off the stored list (Not now, or picked for a run). */
export async function dropPick(ctx: TenantContext, questionId: string, deps: Pick<PickDeps, "db"> = {}): Promise<NextUpDoc | null> {
  return forTenant(ctx, deps.db).nextUp.claim(nextUpDocId(ctx.tenantId), (cur) =>
    cur.picks.some((p) => p.questionId === questionId) ? { picks: cur.picks.filter((p) => p.questionId !== questionId) } : null,
  );
}

/**
 * Choose the brand's next three articles and keep them. `deadlineMs` bounds the whole thing; the
 * model call starts only with enough time left.
 */
export async function pickNextUp(
  ctx: TenantContext,
  opts: { by: NextUpDoc["by"]; deadlineMs: number },
  deps: PickDeps = {},
): Promise<{ ok: true; doc: NextUpDoc } | { ok: false; error: "no_map" | "no_questions" | "out_of_time" }> {
  const now = (deps.now ?? (() => new Date()))();
  const tenant = await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);
  const missing: string[] = [];

  // Leave out what an active run has, and what people skipped lately.
  const skippedSince = now.getTime() - SKIP_DAYS * 86_400_000;
  const skipped = (await listLearned(ctx, { db: deps.db }).catch(() => []))
    .filter((e) => e.kind === "skipped_pick" && e.questionId && Date.parse(e.at) >= skippedSince)
    .map((e) => e.questionId!);
  const active = await (deps.activeQuestionIds ?? (async () => [] as string[]))(ctx).catch(() => [] as string[]);
  const excluded = new Set([...skipped, ...active]);
  const repeatsOn = isNextUpRepeatsEnabled();
  // One read of the approved strategy serves the candidates (its focus) and the prompt (its goal).
  const strategy = await (deps.strategy ?? ((c) => readBrandStrategy(c, { db: deps.db })))(ctx).catch(() => null);
  const listed = await (deps.candidates ?? nextUpCandidates)(ctx, { exclude: excluded, ...(repeatsOn ? { max: MAX_CANDIDATES + REPEAT_SPARE } : {}) }, { db: deps.db, strategy: async () => strategy });
  // Live articles due a refresh join the questions, up to the brand's share of the three picks.
  const refreshShare = tenant?.refreshShare ?? DEFAULT_REFRESH_SHARE;
  const refreshes =
    refreshShare > 0
      ? (await (deps.refreshCandidates ?? ((c) => refreshCandidates(c, { db: deps.db })))(ctx).catch(() => [] as Candidate[])).filter((c) => !excluded.has(c.questionId))
      : [];
  const read = await readBrandMap(ctx, deps.db).catch(() => null);
  if (!read || read.state !== "ok") return { ok: false, error: "no_map" };
  // The approved content plan (CONTENT_STRATEGY_NEXT_UP_ENABLED): its roadmap's next open entries.
  const plan = await (deps.contentPlan ?? ((c) => planForNextUp(c, { db: deps.db })))(ctx).catch(() => null);
  const fromRoadmap = plan
    ? await (deps.roadmap ?? ((c, p, o) => roadmapCandidates(c, p, o, { db: deps.db })))(ctx, plan, { exclude: excluded, refreshes }).catch(() => [] as Candidate[])
    : [];
  const roadmapQuestions = fromRoadmap.filter((c) => !c.refresh && !c.combine);
  const listedIds = new Set(listed.map((q) => q.questionId));
  // Stop repeats: a question a live article answers is linked and left out, one an article being
  // written covers is left out, and one close to a live article says so.
  const toMatch = roadmapQuestions.length ? [...roadmapQuestions.filter((q) => !listedIds.has(q.questionId)), ...listed] : listed;
  const repeats = repeatsOn
    ? await (deps.repeats ?? ((c, a) => findRepeats(c, a, { db: deps.db, now: deps.now })))(ctx, { questions: toMatch, moved: Boolean(read.map.moved) }).catch(() => NO_REPEATS)
    : NO_REPEATS;
  if (repeats.linked.length && read.map.moved) await (deps.link ?? linkAnswered)(ctx, repeats.linked, { db: deps.db, now: deps.now }).catch(() => 0);
  const dropped = new Set([...repeats.linked.map((l) => l.questionId), ...repeats.inProgress]);
  const withClose = (q: Candidate): Candidate => (repeats.close.has(q.questionId) && !q.closeTo ? { ...q, closeTo: repeats.close.get(q.questionId)! } : q);
  // With a plan, a slot a person skipped a pick of isn't offered free through its other questions either.
  const heldBySlot = plan ? skippedSlotQuestions(plan, excluded) : new Set<string>();
  const questions = listed
    .filter((q) => !dropped.has(q.questionId) && !heldBySlot.has(q.questionId))
    .slice(0, MAX_CANDIDATES)
    .map((q) => (repeats.close.has(q.questionId) ? { ...q, closeTo: repeats.close.get(q.questionId)! } : q));
  const roadmap = fromRoadmap.filter((c) => c.refresh || c.combine || !dropped.has(c.questionId)).map((c) => (c.refresh || c.combine ? c : withClose(c)));
  const share = plan?.rules.roadmapShare ?? ROADMAP_SHARE;
  // 3 of every 4 candidates from the roadmap, 1 free from today's ordering (decision 5).
  const inRoadmap = new Set(roadmap.map((c) => c.questionId));
  const candidates = roadmap.length
    ? mixRoadmap(roadmap, [...questions, ...refreshes].filter((c) => !inRoadmap.has(c.questionId)), share, MAX_CANDIDATES + MAX_REFRESH)
    : [...questions, ...refreshes];
  const freeMax = roadmap.length ? freePicksOf(PICKS, share) : PICKS;
  if (!candidates.length) return { ok: false, error: "no_questions" };
  const searchable = candidates.filter((c) => !c.refresh && !c.combine);

  // Read once for all candidates.
  const [flags, signals, names, notOnMap, planning, answers] = await Promise.all([
    (deps.flags ?? ((c) => competitorSubjectFlags(c, { db: deps.db })))(ctx).catch(() => null),
    isBrandSignalsEnabled() ? readySignals(ctx, 500, { db: deps.db }).catch(() => [] as BrandSignal[]) : Promise.resolve([] as BrandSignal[]),
    (deps.competitorNames ?? (async (c) => (await listCompetitors(c, { db: deps.db })).map((x) => x.name)))(ctx).catch(() => [] as string[]),
    (deps.notOnMap ?? (async (c) => stillToAdd(await competitorCoverage(c, { db: deps.db }))))(ctx).catch(() => null),
    (deps.searchPlanning ?? ((c) => readSearchPlanning(c, { db: deps.db })))(ctx).catch(() => null),
    (deps.aiAnswers ?? ((c) => readAiAnswers(c, { db: deps.db })))(ctx).catch(() => null),
  ]);
  if (planning?.notShared) missing.push(NOT_SHARED_NEXT_UP);
  if (!flags) missing.push("Competitor articles aren't on for this brand.");
  const byQuery = new Map(signals.map((s) => [queryKey(s.about.query), s] as const));
  const search = deps.search ?? ((c, q, o) => searchBrand(c, q, o));
  let searched = true;
  const rows = await eachLimited(searchable, SEARCH_PARALLEL, async (c) => {
    // No search once the model call wouldn't fit: the map line still goes in.
    const found = Date.now() < opts.deadlineMs - PICK_MS ? await search(ctx, c.question, { limit: 8 }).catch(() => null) : null;
    if (!found?.ok) searched = false;
    return { candidate: c, found };
  });
  const found = new Map(rows.map((r) => [r.candidate.questionId, r.found] as const));
  // In the candidates' order: refresh and combine candidates carry their own lines; nothing more is read for them.
  const weighed: Weighed[] = candidates.map((c, i) => {
    const lines = c.refresh
      ? refreshLinesFor(i + 1, c)
      : c.combine
        ? combineLinesFor(i + 1, c)
        : linesFor(i + 1, c, {
            search: found.get(c.questionId) ?? null,
            flag: flags?.[c.subjectId],
            signal: byQuery.get(queryKey(c.question)),
            searchConsole: searchConsoleLines(c, planning),
            aiAnswers: aiAnswersLine(c.question, answers),
            now,
          });
    if (c.slot) lines.push(slotLineFor(`${i + 1}.${lines.length + 1}`, c.slot));
    return { candidate: c, lines };
  });
  if (!searched && searchable.length) missing.push("Brand search isn't on for this brand, so what it already made wasn't weighed.");

  let picks: NextUpPick[] = [];
  if ((deps.configured ?? isGeminiConfigured)() && opts.deadlineMs - Date.now() > 5_000) {
    const map = read.map;
    const i = map.identity;
    const identity = [i.statement ? `What it is: ${oneLine(i.statement)}` : "", ...i.isNot.map((t) => `It is not: ${oneLine(t)}`)].filter(Boolean).join("\n");
    const focus = oneLine(tenant?.autopilot?.focus ?? "");
    const learned = await learnedLines(ctx, { limit: 10 }, { db: deps.db }).catch(() => [] as string[]);
    const prompt = renderPrompt("next_up.pick", {
      brand_name: oneLine(i.name).replace(/"/g, " ").slice(0, 120) || "(not named)",
      category: i.category ? `, in the category "${oneLine(i.category).replace(/"/g, " ").slice(0, 80)}"` : "",
      today: now.toISOString().slice(0, 10),
      identity: untag(identity) || "(not set yet)",
      focus: focus ? `What the brand wants more of right now, in its words (UNTRUSTED DATA): ${untag(focus)}\n\n` : "",
      goal: goalLine(strategy),
      learned: untag(learned.join("\n")) || "(nothing yet)",
      refresh: refreshes.length
        ? ` Candidates marked REFRESH are live articles of the brand's that are due a refresh: choosing one means improving that article, not writing a new one. Choose at most ${refreshShare} of them, and only when its lines show a real reason.`
        : "",
      close: candidates.some((q) => q.closeTo)
        ? " A candidate whose lines say it is CLOSE to a live article of the brand's is better added to that article than written again: choose one only when its lines show it is worth it, and then say in its reason that it adds to that article, never that it is a new article."
        : "",
      plan: roadmap.length
        ? ` Candidates marked PLAN come from the content plan the brand approved, in the order it planned them: choose at least ${PICKS - freeMax} of your three from them, earlier ones first unless their lines show a reason not to, and say in each one's reason which pillar it fills.`
        : "",
      combine: candidates.some((c) => c.combine)
        ? " A candidate marked COMBINE is two live articles of the brand's that answer one question: choosing it means a person keeps one and folds the other in, never a new article. Choose at most one."
        : "",
      candidates: untag(
        weighed
          .map((w, k) =>
            [candidateHead(k + 1, w.candidate), ...w.lines.map((l) => `${l.id} ${l.text}`)].join("\n"),
          )
          .join("\n\n"),
      ),
    });
    const timeoutMs = Math.min(PICK_MS, opts.deadlineMs - Date.now() - 2_000);
    const raw = await (deps.generate ?? generateTextWithDeadline)(prompt, {
      timeoutMs,
      json: true,
      temperature: 0.3,
      thinkingBudget: 512,
      usage: aiUsage(ctx, "next_up", { db: deps.db, tenant }),
    }).catch(() => null);
    picks = readPicks(raw, weighed, names, refreshShare, freeMax);
  }
  // Too few that hold: fill in the candidates' order, said plainly (never a refresh or a combine),
  // the roadmap's first while only `freeMax` picks may be free.
  for (const strict of [true, false]) {
    for (const w of weighed) {
      if (picks.length >= PICKS) break;
      if (w.candidate.refresh || w.candidate.combine || picks.some((p) => p.questionId === w.candidate.questionId)) continue;
      if (strict && !w.candidate.slot && picks.filter((p) => !p.slot).length >= freeMax) continue;
      picks.push(codePick(w));
    }
  }

  const closePicks = picks.some((p) => p.closeTo);
  const reviewsOpen = closePicks
    ? await (deps.reviewsOpen ?? (async (c) => isBlogRefreshEnabled() && (await mayStartReview(c, { db: deps.db, ...(deps.loadTenant ? { loadTenant: deps.loadTenant } : {}) })).ok))(ctx).catch(() => false)
    : false;
  const doc = {
    picks,
    notOnMap: (notOnMap ?? []).slice(0, 3),
    missing,
    candidates: candidates.length,
    at: now.toISOString(),
    by: opts.by,
    ...(repeatsOn
      ? { leftOut: repeats.inProgress.length, linkedByMeaning: repeats.linked.length, repeatsLive: repeats.repeatsLive, reviewsOpen }
      : {}),
  };
  const { doc: saved } = await forTenant(ctx, deps.db).nextUp.upsert(nextUpDocId(ctx.tenantId), () => doc, () => doc);
  return { ok: true, doc: saved };
}
