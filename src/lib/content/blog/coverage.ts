import type { BlogIntent } from "@/lib/types/contentPlan";
import type { BrandMapPage, BrandMapPageState } from "@/lib/types/brandMapPage";
import type { AnsweredBy, ArticleMap } from "./articleMap";
import { normalizeUrl, textKey } from "./brief";

/**
 * What the brand's pages answer, worked out from the map and the page rows when read
 * (BRAND_MAP_PAGES_ENABLED), never stored, so editing the map never leaves it stale.
 * Pure + client-safe.
 *
 * A page answers a map question for sure when it carries the question's id (it was started
 * from it, or research copied it word for word) or uses its exact words. Close wording only
 * ever shows as "probably answered"; it never counts.
 */

export type QuestionState = "open" | "planned" | "drafted" | "answered";

/** A page as coverage shows it. */
export interface CoveragePage {
  id: string;
  kind: "article" | "site";
  title: string;
  url: string | null;
  state: BrandMapPageState;
  workspaceId: string | null;
  planId: string | null;
}

export interface QuestionCoverage {
  id: string;
  text: string;
  intent: BlogIntent;
  state: QuestionState;
  /** The pages that answer it for sure, furthest along first. */
  pages: CoveragePage[];
  /** A page whose wording is close, when none answers it for sure. Never counts. */
  probably: CoveragePage | null;
}

export interface SubjectCoverage {
  id: string;
  name: string;
  questions: QuestionCoverage[];
  answered: number;
}

/** Two or more pages with the same main question. */
export interface Overlap {
  question: string;
  pages: CoveragePage[];
}

/** An older live page on a subject that does not link to a newer one on it. */
export interface MissingLink {
  subjectId: string;
  from: CoveragePage;
  to: CoveragePage;
}

export interface Coverage {
  subjects: SubjectCoverage[];
  overlaps: Overlap[];
  missingLinks: MissingLink[];
  /** For an article's research: map question id → the page that answers it. */
  answered: Record<string, AnsweredBy>;
  /** For an article's research: live articles per subject, newest first. */
  siblings: ArticleMap["siblings"];
}

type MapSubjects = { subjects: Array<{ id: string; name: string; home?: string | null; questions: Array<{ id: string; text: string; intent: BlogIntent }> }> };
type PageFacts = Pick<BrandMapPage, "primaryRef" | "primaryQuestion" | "questions" | "title">;

const RANK: Record<BrandMapPageState, number> = { live: 3, approved: 2, draft: 1, planned: 0 };
const QUESTION_STATE: Record<BrandMapPageState, QuestionState> = { live: "answered", approved: "drafted", draft: "drafted", planned: "planned" };
const ANSWERED_STATE: Record<BrandMapPageState, AnsweredBy["state"]> = { live: "live", approved: "draft", draft: "draft", planned: "planned" };
const MAX_MISSING_LINKS = 30;
const MAX_SIBLINGS = 5;

const STOP = new Set(
  "a an and are as at be by can do does for from has have how i in is it its of on or our should the their them they this to vs was what when where which who why will with you your".split(" "),
);
const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2 && !STOP.has(w)));

/** Close wording: most of the words that carry meaning are shared. */
function close(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (x.size < 2 || y.size < 2) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared) >= 0.6;
}

/** Does a page answer this map question: for sure, probably, or not? */
export function matchQuestion(q: { id: string; text: string }, page: PageFacts): "sure" | "probably" | null {
  if (page.primaryRef === q.id || page.questions.some((x) => x.ref === q.id)) return "sure";
  const key = textKey(q.text);
  const said = [page.primaryQuestion, page.title, ...page.questions.map((x) => x.text)].filter(Boolean);
  if (key && said.some((s) => textKey(s) === key)) return "sure";
  return said.some((s) => close(q.text, s)) ? "probably" : null;
}

const show = (r: BrandMapPage): CoveragePage => ({
  id: r.id,
  kind: r.kind,
  title: r.title || r.primaryQuestion || r.url || "Untitled",
  url: r.url,
  state: r.state,
  workspaceId: r.workspaceId,
  planId: r.planId,
});

const furthest = (a: BrandMapPage, b: BrandMapPage) => RANK[b.state] - RANK[a.state] || (b.liveAt ?? "").localeCompare(a.liveAt ?? "");

/** Coverage of the map's subjects by the brand's pages. */
export function computeCoverage(map: MapSubjects, rows: BrandMapPage[]): Coverage {
  const answered: Record<string, AnsweredBy> = {};
  const subjectsOf = new Map<string, Set<string>>(rows.map((r) => [r.id, new Set(r.subjectId ? [r.subjectId] : [])]));

  const subjects = map.subjects.map((s): SubjectCoverage => {
    const home = s.home ? normalizeUrl(s.home) : "";
    for (const r of rows) if (home && r.url && normalizeUrl(r.url) === home) subjectsOf.get(r.id)!.add(s.id);
    const questions = s.questions.map((q): QuestionCoverage => {
      const sure: BrandMapPage[] = [];
      let probably: BrandMapPage | null = null;
      for (const r of rows) {
        const m = matchQuestion(q, r);
        if (m === "sure") {
          sure.push(r);
          subjectsOf.get(r.id)!.add(s.id);
        } else if (m === "probably" && (!probably || furthest(r, probably) < 0)) probably = r;
      }
      sure.sort(furthest);
      const best = sure[0];
      if (best) answered[q.id] = { title: show(best).title, url: best.url, state: ANSWERED_STATE[best.state] };
      return {
        id: q.id,
        text: q.text,
        intent: q.intent,
        state: best ? QUESTION_STATE[best.state] : "open",
        pages: sure.map(show),
        probably: best || !probably ? null : show(probably),
      };
    });
    return { id: s.id, name: s.name, questions, answered: questions.filter((q) => q.state === "answered").length };
  });

  // The same main question on two pages: by the map question it is, else its words.
  const refText = new Map(map.subjects.flatMap((s) => s.questions.map((q) => [q.id, textKey(q.text)] as const)));
  const byMain = new Map<string, BrandMapPage[]>();
  for (const r of rows) {
    if (r.kind !== "article") continue;
    const key = (r.primaryRef && refText.get(r.primaryRef)) || textKey(r.primaryQuestion);
    if (key) byMain.set(key, [...(byMain.get(key) ?? []), r]);
  }
  const overlaps = [...byMain.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({ question: group[0]!.primaryQuestion || group[0]!.title, pages: [...group].sort(furthest).map(show) }));

  // Per subject, live pages oldest first: each should link to every newer one.
  const missingLinks: MissingLink[] = [];
  const listedPairs = new Set<string>();
  const siblings: Coverage["siblings"] = [];
  for (const s of map.subjects) {
    const live = rows
      .filter((r) => r.state === "live" && r.url && subjectsOf.get(r.id)!.has(s.id))
      .sort((a, b) => (a.liveAt ?? "").localeCompare(b.liveAt ?? ""));
    for (const r of [...live].reverse()) if (r.kind === "article" && siblings.filter((x) => x.subjectId === s.id).length < MAX_SIBLINGS) siblings.push({ subjectId: s.id, title: show(r).title, url: r.url! });
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        const older = live[i]!;
        const newer = live[j]!;
        // A page whose links were never read is not said to be missing one.
        const pair = `${older.id}>${newer.id}`;
        if (missingLinks.length < MAX_MISSING_LINKS && older.linksKnown && !listedPairs.has(pair) && !older.links.includes(normalizeUrl(newer.url!))) {
          listedPairs.add(pair);
          missingLinks.push({ subjectId: s.id, from: show(older), to: show(newer) });
        }
      }
    }
  }

  return { subjects, overlaps, missingLinks, answered, siblings };
}
