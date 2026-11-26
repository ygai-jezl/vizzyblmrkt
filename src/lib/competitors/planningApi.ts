import { cutOff, type CutOff } from "@/lib/search/family";
import type { FamilyDeps } from "@/lib/search/familyIndex";
import { isSearchCompetitorReadsEnabled } from "@/lib/search/flags";
import { NextResponse } from "next/server";
import { z } from "zod";
import { afterRecordsChange } from "@/lib/brandMap/afterChange";
import { questionKey } from "@/lib/brandMap/keys";
import { decideProposals } from "@/lib/brandMap/proposals";
import { fileBrandMapSuggestions } from "@/lib/brandMap/store";
import { createSubject, getSubject, subjectQuestions } from "@/lib/brandMap/records";
import { isSuggestAngleEnabled } from "@/lib/content/create/flags";
import { brandCanUse } from "@/lib/plans/brandAccess";
import type { FirestoreLike, KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import type { ArticleFormat, CompetitorArticle } from "@/lib/types/competitor";
import type { embedQuery } from "@/lib/agents/embeddings";
import type { AddTopicsResult } from "./addTopics";
import { articlesOnSubject, articlesOnTopic, linkTopicArticles, questionsNobodyCovers } from "./articles";
import { competitorCoverage, competitorSubjectFlags, COVERAGE_DAYS, topicKey } from "./coverage";
import { isCompetitorArticlesPlanningEnabled } from "./flags";
import { listCompetitors } from "./store";
import { cleanTitle } from "./titles";
import { FORMAT_LABEL, askLabel } from "./view";

/**
 * Planning's side of competitor articles (COMPETITOR_ARTICLES_PLANNING_ENABLED): what competitors
 * wrote on one brand map subject (for its panel), and adding subjects they write about that the
 * map lacks, when an admin ticks them. The routes check origin, switch, sign-in and role.
 */

export interface PlanningApiDeps extends FamilyDeps {
  db?: FirestoreLike;
  now?: () => Date;
  canUse?: (ctx: TenantContext) => Promise<boolean>;
  /** Test seams: a subject's questions, and meaning. */
  questions?: (ctx: TenantContext, subjectId: string) => Promise<Array<{ id: string; text: string; status: string; mergedInto?: string | null }>>;
  query?: typeof embedQuery;
  vectors?: KnowledgeCollectionLike;
}

const noStore = { "cache-control": "no-store" };

async function allowed(ctx: TenantContext, deps: PlanningApiDeps): Promise<Response | null> {
  if (!isCompetitorArticlesPlanningEnabled()) return NextResponse.json({ error: "competitor_articles_disabled" }, { status: 503 });
  if (!(await (deps.canUse ?? ((c) => brandCanUse(c, "competitor_articles")))(ctx))) return NextResponse.json({ error: "not_included" }, { status: 403 });
  return null;
}

export interface SubjectCompetitors {
  total: number;
  competitors: Array<{ name: string; count: number; formats: string[]; asks: string[]; latest: { title: string; url: string; publishedAt: string | null } }>;
  angles: Array<{ competitor: string; angle: string; url: string }>;
  stats: Array<{ figure: string; about: string; url: string; domain: string }>;
  /** Formats no competitor used on this subject, as words after "written": room to stand out. */
  nobodyHas: string[];
  /** The subject's questions no competitor article is near in meaning (ids, in the subject's order). */
  uncovered: string[];
  /** Whether Write this next opens with an angle suggested (CREATE_SUGGEST_ANGLE_ENABLED). */
  suggestAngle: boolean;
  /** Questions their articles on it answer that the subject doesn't have yet, newest first. */
  theirQuestions: Array<{ text: string; competitor: string; url: string }>;
  /**
   * The subject's decided questions, open unless its last count found them answered, drafted or
   * planned: what the box needs to write one, in this one request (no recount).
   */
  questions: Array<{ id: string; text: string; open: boolean }>;
}

/** The formats worth noticing when nobody has used one on a subject, as they read after "written". */
const NOTABLE: Array<[ArticleFormat, string]> = [
  ["case_study", "a case study"],
  ["research", "research"],
  ["how_to", "a how to"],
  ["comparison", "a comparison"],
  ["guide", "a guide"],
];

/** Their questions offered for a subject, at most. */
const THEIR_QUESTIONS = 5;

/** Questions checked against their articles' meaning, at most, per subject. */
const CHECK_QUESTIONS = 6;
/** As close in meaning as planning's other matches (planning.ts MIN_SIM): a pair, one for each store (ADR-0023). */
export const COVERED_SIM: CutOff = { old: 0.65, new: 0.65 };

/** Who a competitor is: its name, and its site to take off the end of titles. */
export type CompetitorNames = Map<string, { name: string; site: string }>;

/** What competitors wrote on one subject, for its panel. Pure. */
export function subjectCompetitorsOf(articles: CompetitorArticle[], names: CompetitorNames): Omit<SubjectCompetitors, "uncovered" | "suggestAngle" | "theirQuestions" | "questions"> {
  const read = articles.filter((a) => a.status === "read" && names.has(a.competitorId));
  const byCompetitor = new Map<string, CompetitorArticle[]>();
  for (const a of read) byCompetitor.set(a.competitorId, [...(byCompetitor.get(a.competitorId) ?? []), a]);
  const used = new Set(read.flatMap((a) => (a.format ? [a.format] : [])));
  const seen = new Set<string>();
  return {
    total: read.length,
    competitors: [...byCompetitor.entries()]
      .map(([id, list]) => {
        const who = names.get(id)!;
        return {
          name: who.name,
          count: list.length,
          formats: [...new Set(list.flatMap((a) => (a.format ? [FORMAT_LABEL[a.format]] : [])))].slice(0, 3),
          asks: [...new Set(list.flatMap((a) => a.asks.filter((x) => x.kind !== "other").map((x) => askLabel(x.kind))))].slice(0, 3),
          latest: { title: cleanTitle(list[0]!.title, [who.name, who.site]), url: list[0]!.url, publishedAt: list[0]!.publishedAt },
        };
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    angles: firstOfEach(read.filter((a) => a.angle))
      .slice(0, 5)
      .map((a) => ({ competitor: names.get(a.competitorId)!.name, angle: a.angle, url: a.url })),
    stats: read
      .flatMap((a) => a.stats.filter((s) => !s.theirOwn && s.source).map((s) => ({ figure: s.figure, about: s.about, url: s.source!.url, domain: s.source!.domain })))
      .filter((s) => (seen.has(`${s.figure}|${s.domain}`) ? false : (seen.add(`${s.figure}|${s.domain}`), true)))
      .slice(0, 5),
    nobodyHas: read.length ? NOTABLE.filter(([f]) => !used.has(f)).map(([, words]) => words) : [],
  };
}

/** The questions their articles answer that the subject lacks (by questionKey), one per wording, newest first. Pure. */
export function theirQuestionsOf(
  articles: CompetitorArticle[],
  names: CompetitorNames,
  onSubject: Set<string>,
): SubjectCompetitors["theirQuestions"] {
  const seen = new Set(onSubject);
  const out: SubjectCompetitors["theirQuestions"] = [];
  for (const a of articles) {
    const text = a.question?.replace(/\s+/g, " ").trim() ?? "";
    const key = text ? questionKey(text) : "";
    if (a.status !== "read" || !names.has(a.competitorId) || !key || seen.has(key)) continue;
    seen.add(key);
    out.push({ text, competitor: names.get(a.competitorId)!.name, url: a.url });
    if (out.length >= THEIR_QUESTIONS) break;
  }
  return out;
}

/** One from each competitor first (newest first), then the rest: one competitor can't fill a short list. */
function firstOfEach(list: CompetitorArticle[]): CompetitorArticle[] {
  const seen = new Set<string>();
  const first: CompetitorArticle[] = [];
  const rest: CompetitorArticle[] = [];
  for (const a of list) (seen.has(a.competitorId) ? rest : (seen.add(a.competitorId), first)).push(a);
  return [...first, ...rest];
}

const SUBJECT_ID = /^sub_[A-Za-z0-9_-]{4,80}$/;

export async function subjectCompetitorsFromRequest(ctx: TenantContext, subjectId: string, deps: PlanningApiDeps = {}): Promise<Response> {
  const blocked = await allowed(ctx, deps);
  if (blocked) return blocked;
  if (!SUBJECT_ID.test(subjectId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const [onSubject, competitors, subject] = await Promise.all([
    articlesOnSubject(ctx, subjectId, deps),
    listCompetitors(ctx, deps),
    getSubject(ctx, subjectId, { db: deps.db }).catch(() => null),
  ]);
  // A subject added from a topic they write about: the articles it came from are on it too.
  const onTopic = subject ? await articlesOnTopic(ctx, subject.name, deps).catch(() => []) : [];
  const ids = new Set(onSubject.map((a) => a.id));
  const articles = [...onSubject, ...onTopic.filter((a) => !ids.has(a.id))].sort(
    (a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") || b.queuedAt.localeCompare(a.queuedAt),
  );
  const names: CompetitorNames = new Map(competitors.map((c) => [c.id, { name: c.name, site: c.site }]));
  const view = subjectCompetitorsOf(articles, names);
  const all = await (deps.questions ?? ((c, id) => subjectQuestions(c, id, { db: deps.db })))(ctx, subjectId).catch(() => []);
  const decided = all.filter((q) => q.status === "decided" && !q.mergedInto && q.text.trim());
  // What the subject's last count found: kept on it, so nothing is counted again here.
  const done = new Set([...(subject?.answeredIds ?? []), ...(subject?.draftedIds ?? []), ...(subject?.plannedIds ?? [])]);
  const questions = decided.map((q) => ({ id: q.id, text: q.text, open: !done.has(q.id) }));
  // Which of the subject's questions their articles don't answer, and theirs it lacks: only worth asking when they wrote on it.
  let uncovered: string[] = [];
  let theirQuestions: SubjectCompetitors["theirQuestions"] = [];
  if (view.total) {
    uncovered = (await questionsNobodyCovers(ctx, decided.slice(0, CHECK_QUESTIONS), cutOff(COVERED_SIM, isSearchCompetitorReadsEnabled()), deps)) ?? [];
    theirQuestions = theirQuestionsOf(articles, names, new Set(all.filter((q) => q.status !== "dismissed").map((q) => questionKey(q.text))));
  }
  return NextResponse.json({ competitors: { ...view, uncovered, suggestAngle: isSuggestAngleEnabled(), theirQuestions, questions } }, { headers: noStore });
}

/** How much competitors wrote on each subject, and what it means, for the subject list. */
export async function subjectFlagsFromRequest(ctx: TenantContext, deps: PlanningApiDeps = {}): Promise<Response> {
  const blocked = await allowed(ctx, deps);
  if (blocked) return blocked;
  const subjects = await competitorSubjectFlags(ctx, { ...deps, canUse: async () => true });
  return NextResponse.json({ subjects: subjects ?? {} }, { headers: noStore });
}

const TopicsBody = z.object({ topics: z.array(z.string().trim().min(2).max(80)).min(1).max(10) });

/**
 * Topics they write about, and the map lacks, ticked by an admin. Only topics the page offered.
 * On a moved map each becomes a decided subject, as if typed into Subjects › Add: a new one is
 * made, a dismissed one comes back, a waiting proposal is accepted. A small map gets plain
 * suggestions, as before: adding records would move it.
 */
export async function addTopicsFromRequest(ctx: TenantContext, body: unknown, deps: PlanningApiDeps = {}): Promise<Response> {
  const blocked = await allowed(ctx, deps);
  if (blocked) return blocked;
  const parsed = TopicsBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const view = await competitorCoverage(ctx, { ...deps, canUse: async () => true });
  const wanted = new Set(parsed.data.topics.map((t) => topicKey(t)));
  const topics = (view?.notOnMap ?? []).filter((t) => wanted.has(topicKey(t.topic)));
  // Ticked on a page drawn before they were added.
  const already = (view?.added ?? []).filter((t) => wanted.has(topicKey(t.topic))).map((t) => t.topic);

  if (!view?.moved) {
    if (!topics.length) return NextResponse.json({ mode: "suggested", filed: 0, already } satisfies AddTopicsResult);
    const items = topics.map((t) => ({
      change: { type: "add_subject" as const, name: t.topic },
      reason: `${t.competitors.join(" and ")} wrote ${t.count} article${t.count === 1 ? "" : "s"} about it in the last ${COVERAGE_DAYS} days.`,
    }));
    const r = await fileBrandMapSuggestions(ctx, { from: "competitors", items }, { db: deps.db });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ mode: "suggested", filed: r.value.filed.length, already } satisfies AddTopicsResult);
  }

  const added: string[] = [];
  const accept: string[] = [];
  const touched: string[] = [];
  // Topic key → the subject it is now, so the articles it came from go on it.
  const subjectByKey = new Map<string, string>();
  let full = false;
  for (const t of topics) {
    const r = await createSubject(ctx, { name: t.topic }, { db: deps.db });
    if (r.ok) {
      added.push(r.value.name);
      touched.push(...r.touched);
      subjectByKey.set(topicKey(t.topic), r.value.id);
      continue;
    }
    const current = r.current as { id?: string; name?: string; status?: string } | undefined;
    if (r.error === "subject_exists" && current?.status === "proposed" && current.id) {
      accept.push(current.id);
      added.push(current.name ?? t.topic);
      subjectByKey.set(topicKey(t.topic), current.id);
    } else if (r.error === "subject_exists") already.push(current?.name ?? t.topic);
    else if (r.error === "too_many_subjects") {
      full = true;
      break;
    } else return NextResponse.json({ error: r.error }, { status: r.status });
  }
  if (accept.length) touched.push(...(await decideProposals(ctx, { accept: { subjects: accept } }, { db: deps.db })).touched);
  if (touched.length) await afterRecordsChange(ctx, { subjects: touched }, { db: deps.db }).catch(() => undefined);
  await linkTopicArticles(ctx, subjectByKey, topicKey, deps).catch(() => 0);
  if (full && !added.length) return NextResponse.json({ error: "too_many_subjects" }, { status: 409 });
  return NextResponse.json({ mode: "added", added, already } satisfies AddTopicsResult);
}
