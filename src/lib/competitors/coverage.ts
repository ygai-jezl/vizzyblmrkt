import { fold } from "@/lib/brandMap/changes";
import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { listBrandMapPages } from "@/lib/brandMap/pages";
import { listSubjects } from "@/lib/brandMap/records";
import { decidedBrandMap } from "@/lib/brandMap/store";
import type { BrandMap } from "@/lib/types/brandMap";
import { computeCoverage } from "@/lib/content/blog/coverage";
import { brandCanUse } from "@/lib/plans/brandAccess";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Competitor, CompetitorArticle } from "@/lib/types/competitor";
import { listArticles, listReadArticles } from "./articles";
import { isCompetitorArticlesEnabled } from "./flags";
import { listCompetitors } from "./store";

/**
 * What competitors write about, beside what the brand covers: one row per subject on the brand's
 * map. "You" counts the subject's questions the brand has answered, drafted or planned.
 *
 * An article is put on a subject when it is read. One that fitted none keeps its topic in a few
 * words (`newTopic`); once a subject of that name is on the map, the article counts there, so a
 * subject added after the read counts the articles it came from.
 */

export interface CoverageDeps {
  db?: FirestoreLike;
  now?: () => Date;
  /** Whether this brand has the feature (tests). */
  canUse?: (ctx: TenantContext) => Promise<boolean>;
}

/** The window the page looks at. */
export const COVERAGE_DAYS = 90;
const MAX_ROWS = 40;
/** Subjects nobody writes about (them or you) added to a moved map's rows, most questions first. */
const MAX_OPEN = 10;
const MAX_TOPICS = 10;

export type CoverageFlag = "gap" | "open" | "crowded" | "you_lead" | "even";

/** Where a topic they write about stands: not on the map, waiting as a proposal, or dismissed before. */
export type TopicState = "new" | "suggested" | "dismissed";

export interface NotOnMapTopic {
  topic: string;
  count: number;
  competitors: string[];
  state: TopicState;
}

export interface AddedTopic {
  topic: string;
  subjectId: string;
  count: number;
  competitors: string[];
}

export interface CoverageRow {
  subjectId: string;
  name: string;
  /** Competitor id → articles on this subject in the window. */
  byCompetitor: Record<string, number>;
  they: number;
  you: number;
  flag: CoverageFlag;
}

export interface CoverageView {
  days: number;
  competitors: Array<{ id: string; name: string }>;
  rows: CoverageRow[];
  articles: number;
  /** Subjects they write about that aren't on the brand's map, in a few words each: new ones first. Never their own news. */
  notOnMap: NotOnMapTopic[];
  /** Topics they wrote about that are subjects on the map now (counted on their rows too). */
  added: AddedTopic[];
  /**
   * The map's subjects are records (a moved map): a row opens its subject's box, and a topic is
   * added straight away. A small map takes topics as suggestions.
   */
  moved: boolean;
}

export interface OurSubject {
  name: string;
  you: number;
  /** How many questions it has: an open subject with more of them is a bigger gap. */
  questions?: number;
}

/**
 * What a row means: nobody writes on it (open), only they do (gap), two or more of them write
 * twice as much as you (crowded, so a new angle is needed), you write as much as they do (you
 * lead), or neither.
 */
export function flagOf(they: number, you: number, writers: number): CoverageFlag {
  if (they === 0) return you === 0 ? "open" : "you_lead";
  if (you === 0) return "gap";
  if (writers >= 2 && they >= you * 2) return "crowded";
  if (you >= they) return "you_lead";
  return "even";
}

/** The day an article counts on: when it was published, else when we read it. */
export const articleDay = (a: Pick<CompetitorArticle, "publishedAt" | "readAt">) => a.publishedAt ?? a.readAt?.slice(0, 10) ?? null;
const dayOf = articleDay;

/** The first day in the window: an article on this day counts, one the day before doesn't. */
export const windowStart = (nowMs: number) => new Date(nowMs - COVERAGE_DAYS * 86_400_000).toISOString().slice(0, 10);

/** A topic's key, as a subject's name is keyed on the map (brandMap/keys.ts subjectKey). */
export const topicKey = (topic: string) => fold(topic);

const STATE_ORDER: Record<TopicState, number> = { new: 0, suggested: 1, dismissed: 2 };

/** The rows and topics, from read articles, the competitors and the brand's subjects. Pure. */
export function coverageFrom(
  articles: CompetitorArticle[],
  competitors: Array<Pick<Competitor, "id" | "name">>,
  subjects: Map<string, OurSubject>,
  opts: {
    nowMs: number;
    allSubjects: boolean;
    maxRows?: number;
    /** Topics waiting as proposals, or dismissed, by topicKey. */
    topicStates?: Map<string, Exclude<TopicState, "new">>;
    moved?: boolean;
  },
): CoverageView {
  const since = windowStart(opts.nowMs);
  const names = new Map(competitors.map((c) => [c.id, c.name]));
  const recent = articles.filter((a) => a.status === "read" && names.has(a.competitorId) && (dayOf(a) ?? "") >= since);
  const byName = new Map<string, string>();
  for (const [id, s] of subjects) if (!byName.has(topicKey(s.name))) byName.set(topicKey(s.name), id);

  const counts = new Map<string, Record<string, number>>();
  const topics = new Map<string, { topic: string; count: number; competitors: Set<string> }>();
  const added = new Map<string, { count: number; competitors: Set<string> }>();
  for (const a of recent) {
    const topic = a.newTopic?.trim() ?? "";
    let onMap = a.subjectIds.filter((id) => subjects.has(id));
    // A topic that is a subject on the map now counts there (put on it when added, or matched by name).
    const subjectOfTopic = topic ? byName.get(topicKey(topic)) : undefined;
    if (subjectOfTopic && !onMap.length) onMap = [subjectOfTopic];
    const named = subjectOfTopic && onMap.includes(subjectOfTopic) ? subjectOfTopic : undefined;
    for (const id of onMap) {
      const row = counts.get(id) ?? {};
      row[a.competitorId] = (row[a.competitorId] ?? 0) + 1;
      counts.set(id, row);
    }
    if (named) {
      const t = added.get(named) ?? { count: 0, competitors: new Set<string>() };
      t.count += 1;
      t.competitors.add(names.get(a.competitorId)!);
      added.set(named, t);
    } else if (!onMap.length && topic && a.format !== "news") {
      // Their own news (a launch, an award) is about them, not a subject buyers ask about.
      const key = topicKey(topic);
      const t = topics.get(key) ?? { topic, count: 0, competitors: new Set<string>() };
      t.count += 1;
      t.competitors.add(names.get(a.competitorId)!);
      topics.set(key, t);
    }
  }

  // A moved map is too big to list whole: the subjects they wrote about, then the biggest open ones.
  const open = opts.allSubjects
    ? []
    : [...subjects.entries()]
        .filter(([id, s]) => !counts.has(id) && s.you === 0)
        .sort((a, b) => (b[1].questions ?? 0) - (a[1].questions ?? 0) || a[1].name.localeCompare(b[1].name))
        .slice(0, MAX_OPEN)
        .map(([id]) => id);
  const ids = opts.allSubjects ? [...subjects.keys()] : [...counts.keys(), ...open];
  const questionsOf = (id: string) => subjects.get(id)?.questions ?? 0;
  const rows = ids
    .map((subjectId) => {
      const byCompetitor = counts.get(subjectId) ?? {};
      const they = Object.values(byCompetitor).reduce((n, x) => n + x, 0);
      const s = subjects.get(subjectId)!;
      return { subjectId, name: s.name, byCompetitor, they, you: s.you, flag: flagOf(they, s.you, Object.keys(byCompetitor).length) };
    })
    .sort((a, b) => b.they - a.they || a.you - b.you || questionsOf(b.subjectId) - questionsOf(a.subjectId) || a.name.localeCompare(b.name))
    .slice(0, opts.maxRows ?? MAX_ROWS);

  return {
    days: COVERAGE_DAYS,
    competitors: competitors.map((c) => ({ id: c.id, name: c.name })),
    rows,
    articles: recent.length,
    notOnMap: [...topics.entries()]
      .map(([key, t]) => ({ topic: t.topic, count: t.count, competitors: [...t.competitors].sort(), state: opts.topicStates?.get(key) ?? ("new" as TopicState) }))
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.count - a.count || a.topic.localeCompare(b.topic))
      .slice(0, MAX_TOPICS),
    added: [...added.entries()]
      .map(([subjectId, t]) => ({ topic: subjects.get(subjectId)!.name, subjectId, count: t.count, competitors: [...t.competitors].sort() }))
      .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
      .slice(0, MAX_TOPICS),
    moved: Boolean(opts.moved),
  };
}

/** Topics still to add, for Next up: not one a person dismissed, in the three fields it keeps. */
export function stillToAdd(view: Pick<CoverageView, "notOnMap"> | null): Array<{ topic: string; count: number; competitors: string[] }> | null {
  if (!view) return null;
  return view.notOnMap.filter((t) => t.state !== "dismissed").map(({ topic, count, competitors }) => ({ topic, count, competitors }));
}

/** The brand's decided subjects, with how many of each one's questions it has answered, drafted or planned. */
export async function ourSubjects(
  ctx: TenantContext,
  deps: CoverageDeps = {},
): Promise<{ subjects: Map<string, OurSubject>; moved: boolean; map: BrandMap | null }> {
  const map = await decidedBrandMap(ctx, deps.db).catch(() => null);
  if (!map) return { subjects: new Map(), moved: false, map: null };
  if (isBrandMapScaleEnabled() && map.moved) {
    const rows = await listSubjects(ctx, { status: "decided" }, { db: deps.db }).catch(() => []);
    return {
      subjects: new Map(
        rows.filter((r) => !r.mergedInto).map((r) => [r.id, { name: r.name, you: r.counts.answered + r.counts.drafted + r.counts.planned, questions: r.counts.questions }]),
      ),
      moved: true,
      map,
    };
  }
  const pages = await listBrandMapPages(ctx, deps.db).catch(() => []);
  const coverage = computeCoverage(map, pages);
  return {
    subjects: new Map(coverage.subjects.map((s) => [s.id, { name: s.name, you: s.questions.filter((q) => q.state !== "open").length, questions: s.questions.length }])),
    moved: false,
    map,
  };
}

/**
 * Topics waiting as proposals or dismissed, by topicKey: a moved map's subject records, or a
 * small map's waiting suggestions. Dismissed wins over waiting, as filing does.
 */
export async function topicStatesOf(
  ctx: TenantContext,
  ours: { moved: boolean; map: BrandMap | null },
  deps: CoverageDeps = {},
): Promise<Map<string, Exclude<TopicState, "new">>> {
  const states = new Map<string, Exclude<TopicState, "new">>();
  if (!ours.map) return states;
  if (ours.moved) {
    const [proposed, dismissed] = await Promise.all([
      listSubjects(ctx, { status: "proposed" }, { db: deps.db }).catch(() => []),
      listSubjects(ctx, { status: "dismissed" }, { db: deps.db }).catch(() => []),
    ]);
    for (const s of proposed) states.set(topicKey(s.name), "suggested");
    for (const s of dismissed) states.set(topicKey(s.name), "dismissed");
  } else {
    for (const s of ours.map.suggestions) if (s.change.type === "add_subject") states.set(topicKey(s.change.name), "suggested");
  }
  for (const key of ours.map.dismissed) if (key.startsWith("subject:")) states.set(key.slice("subject:".length), "dismissed");
  return states;
}

async function mayRead(ctx: TenantContext, deps: CoverageDeps): Promise<boolean> {
  return isCompetitorArticlesEnabled() && (await (deps.canUse ?? ((c) => brandCanUse(c, "competitor_articles")))(ctx));
}

/** A competitor's articles for its page, or null when this brand doesn't have them. */
export async function articlesForDetail(
  ctx: TenantContext,
  competitorId: string,
  deps: CoverageDeps = {},
): Promise<{ list: CompetitorArticle[]; subjectNames: Record<string, string> } | null> {
  if (!(await mayRead(ctx, deps))) return null;
  const [list, ours] = await Promise.all([listArticles(ctx, competitorId, deps), ourSubjects(ctx, deps)]);
  const subjectNames: Record<string, string> = {};
  for (const a of list) for (const id of a.subjectIds) if (ours.subjects.has(id)) subjectNames[id] = ours.subjects.get(id)!.name;
  return { list, subjectNames };
}

/** Each subject competitors wrote about in the window: how many articles, and what it means. Pure. */
export function subjectFlagsFrom(
  articles: CompetitorArticle[],
  competitors: Array<Pick<Competitor, "id" | "name">>,
  subjects: Map<string, OurSubject>,
  nowMs: number,
): Record<string, { they: number; flag: CoverageFlag }> {
  const view = coverageFrom(articles, competitors, subjects, { nowMs, allSubjects: false, maxRows: Number.MAX_SAFE_INTEGER });
  return Object.fromEntries(view.rows.filter((r) => r.they > 0).map((r) => [r.subjectId, { they: r.they, flag: r.flag }]));
}

/** For the brand map's subject list. Null when this brand doesn't have it. */
export async function competitorSubjectFlags(ctx: TenantContext, deps: CoverageDeps = {}): Promise<Record<string, { they: number; flag: CoverageFlag }> | null> {
  if (!(await mayRead(ctx, deps))) return null;
  const [articles, competitors, ours] = await Promise.all([listReadArticles(ctx, deps), listCompetitors(ctx, deps), ourSubjects(ctx, deps)]);
  return subjectFlagsFrom(articles, competitors, ours.subjects, (deps.now ?? (() => new Date()))().getTime());
}

/** The whole page: every competitor, every read article, every subject. Null when this brand doesn't have it. */
export async function competitorCoverage(ctx: TenantContext, deps: CoverageDeps = {}): Promise<CoverageView | null> {
  if (!(await mayRead(ctx, deps))) return null;
  const [articles, competitors, ours] = await Promise.all([listReadArticles(ctx, deps), listCompetitors(ctx, deps), ourSubjects(ctx, deps)]);
  const topicStates = await topicStatesOf(ctx, ours, deps).catch(() => undefined);
  // A small map shows every subject (open ones too); a moved map the ones competitors wrote about and the biggest open ones.
  return coverageFrom(articles, competitors, ours.subjects, {
    nowMs: (deps.now ?? (() => new Date()))().getTime(),
    allSubjects: !ours.moved,
    topicStates,
    moved: ours.moved,
  });
}
