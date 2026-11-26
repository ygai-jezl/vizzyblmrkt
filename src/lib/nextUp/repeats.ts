import { embedDocuments } from "@/lib/agents/embeddings";
import { addLearned, listLearned } from "@/lib/autopilot/learned";
import { isNextUpRepeatsEnabled } from "@/lib/autopilot/flags";
import { recountSubject } from "@/lib/brandMap/recount";
import { parseQuestion } from "@/lib/brandMap/records";
import { QUESTION_TITLE } from "@/lib/brandNotes/store";
import { matchQuestion } from "@/lib/content/blog/coverage";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { listAllBrandMapPages } from "@/lib/tenant/brandMapPages";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { CloseTo, RepeatPair } from "@/lib/types/autopilot";
import { BrandMapPageSchema, type BrandMapPage } from "@/lib/types/brandMapPage";
import type { Candidate } from "./candidates";

/**
 * Stop repeats (NEXT_UP_REPEATS_ENABLED): before Next up offers a brand map question, it is matched
 * by meaning against every article of the brand's, live or being written: their main question,
 * title and the questions they list. Both sides are embedded together, the way the brand's notes
 * measure a repeated question (src/lib/content/blog/seen.ts), with cut offs measured for buyer
 * questions (scripts/measure-repeat-match.ts).
 *
 * - The same question as a live article's: linked as answered by it (on the map question), so it
 *   counts as answered and is never offered again, until a person unlinks it.
 * - The same as, or close to, an article being written: left out; it is in that article already.
 * - Close to a live article: offered with `closeTo`, as "Add to that article".
 * - Two live articles whose main questions are the same: said, so a person can keep one.
 *
 * If the embedding fails, close wording (coverage's "probably") counts as close, never as the same.
 */

/**
 * The same question reworded, linked as answered with no one asked. Measured with
 * scripts/measure-repeat-match.ts on text-embedding-005 (2026-11-25), re-run it before changing
 * either: buyer questions reworded scored 0.953 to 0.992, while a different ask sharing a long
 * phrase scored up to 0.942 ("What is AI search visibility tracking?" against "How much do AI
 * search visibility tracking tools cost?" 0.939). The brand's notes use 0.93 for their questions
 * (seen.ts); here a wrong link is silent, so the bar is higher, and a rewording it misses is only
 * offered as close.
 */
export const SAME_SIM = 0.95;
/** Close enough that adding to the article is worth offering first; a person can still write it anyway. */
export const CLOSE_SIM = 0.88;
/** A person who wrote one anyway isn't asked again about it for this long. */
export const WROTE_ANYWAY_DAYS = 90;
/** At most this many questions are linked in one pick. */
export const MAX_LINKS = 100;
/** Each article is matched on at most this many of its texts. */
const TEXTS_PER_PAGE = 8;
const MAX_PAIRS = 5;

export interface RepeatDeps {
  db?: FirestoreLike;
  now?: () => Date;
  embed?: typeof embedDocuments;
  /** The brand's article rows (tests inject them). */
  pages?: (ctx: TenantContext) => Promise<BrandMapPage[]>;
}

export interface Linked {
  questionId: string;
  subjectId: string;
  pageId: string;
  sim: number;
}

export interface Repeats {
  linked: Linked[];
  /** Questions an article being written already covers. */
  inProgress: string[];
  close: Map<string, CloseTo>;
  repeatsLive: RepeatPair[];
  /** False when the embedding failed and wording was used instead. */
  byMeaning: boolean;
}

export const NO_REPEATS: Repeats = { linked: [], inProgress: [], close: new Map(), repeatsLive: [], byMeaning: false };

export function cosine(x: readonly number[], y: readonly number[]): number {
  let dot = 0;
  let nx = 0;
  let ny = 0;
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    dot += x[i]! * y[i]!;
    nx += x[i]! * x[i]!;
    ny += y[i]! * y[i]!;
  }
  return nx && ny ? dot / Math.sqrt(nx * ny) : 0;
}

/** What an article says it answers, main question first. */
export function pageTexts(page: Pick<BrandMapPage, "primaryQuestion" | "title" | "questions">): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [page.primaryQuestion, page.title, ...page.questions.map((q) => q.text)]) {
    const text = (t ?? "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text.slice(0, 300));
    if (out.length >= TEXTS_PER_PAGE) break;
  }
  return out;
}

const isLive = (p: BrandMapPage) => p.state === "live";
const titleOf = (p: BrandMapPage) => p.title || p.primaryQuestion || p.url || "Untitled";
const closeOf = (p: BrandMapPage, sim: number): CloseTo => ({ planId: p.planId, workspaceId: p.workspaceId, title: titleOf(p).slice(0, 200), url: p.url, liveAt: p.liveAt, sim: Math.round(sim * 1000) / 1000 });

async function articleRows(ctx: TenantContext, deps: RepeatDeps): Promise<BrandMapPage[]> {
  if (deps.pages) return deps.pages(ctx);
  const raw = await listAllBrandMapPages(ctx, { where: [["kind", "==", "article"]], maxRows: 2000 }, deps.db);
  return raw.map((r) => BrandMapPageSchema.safeParse(r)).flatMap((r) => (r.success ? [r.data] : []));
}

/** What a person said about each question: pages they unlinked, and questions they wrote anyway lately. */
async function peopleSaid(ctx: TenantContext, questions: Candidate[], moved: boolean, deps: RepeatDeps): Promise<{ notAnsweredBy: Map<string, Set<string>>; wroteAnyway: Set<string> }> {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const since = now - WROTE_ANYWAY_DAYS * 86_400_000;
  const learned = await listLearned(ctx, { db: deps.db }).catch(() => []);
  const wroteAnyway = new Set(learned.filter((e) => e.kind === "wrote_anyway" && e.questionId && Date.parse(e.at) >= since).map((e) => e.questionId!));
  const notAnsweredBy = new Map<string, Set<string>>();
  if (moved) {
    const records = await brandMapRecords(ctx, deps.db).getMany("q", questions.map((q) => q.questionId)).catch(() => []);
    for (const raw of records) {
      const q = parseQuestion(raw);
      if (q?.notAnsweredBy.length) notAnsweredBy.set(q.id, new Set(q.notAnsweredBy));
    }
  }
  return { notAnsweredBy, wroteAnyway };
}

/** Match the candidates against the brand's articles. Empty with the switch off. */
export async function findRepeats(ctx: TenantContext, args: { questions: Candidate[]; moved: boolean }, deps: RepeatDeps = {}): Promise<Repeats> {
  if (!isNextUpRepeatsEnabled()) return NO_REPEATS;
  const questions = args.questions.filter((q) => !q.refresh);
  const pages = await articleRows(ctx, deps).catch(() => [] as BrandMapPage[]);
  if (!pages.length) return NO_REPEATS;
  const said = await peopleSaid(ctx, questions, args.moved, deps);
  const texts = pages.map(pageTexts);

  const flat = [...questions.map((q) => q.question), ...texts.flat()];
  const vectors = await (deps.embed ?? embedDocuments)(flat.map((content) => ({ content, title: QUESTION_TITLE })), ctx.region).catch(() => null);
  const byMeaning = Boolean(vectors && vectors.length === flat.length && vectors.every((v) => v?.length));
  const qv = byMeaning ? (vectors as number[][]).slice(0, questions.length) : [];
  const pv: number[][][] = [];
  if (byMeaning) {
    let k = questions.length;
    for (const t of texts) {
      pv.push((vectors as number[][]).slice(k, k + t.length));
      k += t.length;
    }
  }

  const out: Repeats = { linked: [], inProgress: [], close: new Map(), repeatsLive: [], byMeaning };
  questions.forEach((q, i) => {
    const unlinked = said.notAnsweredBy.get(q.questionId) ?? new Set<string>();
    let live: { page: BrandMapPage; sim: number } | null = null;
    let writing: { page: BrandMapPage; sim: number } | null = null;
    pages.forEach((page, j) => {
      if (unlinked.has(page.id)) return;
      let sim: number;
      if (byMeaning) {
        sim = Math.max(0, ...pv[j]!.map((v) => cosine(qv[i]!, v)));
      } else {
        // Wording only: close wording is close, never the same.
        const m = matchQuestion({ id: q.questionId, text: q.question }, page);
        sim = m ? CLOSE_SIM : 0;
      }
      if (isLive(page)) {
        if (!live || sim > live.sim) live = { page, sim };
      } else if (!writing || sim > writing.sim) writing = { page, sim };
    });
    const l = live as { page: BrandMapPage; sim: number } | null;
    const w = writing as { page: BrandMapPage; sim: number } | null;
    if (byMeaning && l && l.sim >= SAME_SIM && out.linked.length < MAX_LINKS) {
      out.linked.push({ questionId: q.questionId, subjectId: q.subjectId, pageId: l.page.id, sim: Math.round(l.sim * 1000) / 1000 });
    } else if (w && w.sim >= CLOSE_SIM) {
      out.inProgress.push(q.questionId);
    } else if (l && l.sim >= CLOSE_SIM && !said.wroteAnyway.has(q.questionId)) {
      out.close.set(q.questionId, closeOf(l.page, l.sim));
    }
  });

  // Two live articles whose main questions are the same.
  if (byMeaning) {
    const live = pages.map((p, j) => ({ p, v: pv[j]![0] })).filter((x) => isLive(x.p) && x.v);
    for (let a = 0; a < live.length && out.repeatsLive.length < MAX_PAIRS; a += 1) {
      for (let b = a + 1; b < live.length && out.repeatsLive.length < MAX_PAIRS; b += 1) {
        const sim = cosine(live[a]!.v!, live[b]!.v!);
        if (sim < SAME_SIM) continue;
        const show = (p: BrandMapPage) => ({ title: titleOf(p).slice(0, 200), url: p.url, planId: p.planId, workspaceId: p.workspaceId });
        const [older, newer] = (live[a]!.p.liveAt ?? "") <= (live[b]!.p.liveAt ?? "") ? [live[a]!.p, live[b]!.p] : [live[b]!.p, live[a]!.p];
        out.repeatsLive.push({ question: (older.primaryQuestion || titleOf(older)).slice(0, 300), pages: [show(older), show(newer)], sim: Math.round(sim * 1000) / 1000 });
      }
    }
  }
  return out;
}

/**
 * Keep each link on its map question, then count its subject again. Display data, like the counts:
 * it never moves the question's revision. Maps not yet moved to records keep no links (the question
 * is left out of this pick only).
 */
export async function linkAnswered(ctx: TenantContext, linked: Linked[], deps: Pick<RepeatDeps, "db" | "now"> = {}): Promise<number> {
  if (!linked.length) return 0;
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const store = brandMapRecords(ctx, deps.db);
  let n = 0;
  const subjects = new Set<string>();
  for (const l of linked) {
    const done = await store
      .claim("q", l.questionId, (cur) => {
        const q = parseQuestion(cur);
        if (!q || q.answeredBy?.pageId === l.pageId || q.notAnsweredBy.includes(l.pageId)) return null;
        return { answeredBy: { pageId: l.pageId, sim: l.sim, at } };
      })
      .catch(() => null);
    if (done) {
      n += 1;
      subjects.add(l.subjectId);
    }
  }
  for (const s of subjects) await recountSubject(ctx, s, { db: deps.db }).catch(() => null);
  return n;
}

/**
 * A person says an article doesn't answer a question it was matched to by meaning (Unlink): the
 * link goes, the page is never matched to it again, the subject is counted again, and it is kept on
 * the Learned list. False when the question has no link.
 */
export async function unlinkQuestion(ctx: TenantContext, questionId: string, deps: Pick<RepeatDeps, "db" | "now"> = {}): Promise<boolean> {
  let unlinked: { text: string; subjectId: string } | null = null;
  await brandMapRecords(ctx, deps.db)
    .claim("q", questionId, (cur) => {
      const q = parseQuestion(cur);
      if (!q?.answeredBy) return null;
      unlinked = { text: q.text, subjectId: q.subjectId };
      return { answeredBy: null, notAnsweredBy: [...q.notAnsweredBy.filter((p) => p !== q.answeredBy!.pageId), q.answeredBy.pageId].slice(-10) };
    })
    .catch(() => null);
  const done = unlinked as { text: string; subjectId: string } | null;
  if (!done) return false;
  await addLearned(ctx, { kind: "unlinked", text: done.text, questionId, from: "person" }, { db: deps.db, now: deps.now }).catch(() => null);
  await recountSubject(ctx, done.subjectId, { db: deps.db }).catch(() => null);
  return true;
}
