import { renderPrompt } from "@/lib/agents/prompts/registry";
import { generateTextWithDeadline } from "@/lib/agents/gemini";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { embedDocuments, embedQuery } from "@/lib/agents/embeddings";
import {
  BlogSeenSchema,
  SEEN_ADDED_BY_YOU,
  type BlogBrief,
  type BlogSeen,
  type BlogSeenNote,
  type BlogSeenQuestion,
  type BlogSeenResting,
  type ContentPlan,
} from "@/lib/types/contentPlan";
import { BRAND_NOTE_LIMITS, type BrandNote, type NoteArticle, type NotesRest } from "@/lib/types/brandNote";
import {
  addAskedFor,
  alreadyOnFile,
  askQuestions,
  createNote,
  holdNotes,
  markNotesUsed,
  nearestNotes,
  nearestOpenQuestions,
  notesById,
  notesForSubjects,
  QUESTION_TITLE,
  releaseHolds,
  updateNote,
  type NotesDeps,
} from "@/lib/brandNotes/store";
import { suggestKind } from "@/lib/brandNotes/prompts";
import { isBrandNotesQuestionsEnabled, isBrandNotesRestEnabled } from "@/lib/brandNotes/flags";
import { noteRest, type NoteRestState } from "@/lib/brandNotes/rest";
import { answeredQuestions } from "./citable";

/**
 * What the brand has seen, for one blog article (BRAND_NOTES_ENABLED with the editorial writer).
 * A note goes into the article only on a STRONG match: it is linked to the article's brand map
 * subject, or it is close in meaning to the article's question AND a model check says it bears on
 * that question. Weaker ones are kept aside for a person to add. With no strong match, the
 * article gets three questions its team could answer instead. A note a person took out never
 * comes back, and one a person added stays.
 *
 * With BRAND_NOTES_QUESTIONS_ENABLED those questions are kept on What we've seen as open
 * questions linked to the article, and an open question another article asked is reused when it
 * fits. The article's own questions stay until its question changes, and their answers are never
 * matched back in as notes of their own.
 *
 * With BRAND_NOTES_REST_ENABLED a note rests after an article uses it (src/lib/brandNotes/rest.ts):
 * one that fits but rests is shown apart for a person to add, never put in by the match. The
 * article's draft holds the notes it took, so another draft researched meanwhile leaves them alone.
 */

/** At most this many notes go into an article by themselves. */
export const STRONG_NOTES = 3;
const NEAR_NOTES = 5;
const MAX_NOTES = 6;
const CANDIDATES = 12;
/** With notes resting, more are looked at, so resting ones don't crowd fresh ones out. */
const REST_CANDIDATES = 20;
const RESTING_NOTES = 5;
/**
 * How close in meaning (cosine, question against stored note) a note must be to be put to the
 * model check at all; the check, not this number, decides what is strong. Measured on 40
 * made-up notes and four questions with the live models (2026-10-18): related notes scored
 * 0.46 to 0.73, unrelated ones up to 0.60, so no cutoff separates them. At 0.55 one to four
 * related notes per question never reached the check; the check called 13 notes strong and
 * none of them wrongly. So the cutoff stays low and the check stays strict.
 */
export const CANDIDATE_MIN_SIM = 0.5;

export const ADDED_BY_YOU = SEEN_ADDED_BY_YOU;
const WHY_LINKED = "Linked to this article's subject";
const WHY_CLOSE = "Close in meaning, and it bears on this question";
const WHY_NEAR = "About the same subject";

export interface SeenDeps extends NotesDeps {
  generate?: typeof generateTextWithDeadline;
}

/** The question an article's notes are matched to. */
export function seenQuestion(plan: Pick<ContentPlan, "name" | "scope">, brief: BlogBrief): string {
  return (brief.primaryQuestion.trim() || plan.scope.spark.trim() || plan.name).replace(/\s+/g, " ").slice(0, 300);
}

const asSeen = (n: BrandNote, why: string, r?: NoteRestState | null): BlogSeenNote => ({
  id: n.id,
  text: n.text.slice(0, BRAND_NOTE_LIMITS.MAX_TEXT),
  why,
  canName: n.canName,
  ...(r ? { usedIn: Math.min(r.written, BRAND_NOTE_LIMITS.MAX_USED_BY), lastUsedAt: r.last?.at ?? null } : {}),
});
const asResting = (n: BrandNote, r: NoteRestState): BlogSeenResting => ({
  ...asSeen(n, "", r),
  reason: r.reason ?? "held",
  until: r.until,
  byTitle: r.by?.title.slice(0, 200) ?? null,
  byAt: r.by?.at ?? null,
});
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export type Verdict = "STRONG" | "WEAK" | "NO";

/** The model check's verdicts, one per note in order; a note it said nothing about is NO. */
export function parseVerdicts(raw: string, count: number): Verdict[] {
  const out: Verdict[] = Array.from({ length: count }, () => "NO");
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const m = /^\s*\**\[?(\d+)\]?\**\s*[:.)]\s*\**(STRONG|WEAK|NO)\b/i.exec(line);
    if (!m) continue;
    const i = Number(m[1]) - 1;
    if (i >= 0 && i < count) out[i] = m[2]!.toUpperCase() as Verdict;
  }
  return out;
}

/** The open questions the reuse prompt picked (`REUSE: n`), as 0-based indexes, each once. */
export function parseReuse(raw: string, count: number): number[] {
  const out: number[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]\s*)?\**REUSE\**\s*:\**\s*\[?(\d+)\]?/i.exec(line);
    const i = m ? Number(m[1]) - 1 : -1;
    if (i >= 0 && i < count && !out.includes(i)) out.push(i);
    if (out.length === 3) break;
  }
  return out;
}

export function parseAsks(raw: string, max = 3): string[] {
  const out: string[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]\s*)?\**ASK\**\s*:\**\s*(.+)$/i.exec(line);
    const q = m?.[1]?.trim().replace(/^["“]|["”]$/g, "");
    if (q && q.length >= 12 && !out.includes(q)) out.push(q.slice(0, 300));
    if (out.length === max) break;
  }
  return out;
}

export async function matchSeen(
  ctx: TenantContext,
  args: {
    plan: Pick<ContentPlan, "name" | "scope">;
    brief: BlogBrief;
    brandName: string;
    audience?: string | null;
    /** The article (`<workspaceId>/<planId>` and its name): with it, its questions are kept as open questions. */
    article?: NoteArticle;
    /** The brand's rest setting: with it and the article (BRAND_NOTES_REST_ENABLED), notes rest after use. */
    rest?: NotesRest | null;
  },
  deps: SeenDeps = {},
): Promise<BlogSeen> {
  const now = (deps.now ?? (() => new Date()))();
  const { resting: _resting, ...current } = BlogSeenSchema.parse(args.brief.seen ?? {});
  const question = seenQuestion(args.plan, args.brief);
  const article = isBrandNotesQuestionsEnabled() ? args.article : undefined;
  const rest = article && args.rest && isBrandNotesRestEnabled() ? args.rest : null;
  const prior = article ? (current.questions ?? []) : [];
  const priorIds = new Set(prior.map((q) => q.id));
  const removed = new Set(current.removed);
  const manual = current.notes.filter((n) => n.why === ADDED_BY_YOU && !removed.has(n.id));
  const skip = (id: string) => removed.has(id) || priorIds.has(id) || manual.some((n) => n.id === id);
  const generate = deps.generate ?? generateTextWithDeadline;
  const brand = args.brandName.replace(/["\n]/g, " ").slice(0, 120);
  const spark = oneLine(args.plan.scope.spark).slice(0, 600) || "(none)";
  const about = [question, args.plan.scope.spark].filter(Boolean).join("\n");
  // With open questions, one query vector serves both searches.
  const vector = article ? await (deps.query ?? embedQuery)(about.slice(0, 2000), ctx.region).catch(() => null) : undefined;

  const [linked, near] = await Promise.all([
    args.brief.subjectId ? notesForSubjects(ctx, [args.brief.subjectId], deps).catch(() => []) : Promise.resolve([] as BrandNote[]),
    nearestNotes(ctx, about, { limit: rest ? REST_CANDIDATES : CANDIDATES, minSim: CANDIDATE_MIN_SIM, ...(vector !== undefined ? { vector } : {}) }, deps).catch(
      () => [],
    ),
  ]);
  const sim = new Map(near.map((n) => [n.note.id, n.sim]));
  const linkedOk = linked.filter((n) => !skip(n.id)).sort((a, b) => (sim.get(b.id) ?? 0) - (sim.get(a.id) ?? 0));
  const linkedIds = new Set(linkedOk.map((n) => n.id));
  const toCheck = near.map((n) => n.note).filter((n) => !skip(n.id) && !linkedIds.has(n.id));

  // Without the check's say, nothing close in meaning goes in by itself: it waits as a weaker match.
  let verdicts: Verdict[] = toCheck.map(() => "WEAK");
  if (toCheck.length) {
    const raw = await generate(
      renderPrompt("content.blog_note_match", {
        brand_name: brand,
        question,
        spark,
        notes: toCheck.map((n, i) => `[${i + 1}] ${oneLine(n.text).replace(/<\/?\s*notes\s*>/gi, " ")}`).join("\n"),
      }),
      { timeoutMs: 25_000, temperature: 0, thinkingBudget: 512 },
    ).catch(() => null);
    if (raw) verdicts = parseVerdicts(raw, toCheck.length);
  }

  // With notes resting, one that fits but rests is set apart; the rest go in as before.
  const restOf = new Map(rest ? [...linkedOk, ...toCheck].map((n) => [n.id, noteRest(n, rest, now, article!.ref)]) : []);
  const resting = (n: BrandNote) => Boolean(restOf.get(n.id)?.reason);
  const fits = [
    ...linkedOk.map((n) => ({ n, why: WHY_LINKED })),
    ...toCheck.filter((_, i) => verdicts[i] === "STRONG").map((n) => ({ n, why: WHY_CLOSE })),
  ];
  let picked = fits.filter((f) => !resting(f.n)).slice(0, Math.max(0, Math.min(STRONG_NOTES, MAX_NOTES - manual.length)));
  const restingFits = fits.filter((f) => resting(f.n)).map((f) => asResting(f.n, restOf.get(f.n.id)!));
  if (rest && picked.length) {
    // The draft holds what it took; one another draft took a moment ago rests instead.
    const ids = picked.map((f) => f.n.id);
    const held = new Set(await holdNotes(ctx, ids, article!, { rest }, deps).catch(() => ids));
    const lost = picked.filter((f) => !held.has(f.n.id)).map((f) => f.n.id);
    if (lost.length) {
      for (const n of await notesById(ctx, lost, deps).catch(() => [])) restingFits.push(asResting(n, noteRest(n, rest, now, article!.ref)));
      picked = picked.filter((f) => held.has(f.n.id));
    }
  }
  const strong = picked.map((f) => asSeen(f.n, f.why, restOf.get(f.n.id)));
  const strongIds = new Set(strong.map((n) => n.id));
  const restingIds = new Set(restingFits.map((n) => n.id));
  const weaker = [...linkedOk, ...toCheck.filter((_, i) => verdicts[i] !== "NO")]
    .filter((n) => !strongIds.has(n.id) && !restingIds.has(n.id) && !resting(n))
    .slice(0, NEAR_NOTES)
    .map((n) => asSeen(n, WHY_NEAR, restOf.get(n.id)));
  const notes = [...manual, ...strong];

  const audience = oneLine(args.audience ?? "").slice(0, 300) || "(not given)";
  let asks: string[] = [];
  let questions = current.questions;
  if (article) {
    const same = current.matchedFor === question;
    // A brief from before open questions has asks and no questions: those asks are kept as they are.
    const oldAsks = current.questions === undefined && same ? current.asks : [];
    // What the brand already has on this question, so new questions ask for something else.
    const have = [...notes, ...restingFits, ...weaker].map((n) => n.text);
    const r = await articleQuestions(
      ctx,
      { article, prior, matched: notes.length > 0, same, oldAsks, vector: vector ?? null, brand, question, spark, audience, rest, have },
      deps,
    );
    questions = r.questions;
    // The asks follow, so the article reads the same with the switch turned off again.
    asks = notes.length ? [] : [...questions.map((q) => q.question), ...r.unsaved].slice(0, 3);
  } else if (!notes.length) {
    const raw = await generate(
      renderPrompt("content.blog_note_asks", { brand_name: brand, question, spark, audience }),
      { timeoutMs: 20_000, temperature: 0.4, thinkingBudget: 256 },
    ).catch(() => null);
    asks = raw ? parseAsks(raw) : [];
  }

  if (rest) {
    // What the article chose itself stays held; what it no longer has is let go.
    const chosen = [...manual.map((n) => n.id), ...(questions ?? []).filter(isAnswered).map((q) => q.id)];
    const keep = new Set([...notes.map((n) => n.id), ...chosen]);
    const drop = [...current.notes.map((n) => n.id), ...current.removed].filter((id) => !keep.has(id));
    await Promise.all([
      chosen.length ? holdNotes(ctx, chosen, article!, { force: true }, deps).catch(() => []) : null,
      drop.length ? releaseHolds(ctx, drop, article!.ref, deps).catch(() => undefined) : null,
    ]);
  }

  return BlogSeenSchema.parse({
    ...current,
    notes,
    near: weaker,
    ...(rest ? { resting: restingFits.slice(0, RESTING_NOTES) } : {}),
    asks,
    ...(questions !== undefined ? { questions } : {}),
    matchedFor: question,
    matchedAt: now.toISOString(),
  });
}

const isAnswered = (q: BlogSeenQuestion) => q.answer.trim().length >= BRAND_NOTE_LIMITS.MIN_TEXT;
/** A question's note as an article holds it: `article` is that article, left out of the others that asked it. */
function asQuestion(n: BrandNote, article?: string): BlogSeenQuestion {
  const also = (n.askedFor ?? []).filter((a) => a.ref !== article).map((a) => a.title.slice(0, 200)).slice(-3);
  return {
    id: n.id,
    question: (n.question ?? "").slice(0, BRAND_NOTE_LIMITS.MAX_QUESTION),
    answer: n.text.slice(0, BRAND_NOTE_LIMITS.MAX_TEXT),
    ...(also.length ? { also } : {}),
  };
}
/** How close in meaning an open question must be to be offered for reuse; the model decides. */
const OPEN_MIN_SIM = CANDIDATE_MIN_SIM;
const OPEN_CANDIDATES = 5;
/** Questions asked for beyond the ones needed, so one that repeats what the brand has can be dropped. */
const SPARE_QUESTIONS = 2;
/** What the fresh questions prompt is shown of what the brand already has. */
const HAVE_LINES = 12;
const ASKED_ALREADY = 6;
/**
 * How close in meaning (cosine, both embedded as documents) a new question may come to one
 * already asked or answered, or to a kept note, before it counts as asking for the same thing.
 * A backstop: the prompt is shown what is close already, and this catches what slips through.
 * Measured with scripts/measure-question-dupes.ts on text-embedding-005 (2026-10-29), re-run it
 * before changing either:
 *   - question to question: the same ask reworded scored 0.848 to 0.981 (seven of eight at 0.939
 *     or more), a different ask on the same subject 0.720 to 0.915. At 0.93 seven of eight repeats
 *     are dropped and no different question is.
 *   - question to note: a note that answers it scored 0.726 to 0.873, one on the same subject
 *     that doesn't 0.643 to 0.773. No cutoff separates them, so 0.85 drops only the closest and
 *     never a question a note leaves open.
 */
export const DUP_QUESTION_SIM = 0.93;
export const DUP_NOTE_SIM = 0.85;

/**
 * An article's questions for its team, kept as open questions (BRAND_NOTES_QUESTIONS_ENABLED).
 * Answered ones always stay. With notes matched, nothing more is asked. On the same question
 * the questions already kept stay as they are (Look again asks nothing new), and a brief from
 * before has its questions kept without a model call. Otherwise open questions close in meaning
 * are offered to the model to reuse, and the rest are new. `unsaved`: new questions the brand had
 * no room to keep (near its backstop), shown the old way.
 *
 * With notes resting (`rest`), every article asks, whatever matched: the model is shown what the
 * brand already has and has been asked on the question, and a question that repeats any of it by
 * meaning is dropped. An open question already asked for as many articles as a note may go into
 * is not offered again.
 */
async function articleQuestions(
  ctx: TenantContext,
  a: {
    article: NoteArticle;
    prior: BlogSeenQuestion[];
    matched: boolean;
    same: boolean;
    oldAsks: string[];
    vector: number[] | null;
    brand: string;
    question: string;
    spark: string;
    audience: string;
    rest?: NotesRest | null;
    have?: string[];
  },
  deps: SeenDeps,
): Promise<{ questions: BlogSeenQuestion[]; unsaved: string[] }> {
  const answered = a.prior.filter(isAnswered);
  if (a.matched && !a.rest) return { questions: answered, unsaved: [] };
  if (a.same && a.prior.length) return { questions: a.prior, unsaved: [] };
  const room = 3 - answered.length;
  if (room <= 0) return { questions: answered.slice(0, 3), unsaved: [] };
  if (a.oldAsks.length) {
    const asked = a.oldAsks.slice(0, room);
    const kept = await askQuestions(ctx, { questions: asked, article: a.article }, deps).catch(() => []);
    return { questions: [...answered, ...kept.map((n) => asQuestion(n, a.article.ref))], unsaved: kept.length ? [] : asked };
  }

  const keep = new Set(answered.map((q) => q.id));
  const open = (
    a.vector ? await nearestOpenQuestions(ctx, a.vector, { limit: OPEN_CANDIDATES, minSim: OPEN_MIN_SIM, exclude: keep }, deps).catch(() => []) : []
  ).filter((o) => !a.rest || (o.note.askedFor?.length ?? 0) < a.rest.maxUses);
  if (a.rest) return freshQuestions(ctx, { ...a, answered, room, open }, deps);
  const vars = { brand_name: a.brand, question: a.question, spark: a.spark, audience: a.audience };
  const raw = await (deps.generate ?? generateTextWithDeadline)(
    open.length
      ? renderPrompt("content.blog_note_asks_reuse", {
          ...vars,
          open: open.map((o, i) => `[${i + 1}] ${oneLine(o.note.question ?? "").replace(/<\/?\s*open\s*>/gi, " ")}`).join("\n"),
        })
      : renderPrompt("content.blog_note_asks", vars),
    { timeoutMs: 20_000, temperature: 0.4, thinkingBudget: 256 },
  ).catch(() => null);
  if (!raw) return { questions: answered, unsaved: [] };

  const reused = (open.length ? parseReuse(raw, open.length) : []).slice(0, room).map((i) => open[i]!.note);
  const taken = new Set([...answered.map((q) => q.question), ...reused.map((n) => n.question ?? "")].map((q) => oneLine(q).toLowerCase()));
  const fresh = parseAsks(raw)
    .filter((q) => !taken.has(oneLine(q).toLowerCase()))
    .slice(0, room - reused.length);
  const [linked, made] = await Promise.all([
    Promise.all(reused.map((n) => addAskedFor(ctx, n.id, a.article, deps).catch(() => n))),
    fresh.length ? askQuestions(ctx, { questions: fresh, article: a.article }, deps).catch(() => []) : Promise.resolve([] as BrandNote[]),
  ]);
  return {
    questions: [...answered, ...linked.map((n, i) => asQuestion(n ?? reused[i]!, a.article.ref)), ...made.map((n) => asQuestion(n, a.article.ref))],
    unsaved: made.length ? [] : fresh,
  };
}

/** Every article's questions with notes resting: something the brand doesn't have yet, never asked before. */
async function freshQuestions(
  ctx: TenantContext,
  a: Parameters<typeof articleQuestions>[1] & { answered: BlogSeenQuestion[]; room: number; open: Array<{ note: BrandNote; sim: number }> },
  deps: SeenDeps,
): Promise<{ questions: BlogSeenQuestion[]; unsaved: string[] }> {
  const count = a.room + SPARE_QUESTIONS;
  const openIds = new Set(a.open.map((o) => o.note.id));
  const asked = a.vector
    ? await nearestOpenQuestions(
        ctx,
        a.vector,
        { limit: ASKED_ALREADY, minSim: OPEN_MIN_SIM, exclude: [...a.answered.map((q) => q.id), ...openIds], statuses: ["asked", "answered"] },
        deps,
      ).catch(() => [])
    : [];
  const strip = (t: string, tag: string) => oneLine(t).replace(new RegExp(`</?\\s*${tag}\\s*>`, "gi"), " ").slice(0, 300);
  const have = [
    ...(a.have ?? []).map((t) => `- ${strip(t, "have")}`),
    ...a.answered.map((q) => `- Asked already: ${strip(q.question, "have")}`),
    ...asked.map((o) => `- Asked already: ${strip(o.note.question ?? "", "have")}`),
  ].slice(0, HAVE_LINES);
  const raw = await (deps.generate ?? generateTextWithDeadline)(
    renderPrompt("content.blog_note_asks_fresh", {
      brand_name: a.brand,
      question: a.question,
      spark: a.spark,
      audience: a.audience,
      count,
      have: have.join("\n") || "(nothing yet)",
      open: a.open.map((o, i) => `[${i + 1}] ${strip(o.note.question ?? "", "open")}`).join("\n") || "(none)",
    }),
    { timeoutMs: 20_000, temperature: 0.4, thinkingBudget: 256 },
  ).catch(() => null);
  if (!raw) return { questions: a.answered, unsaved: [] };

  const reused = (a.open.length ? parseReuse(raw, a.open.length) : []).slice(0, a.room).map((i) => a.open[i]!.note);
  const norm = (q: string) => oneLine(q).toLowerCase();
  const taken = new Set([...a.answered.map((q) => q.question), ...reused.map((n) => n.question ?? ""), ...asked.map((o) => o.note.question ?? "")].map(norm));
  const candidates = parseAsks(raw, count).filter((q) => !taken.has(norm(q)));
  const unique = await uniqueQuestions(ctx, candidates, a.room - reused.length, deps);
  const [linked, made] = await Promise.all([
    Promise.all(reused.map((n) => addAskedFor(ctx, n.id, a.article, deps).catch(() => n))),
    unique.questions.length ? askQuestions(ctx, { questions: unique.questions, article: a.article, vectors: unique.vectors }, deps).catch(() => []) : Promise.resolve([] as BrandNote[]),
  ]);
  return {
    questions: [...a.answered, ...linked.map((n, i) => asQuestion(n ?? reused[i]!, a.article.ref)), ...made.map((n) => asQuestion(n, a.article.ref))],
    unsaved: made.length ? [] : unique.questions,
  };
}

const cosine = (x: number[], y: number[]) => {
  let dot = 0;
  let nx = 0;
  let ny = 0;
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    dot += x[i]! * y[i]!;
    nx += x[i]! * x[i]!;
    ny += y[i]! * y[i]!;
  }
  return nx && ny ? dot / Math.sqrt(nx * ny) : 0;
};

/**
 * The first `want` questions that repeat, by meaning, nothing on What we've seen and none of the
 * others, with their vectors (made once, kept with the questions). Embeddings down: the first
 * `want` as they are, so an article still asks.
 */
export async function uniqueQuestions(
  ctx: TenantContext,
  candidates: string[],
  want: number,
  deps: NotesDeps = {},
): Promise<{ questions: string[]; vectors: number[][] | null }> {
  if (want <= 0 || !candidates.length) return { questions: [], vectors: null };
  const made = await (deps.embed ?? embedDocuments)(candidates.map((content) => ({ content, title: QUESTION_TITLE })), ctx.region).catch(() => null);
  if (!made || made.length !== candidates.length || made.some((v) => !v?.length)) return { questions: candidates.slice(0, want), vectors: null };
  const vectors = made as number[][];
  const onFile = await Promise.all(vectors.map((v) => alreadyOnFile(ctx, v, { questionSim: DUP_QUESTION_SIM, noteSim: DUP_NOTE_SIM }, deps)));
  const questions: string[] = [];
  const kept: number[][] = [];
  candidates.forEach((q, i) => {
    const v = vectors[i]!;
    if (questions.length === want || onFile[i] || kept.some((k) => cosine(k, v) >= DUP_QUESTION_SIM)) return;
    questions.push(q);
    kept.push(v);
  });
  return { questions, vectors: kept };
}

/**
 * Once an article is written and checked: the notes it was written with record that they were
 * used, and what a person wrote for it is kept as one of the brand's notes (when they left
 * "Also save" ticked). One note per article: a later check updates it. A question from the
 * list that a person dropped into the box is not part of their note.
 */
export async function keepArticleSeen(
  ctx: TenantContext,
  args: { article: string; brief: BlogBrief; used: boolean; /** With notes resting (BRAND_NOTES_REST_ENABLED): each use is dated, under this title. */ title?: string },
  deps: NotesDeps = {},
): Promise<void> {
  const seen = args.brief.seen;
  if (!seen) return;
  const used = [...seen.notes.map((n) => n.id), ...answeredQuestions(args.brief).map((q) => q.id)];
  const dated = args.title !== undefined && isBrandNotesRestEnabled() ? { title: args.title } : undefined;
  if (args.used && used.length) await markNotesUsed(ctx, used, args.article, deps, dated);
  const asks = new Set(seen.asks.map(oneLine));
  const text = seen.own
    .split(/\r?\n/)
    .filter((line) => !asks.has(oneLine(line)))
    .join("\n")
    .trim()
    .slice(0, BRAND_NOTE_LIMITS.MAX_TEXT);
  if (!seen.save || text.length < BRAND_NOTE_LIMITS.MIN_TEXT) return;
  const mine = (await forTenant(ctx, deps.db).brandNotes.find({ where: [["sourceRef", "==", args.article]], limit: 5 })).find((n) => n.source === "article");
  if (mine) {
    if (mine.text !== text) await updateNote(ctx, mine.id, { text }, deps);
    return;
  }
  await createNote(
    ctx,
    { text, kind: suggestKind(text), subjectIds: args.brief.subjectId ? [args.brief.subjectId] : [], canName: false },
    { source: "article", sourceRef: args.article },
    deps,
  );
}

/**
 * The live answers to an article's questions (BRAND_NOTES_QUESTIONS_ENABLED), copied onto its
 * brief: an answer changed on Brand › What we've seen wins, and a question removed there is
 * gone. `article` (`<workspaceId>/<planId>`) names the other articles that asked each one. Off,
 * nothing asked, or the notes can't be read: the brief as it is.
 */
export async function refreshAnswers(ctx: TenantContext, brief: BlogBrief, deps: NotesDeps = {}, article?: string): Promise<BlogBrief> {
  const seen = brief.seen;
  const questions = seen?.questions;
  if (!isBrandNotesQuestionsEnabled() || !seen || !questions?.length) return brief;
  const found = await notesById(ctx, questions.map((q) => q.id), deps).catch(() => null);
  if (!found) return brief;
  const live = new Map(found.filter((n) => n.source === "question").map((n) => [n.id, n]));
  const next = questions.flatMap((q) => {
    const n = live.get(q.id);
    return n ? [{ ...asQuestion(n, article), question: (n.question || q.question).slice(0, BRAND_NOTE_LIMITS.MAX_QUESTION) }] : [];
  });
  return { ...brief, seen: { ...seen, questions: next } };
}
