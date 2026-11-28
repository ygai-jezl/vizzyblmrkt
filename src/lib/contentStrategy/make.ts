import { embedDocuments } from "@/lib/agents/embeddings";
import { isGeminiConfigured, type AiUsage, type generateTextWithDeadline } from "@/lib/agents/gemini";
import { listLearned } from "@/lib/autopilot/learned";
import { isBlogFreshnessEnabled, isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { questionKey } from "@/lib/brandMap/keys";
import { oneLine } from "@/lib/brandMap/lineChecks";
import { listGroups, parseQuestion, parseSubject } from "@/lib/brandMap/records";
import { readSituation } from "@/lib/brandMap/situations";
import { readBrandMap } from "@/lib/brandMap/store";
import { QUESTION_TITLE } from "@/lib/brandNotes/store";
import { readBrandStrategy, type Strategy } from "@/lib/brandStrategy/store";
import { competitorCoverage, type CoverageView } from "@/lib/competitors/coverage";
import { matchQuestion, meaningWords } from "@/lib/content/blog/coverage";
import { readDueArticles } from "@/lib/content/blog/freshnessPages";
import { readSearchPlanning, type SearchPlanning } from "@/lib/connectors/signals/planning";
import { countMade } from "@/lib/loops/count";
import { learnedFor } from "@/lib/loops/read";
import { DEFAULT_REFRESH_SHARE, readNextUp } from "@/lib/nextUp/pick";
import { aiUsage } from "@/lib/plans/meter";
import { lookUpQuestion, type LookupOutcome } from "@/lib/signals/collect";
import { isBrandSignalsEnabled, isSignalsDataForSeoEnabled } from "@/lib/signals/flags";
import { isFresh, queryKey, readySignals } from "@/lib/signals/store";
import { forTenant, getTenantById } from "@/lib/tenant";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { listAllBrandMapPages } from "@/lib/tenant/brandMapPages";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { AutopilotSettingsSchema, type RepeatPair } from "@/lib/types/autopilot";
import { BrandMapPageSchema, type BrandMapPage } from "@/lib/types/brandMapPage";
import type { BrandSignal } from "@/lib/types/brandSignal";
import type { BlogIntent } from "@/lib/types/contentPlan";
import type { FreshnessDueItem } from "@/lib/types/freshness";
import {
  CONTENT_STRATEGY_LIMITS as L,
  ContentPlanSchema,
  DEFAULT_FUNNEL,
  ROADMAP_SHARE,
  type ContentPlan,
  type ContentSlot,
  type ContentStrategyDoc,
  type PlanSource,
} from "@/lib/types/contentStrategy";
import type { Tenant } from "@/lib/types/tenant";
import { choosePillars, hubsOf, type PillarSubject, type PlanCallDeps } from "./pillars";
import { makeRoadmap, weeksFrom } from "./roadmap";
import { mixOf, scoreSlots } from "./scores";
import { INTENT_STAGE, makeSlots, pageIdOfPlan, questionCoverage, splitBySerp, topUrls, type CoverageSubject, type MadeSlot, type SlotQuestion } from "./slots";
import { questionsNow, type QuestionNow } from "./questions";
import { saveMadePlan } from "./store";

/**
 * Make the plan (CONTENT_STRATEGY_ENABLED): read what the brand has, merge its decided questions
 * into slots, name the pillars (from its groups, or one model call), score each slot and order
 * the 12 week roadmap, all in code but the one call, then save it as the draft for a person to
 * check and approve. Nothing it makes is used until a person approves it.
 *
 * What it reads, each when that part is on and the brand has it: the brand map's decided questions,
 * subjects and groups; its article rows (coverage); the approved brand strategy's focus situations;
 * Search Console's collected demand; Google's results the brand already looked up (and up to 6 new
 * lookups for top questions, under its lookup cap); competitor articles; the articles due a refresh;
 * Next up's live repeats; the autopilot's articles a week; and the picks people skipped lately.
 */

/** Questions read from a moved map: three pages of 500. */
const MAX_QUESTIONS = 1_500;
/** Embedded at a time. */
const EMBED_BATCH = 200;
/** New Google lookups asked for in one make, for the top questions of merged slots. */
export const MAX_NEW_LOOKUPS = 6;
const SKIP_DAYS = 30;
const FOCUS_MAX = 5;

export interface MakeDeps {
  db?: FirestoreLike;
  now?: () => Date;
  loadTenant?: (id: string) => Promise<Tenant | null>;
  embed?: typeof embedDocuments;
  generate?: typeof generateTextWithDeadline;
  modelReady?: () => boolean;
  usage?: AiUsage;
  strategy?: (ctx: TenantContext) => Promise<Strategy | null>;
  searchPlanning?: (ctx: TenantContext) => Promise<SearchPlanning | null>;
  coverage?: (ctx: TenantContext) => Promise<CoverageView | null>;
  due?: (ctx: TenantContext) => Promise<FreshnessDueItem[]>;
  repeats?: (ctx: TenantContext) => Promise<RepeatPair[]>;
  signals?: (ctx: TenantContext) => Promise<BrandSignal[]>;
  lookUp?: (ctx: TenantContext, ask: Parameters<typeof lookUpQuestion>[1]) => Promise<LookupOutcome>;
  pages?: (ctx: TenantContext) => Promise<BrandMapPage[]>;
}

export type MakeOutcome =
  | { ok: true; doc: ContentStrategyDoc; notes: { lookupsAsked: number; byMeaning: boolean; leftOut: number; slots: number } }
  | { ok: false; status: number; error: string };

/** A decided question as the plan reads it. */
interface MapQuestion {
  id: string;
  text: string;
  intent: BlogIntent;
  subjectId: string;
  situationIds: string[];
  answeredBy: { pageId: string } | null;
  notAnsweredBy: string[];
}

interface MapRead {
  identity: { name: string; category: string; statement: string; isNot: string[] };
  audiences: string[];
  subjects: Map<string, PillarSubject>;
  groups: Array<{ id: string; name: string }>;
  questions: MapQuestion[];
}

const soft = <T>(work: Promise<T>, fallback: T): Promise<T> => work.catch(() => fallback);

/** The brand map's decided subjects, groups and questions, at either size. */
async function readMap(ctx: TenantContext, deps: MakeDeps): Promise<MapRead | null> {
  const read = await readBrandMap(ctx, deps.db).catch(() => null);
  if (!read || read.state !== "ok") return null;
  const map = read.map;
  const identity = { name: map.identity.name, category: map.identity.category, statement: map.identity.statement, isNot: map.identity.isNot };
  const audiences = map.names.filter((n) => n.kind === "audience").map((n) => n.name);
  if (isBrandMapScaleEnabled() && map.moved) {
    const store = brandMapRecords(ctx, deps.db);
    const [subjectRows, groups, questionRows] = await Promise.all([
      soft(store.pageAll("sub", { where: [["status", "==", "decided"]] }), []),
      soft(listGroups(ctx, { db: deps.db }), []),
      soft(store.pageAll("q", { where: [["status", "==", "decided"]], pageSize: 500, maxPages: MAX_QUESTIONS / 500 }), []),
    ]);
    const subjects = new Map<string, PillarSubject & { order: number }>();
    for (const r of subjectRows) {
      const s = parseSubject(r);
      if (s && s.status === "decided" && !s.mergedInto) subjects.set(s.id, { id: s.id, name: s.name, groupId: s.groupId, home: s.home, order: s.order });
    }
    const questions = questionRows
      .flatMap((r) => {
        const q = parseQuestion(r);
        return q && q.status === "decided" && !q.mergedInto && subjects.has(q.subjectId) ? [q] : [];
      })
      .sort((a, b) => subjects.get(a.subjectId)!.order - subjects.get(b.subjectId)!.order || a.order - b.order || a.id.localeCompare(b.id))
      .map((q) => ({ id: q.id, text: q.text, intent: q.intent, subjectId: q.subjectId, situationIds: q.situationIds, answeredBy: q.answeredBy, notAnsweredBy: q.notAnsweredBy }));
    return {
      identity,
      audiences,
      subjects,
      groups: groups.filter((g) => g.status === "decided").map((g) => ({ id: g.id, name: g.name })),
      questions,
    };
  }
  return {
    identity,
    audiences,
    subjects: new Map(map.subjects.map((s) => [s.id, { id: s.id, name: s.name, groupId: null, home: s.home ?? null }] as const)),
    groups: [],
    questions: map.subjects.flatMap((s) => s.questions.map((q) => ({ id: q.id, text: q.text, intent: q.intent, subjectId: s.id, situationIds: [], answeredBy: null, notAnsweredBy: [] }))),
  };
}

/** The open and answered questions on the approved strategy's focus situations: their ids and their words. */
async function focusOf(ctx: TenantContext, strategy: Strategy | null, deps: MakeDeps): Promise<{ ids: Set<string>; keys: Set<string>; situations: Set<string>; texts: string[] }> {
  const out = { ids: new Set<string>(), keys: new Set<string>(), situations: new Set<string>(), texts: [] as string[] };
  for (const id of strategy?.focusSituationIds.slice(0, FOCUS_MAX) ?? []) {
    out.situations.add(id);
    const read = await readSituation(ctx, id, { db: deps.db }).catch(() => null);
    if (read) out.texts.push(read.situation.text);
    for (const q of read?.questions ?? []) {
      if (q.status !== "decided") continue;
      out.ids.add(q.id);
      out.keys.add(questionKey(q.text));
    }
  }
  return out;
}

/** Embed the questions in batches; null when any batch fails, so grouping falls back to words. */
async function vectorsOf(ctx: TenantContext, texts: string[], deps: MakeDeps): Promise<number[][] | null> {
  const embed = deps.embed ?? embedDocuments;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const got = await embed(batch.map((content) => ({ content, title: QUESTION_TITLE })), ctx.region).catch(() => null);
    if (!got || got.length !== batch.length || !got.every((v) => v?.length)) return null;
    out.push(...(got as number[][]));
  }
  return out;
}

async function articleRows(ctx: TenantContext, deps: MakeDeps): Promise<BrandMapPage[]> {
  if (deps.pages) return deps.pages(ctx);
  const raw = await listAllBrandMapPages(ctx, { where: [["kind", "==", "article"]], maxRows: 2000 }, deps.db);
  return raw.map((r) => BrandMapPageSchema.safeParse(r)).flatMap((r) => (r.success ? [r.data] : []));
}

/** Search Console impressions for each question, the busiest site's. */
function impressionsOf(planning: SearchPlanning | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const site of planning?.sites ?? []) {
    for (const [qid, row] of site.questions) {
      const n = Math.max(0, Math.round(row.m.searchImpressions ?? 0));
      if (n > (out.get(qid) ?? -1)) out.set(qid, n);
    }
  }
  return out;
}

/** The plan's strategy lines for the model: audiences, focus situations and the goal, each one line. */
function strategyLines(strategy: Strategy | null, map: MapRead, focusTexts: string[]): string[] {
  const audiences = strategy?.audiences.length ? strategy.audiences : map.audiences;
  return [
    audiences.length ? `Who it is for: ${audiences.map(oneLine).join("; ")}` : "",
    ...focusTexts.map((t) => `A focus situation: ${oneLine(t)}`),
    strategy?.goal ? `The quarter's goal: ${oneLine(strategy.goal.text)}${strategy.goal.measure ? ` (measured by ${oneLine(strategy.goal.measure)})` : ""}` : "",
  ].filter(Boolean);
}

/** Make the plan and save it as the draft. */
export async function makeContentPlan(ctx: TenantContext, deps: MakeDeps = {}): Promise<MakeOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const map = await readMap(ctx, deps);
  if (!map) return { ok: false, status: 409, error: "no_brand_map" };
  if (!map.questions.length) return { ok: false, status: 409, error: "nothing_to_plan" };
  const sources = new Set<PlanSource>(["brand_map"]);
  const tenant = await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);

  const [strategy, rows, planning, view, dueItems, repeatPairs, learned] = await Promise.all([
    soft((deps.strategy ?? ((c) => readBrandStrategy(c, { db: deps.db })))(ctx), null),
    soft(articleRows(ctx, deps), [] as BrandMapPage[]),
    soft((deps.searchPlanning ?? ((c) => readSearchPlanning(c, { db: deps.db })))(ctx), null),
    soft((deps.coverage ?? ((c) => competitorCoverage(c, { db: deps.db })))(ctx), null),
    isBlogFreshnessEnabled() || deps.due ? soft((deps.due ?? ((c) => readDueArticles(c, { db: deps.db })))(ctx), [] as FreshnessDueItem[]) : Promise.resolve([] as FreshnessDueItem[]),
    soft((deps.repeats ?? (async (c) => (await readNextUp(c, { db: deps.db }))?.repeatsLive ?? []))(ctx), [] as RepeatPair[]),
    soft(listLearned(ctx, { db: deps.db }), []),
  ]);
  const focus = await focusOf(ctx, strategy, deps);
  if (strategy) sources.add("brand_strategy");
  if (rows.length) sources.add("coverage");

  // Coverage of each decided question by the brand's live articles.
  const subjects: CoverageSubject[] = [...map.subjects.values()].map((s) => ({
    id: s.id,
    name: s.name,
    home: s.home,
    questions: map.questions.filter((q) => q.subjectId === s.id).map((q) => ({ id: q.id, text: q.text, intent: q.intent, answeredBy: q.answeredBy, notAnsweredBy: q.notAnsweredBy })),
  }));
  const cov = questionCoverage(subjects, rows);
  const impressions = impressionsOf(planning);
  if (impressions.size) sources.add("search_demand");
  const due = dueItems.filter((d) => d.state === "due").map((d) => pageIdOfPlan(d.planId));
  const dueSet = new Set(due);
  if (due.length) sources.add("freshness");

  const questions: SlotQuestion[] = map.questions.map((q) => ({
    id: q.id,
    text: q.text,
    intent: q.intent,
    subjectId: q.subjectId,
    focus: focus.ids.has(q.id) || focus.keys.has(questionKey(q.text)) || q.situationIds.some((s) => focus.situations.has(s)),
    impressions: impressions.has(q.id) ? impressions.get(q.id)! : null,
    state: cov.get(q.id)?.state ?? "open",
    live: cov.get(q.id)?.live ?? [],
  }));
  const byId = new Map(questions.map((q) => [q.id, q] as const));
  const vectors = await vectorsOf(ctx, questions.map((q) => q.text), deps);
  if (vectors) sources.add("meaning");
  const made = makeSlots(questions, vectors, { duePageIds: dueSet });
  let slots: MadeSlot[] = made.slots;
  let leftOut = made.leftOut;

  // Google's check: what the brand already looked up, and a few new lookups for top questions.
  let lookupsAsked = 0;
  if (isBrandSignalsEnabled() || deps.signals) {
    const signals = await soft((deps.signals ?? ((c) => readySignals(c, 500, { db: deps.db })))(ctx), [] as BrandSignal[]);
    const byQuery = new Map(signals.filter((s) => isFresh(s, now)).map((s) => [queryKey(s.about.query), s] as const));
    const tops = (qid: string) => {
      const q = byId.get(qid);
      const sig = q ? byQuery.get(queryKey(q.text)) : undefined;
      return sig?.results ? topUrls(sig.results.top) : null;
    };
    if (isSignalsDataForSeoEnabled() || deps.lookUp) {
      const ask = deps.lookUp ?? ((c, a) => lookUpQuestion(c, a, { db: deps.db, now: deps.now, ...(deps.loadTenant ? { loadTenant: deps.loadTenant } : {}) }));
      outer: for (const s of slots.filter((x) => x.questionIds.length > 1)) {
        for (const qid of s.questionIds.slice(0, 3)) {
          if (lookupsAsked >= MAX_NEW_LOOKUPS) break outer;
          const q = byId.get(qid);
          if (!q || tops(qid)) continue;
          const got = await ask(ctx, { query: q.text, questionId: q.id, subjectId: q.subjectId, purpose: "content_strategy" }).catch(() => null);
          if (!got?.ok) break outer;
          if (!got.reused) lookupsAsked += 1;
        }
      }
    }
    const { slots: checked, leftOut: cut } = splitBySerp(slots, tops, byId, dueSet);
    leftOut += cut;
    if (checked.some((s) => s.facts.serp)) sources.add("google_results");
    slots = checked.map((s) => {
      const lead = byId.get(s.questionIds[0]!);
      const sig = lead ? byQuery.get(queryKey(lead.text)) : undefined;
      return sig?.numbers ? { ...s, facts: { ...s.facts, paa: sig.numbers.peopleAlsoAsk } } : s;
    });
  }

  // Competitors: articles on each slot's subjects in 90 days, and topics close to its words.
  if (view) {
    sources.add("competitors");
    const they = new Map(view.rows.map((r) => [r.subjectId, r.they] as const));
    const topics = view.notOnMap.filter((t) => t.state !== "dismissed").map((t) => ({ words: new Set(meaningWords(t.topic)), count: t.count }));
    slots = slots.map((s) => {
      const words = new Set(meaningWords(s.title));
      const near = topics.filter((t) => [...t.words].filter((w) => words.has(w)).length >= 2).reduce((n, t) => n + t.count, 0);
      return { ...s, facts: { ...s.facts, theirs: Math.max(0, ...s.subjectIds.map((id) => they.get(id) ?? 0)) + near } };
    });
  }

  // Next up's live repeats: two live articles answering one slot are a combine.
  const repeatSlotIds = new Set<string>();
  for (const pair of repeatPairs) {
    const ids = pair.pages.flatMap((p) => (p.planId ? [pageIdOfPlan(p.planId)] : []));
    const s = slots.find((x) => x.coveredBy.some((p) => ids.includes(p)));
    if (!s || ids.length < 2) continue;
    s.coveredBy = [...new Set([...s.coveredBy, ...ids])].slice(0, L.coveredBy);
    s.kind = "combine";
    repeatSlotIds.add(s.id);
    sources.add("repeats");
  }

  // Pillars and hubs.
  const subjectName = (id: string) => map.subjects.get(id)?.name ?? "";
  const pillared = await choosePillars(
    slots,
    {
      subjects: map.subjects,
      groups: map.groups,
      today: now.toISOString().slice(0, 10),
      call: (listed) => ({
        brandName: map.identity.name,
        category: map.identity.category,
        identity: [map.identity.statement ? `What it is: ${oneLine(map.identity.statement)}` : "", ...map.identity.isNot.map((t) => `It is not: ${oneLine(t)}`)].filter(Boolean),
        strategy: strategyLines(strategy, map, focus.texts),
        slots: listed.map((s) => ({ slot: s, others: s.questionIds.slice(1).map((id) => byId.get(id)?.text ?? "").filter(Boolean), subject: subjectName(s.subjectIds[0] ?? "") })),
      }),
    },
    {
      ...(deps.generate ? { generate: deps.generate } : {}),
      modelReady: deps.modelReady ?? isGeminiConfigured,
      usage: deps.usage ?? aiUsage(ctx, "content_strategy", { db: deps.db, tenant }),
    } satisfies PlanCallDeps,
  );
  if (pillared.from === "groups") sources.add("groups");
  const hubSlots = hubsOf(pillared.pillars, slots, pillared.of, map.subjects, pillared.hubs);

  const funnel = DEFAULT_FUNNEL;
  const placed: ContentSlot[] = slots.map((s) => ({
    ...s,
    title: pillared.titles.get(s.id) ?? s.title,
    pillarId: pillared.of.get(s.id) ?? null,
    hub: hubSlots.has(s.id),
    scores: { fit: 0, demand: 0, gap: 0, depth: 0, balance: 0, total: 0 },
  }));
  const scores = scoreSlots(placed, funnel);
  for (const s of placed) s.scores = scores.get(s.id)!;

  // The roadmap, at the autopilot's pace, leaving out what people skipped lately.
  const settings = AutopilotSettingsSchema.safeParse(tenant?.autopilot ?? {});
  const perWeek = settings.success ? settings.data.perWeek : 1;
  if (settings.success && tenant?.autopilot) sources.add("autopilot");
  const refreshShare = Math.round((Math.min(3, tenant?.refreshShare ?? DEFAULT_REFRESH_SHARE) / 3) * 100) / 100;
  const since = now.getTime() - SKIP_DAYS * 86_400_000;
  const skipped = new Set(learned.filter((e) => e.kind === "skipped_pick" && e.questionId && Date.parse(e.at) >= since).map((e) => e.questionId!));
  const { roadmap, blocks } = makeRoadmap({ slots: placed, pillars: pillared.pillars, weeks: weeksFrom(now), perWeek, funnel, refreshShare, duePageIds: due, repeatSlotIds, skipped });

  const stageMix = mixOf(map.questions.map((q) => INTENT_STAGE[q.intent] ?? "learn"));

  const plan: ContentPlan = ContentPlanSchema.parse({
    slots: placed,
    pillars: pillared.pillars,
    roadmap,
    blocks,
    rules: { roadmapShare: ROADMAP_SHARE, funnel, perWeek, refreshShare, oneArticlePerSlot: true, hubFirst: true },
    questions: map.questions.length,
    stageMix,
    leftOut,
    sources: [...sources],
    made: pillared.made,
    at: now.toISOString(),
    by: null,
  });
  const saved = await saveMadePlan(ctx, plan, { db: deps.db, now: deps.now });
  if (!saved.ok) return saved;
  // A plan Vizzy named the pillars of is counted made where it is saved (LOOPS_ENABLED, learning loops step 5).
  if (pillared.made) await countMade(ctx, "content_strategy", (await learnedFor(ctx, "content_strategy", { promptId: pillared.made.promptId })).stamp, { type: "content_strategy", db: deps.db });
  return { ok: true, doc: saved.value, notes: { lookupsAsked, byMeaning: Boolean(vectors), leftOut, slots: plan.slots.length } };
}

/**
 * What is known now of a few questions, for splitting a slot: their words, intents, subjects,
 * coverage by the slot's live articles (`pages`), focus and Search Console demand, and which of
 * those articles are due a refresh. A few reads, never the whole map.
 */
export async function questionFactsFor(
  ctx: TenantContext,
  ids: string[],
  pages: string[],
  deps: Pick<MakeDeps, "db" | "strategy" | "searchPlanning" | "due"> = {},
): Promise<{ questions: Map<string, SlotQuestion>; due: Set<string> }> {
  const now = await questionsNow(ctx, ids, { db: deps.db, pages: async () => [] }).catch(() => new Map<string, QuestionNow>());
  const rows = (await Promise.all(pages.map((id) => forTenant(ctx, deps.db).brandMapPages.getById(id).catch(() => null))))
    .map((r) => (r ? BrandMapPageSchema.safeParse(r) : null))
    .flatMap((r) => (r?.success && r.data.state === "live" ? [r.data] : []));
  const [strategy, planning, dueItems] = await Promise.all([
    soft((deps.strategy ?? ((c) => readBrandStrategy(c, { db: deps.db })))(ctx), null),
    soft((deps.searchPlanning ?? ((c) => readSearchPlanning(c, { db: deps.db })))(ctx), null),
    isBlogFreshnessEnabled() || deps.due ? soft((deps.due ?? ((c) => readDueArticles(c, { db: deps.db })))(ctx), [] as FreshnessDueItem[]) : Promise.resolve([] as FreshnessDueItem[]),
  ]);
  const focus = await focusOf(ctx, strategy, { db: deps.db });
  const impressions = impressionsOf(planning);
  const questions = new Map<string, SlotQuestion>();
  for (const q of now.values()) {
    questions.set(q.id, {
      id: q.id,
      text: q.text,
      intent: q.intent,
      subjectId: q.subjectId,
      focus: focus.ids.has(q.id) || focus.keys.has(questionKey(q.text)) || q.situationIds.some((s) => focus.situations.has(s)),
      impressions: impressions.has(q.id) ? impressions.get(q.id)! : null,
      state: q.state,
      live: rows.filter((r) => matchQuestion({ id: q.id, text: q.text, answeredBy: q.answeredBy, notAnsweredBy: q.notAnsweredBy }, r) === "sure").map((r) => r.id),
    });
  }
  return { questions, due: new Set(dueItems.filter((d) => d.state === "due").map((d) => pageIdOfPlan(d.planId))) };
}

