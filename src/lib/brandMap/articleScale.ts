import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BrandMap } from "@/lib/types/brandMap";
import type { BrandMapSubjectRecord } from "@/lib/types/brandMapRecords";
import { planPageId } from "@/lib/types/brandMapPage";
import { projectArticleMap, type ArticleMap, type ArticleMapSubject } from "@/lib/content/blog/articleMap";
import { textKey } from "@/lib/content/blog/brief";
import { nearestSubjects, type EmbedDeps } from "./embed";
import { isBrandMapPagesEnabled } from "./flags";
import { getSubject, parseQuestion, parseSubject, subjectQuestions } from "./records";
import { subjectCoverage } from "./recount";

/**
 * What an article sees of a map at any size (BRAND_MAP_SCALE_ENABLED, once the map moved):
 * the brand's identity and names, its own subject and its main question's (always fetched by
 * id, so a partial map never loses a link that is still on the map), and — with no subject
 * chosen — the subjects nearest it by meaning, for research to pick from. Its own subject's
 * coverage is worked out now; the others' comes from their stored counts.
 */

export interface ArticleAsk {
  /** The brief's subject: an id, null (a person chose none), or undefined (research picks). */
  subjectId?: string | null;
  /** The map question the article answers. */
  primaryRef?: string;
  /** What the article is about, to find the subjects near it. */
  text?: string;
}

/** Subjects offered when none is chosen. */
export const NEAREST_SUBJECTS = 12;
const BUDGET_MS = 3_000;

type Deps = EmbedDeps & { db?: FirestoreLike };

function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => timer && clearTimeout(timer));
}

const onMap = (s: BrandMapSubjectRecord | null): s is BrandMapSubjectRecord => Boolean(s && s.status === "decided" && !s.mergedInto);

async function asArticleSubjects(ctx: TenantContext, subjects: BrandMapSubjectRecord[], deps: Deps): Promise<ArticleMapSubject[]> {
  const questions = await Promise.all(subjects.map((s) => subjectQuestions(ctx, s.id, deps)));
  return subjects.map((s, i) => ({
    id: s.id,
    name: s.name,
    home: s.home,
    questions: questions[i]!.filter((q) => q.status === "decided").map((q) => ({ id: q.id, text: q.text, intent: q.intent })),
  }));
}

export async function articleMapAtScale(
  ctx: TenantContext,
  map: BrandMap,
  opts: { ask?: ArticleAsk; pages?: boolean; planId?: string },
  deps: Deps = {},
): Promise<ArticleMap> {
  const article: ArticleMap = { ...projectArticleMap({ ...map, subjects: [] }), atScale: true };
  const ask = opts.ask ?? {};
  const store = brandMapRecords(ctx, deps.db);

  // The article's own subject, and its main question's, by id.
  const own: BrandMapSubjectRecord[] = [];
  if (ask.subjectId) {
    const s = await getSubject(ctx, ask.subjectId, deps);
    if (onMap(s)) own.push(s);
  }
  if (ask.primaryRef) {
    const q = parseQuestion(await store.get("q", ask.primaryRef));
    if (q?.status === "decided") {
      const s = await getSubject(ctx, q.subjectId, deps);
      if (onMap(s) && !own.some((x) => x.id === s.id)) own.push(s);
    }
  }
  // With none chosen, the subjects nearest the article, for research to pick from.
  let near: BrandMapSubjectRecord[] = [];
  if (ask.subjectId === undefined && ask.text?.trim()) {
    const found = await within(nearestSubjects(ctx, ask.text, { limit: NEAREST_SUBJECTS }, deps), BUDGET_MS, []);
    const ids = found.map((n) => n.ref).filter((id) => !own.some((x) => x.id === id));
    const byId = new Map((await store.getMany("sub", ids)).flatMap((r) => (parseSubject(r) ? [[r.id, parseSubject(r)!] as const] : [])));
    near = ids.map((id) => byId.get(id) ?? null).filter(onMap);
  }
  const subjects = [...own, ...near];
  article.subjects = await asArticleSubjects(ctx, subjects, deps);

  if (opts.pages && isBrandMapPagesEnabled()) {
    // The others' state from their stored counts: enough to tell what is still open.
    for (const s of near) {
      for (const id of s.answeredIds) article.answered[id] = { title: "", url: null, state: "live" };
      for (const id of s.draftedIds) article.answered[id] ??= { title: "", url: null, state: "draft" };
      for (const id of s.plannedIds) article.answered[id] ??= { title: "", url: null, state: "planned" };
    }
    // Its own subject's, worked out now (never counting the article itself).
    const exclude = opts.planId ? planPageId(opts.planId) : undefined;
    for (const s of own) {
      const read = await within(subjectCoverage(ctx, s.id, deps, { exclude }), BUDGET_MS, null);
      if (!read) continue;
      Object.assign(article.answered, read.answered);
      article.siblings.push(...read.siblings);
    }
  }
  return article;
}

/**
 * Map questions with these words, wherever they are on the map, and the subjects they are on
 * (with their questions): research matches the questions it found against the whole map, not
 * just the part it was given.
 */
export async function mapQuestionsByWords(ctx: TenantContext, texts: string[], deps: Deps = {}): Promise<ArticleMapSubject[]> {
  const keys = [...new Set(texts.map(textKey).filter(Boolean))];
  if (!keys.length) return [];
  const store = brandMapRecords(ctx, deps.db);
  const found = (await store.findIn("q", "textKey", keys)).flatMap((r) => parseQuestion(r) ?? []).filter((q) => q.status === "decided");
  const subjects = (await store.getMany("sub", [...new Set(found.map((q) => q.subjectId))])).flatMap((r) => parseSubject(r) ?? []).filter(onMap);
  return asArticleSubjects(ctx, subjects, deps);
}
