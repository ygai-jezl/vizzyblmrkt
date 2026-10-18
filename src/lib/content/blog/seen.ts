import { renderPrompt } from "@/lib/agents/prompts/registry";
import { generateTextWithDeadline } from "@/lib/agents/gemini";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { BlogSeenSchema, SEEN_ADDED_BY_YOU, type BlogBrief, type BlogSeen, type BlogSeenNote, type ContentPlan } from "@/lib/types/contentPlan";
import { BRAND_NOTE_LIMITS, type BrandNote } from "@/lib/types/brandNote";
import { createNote, markNotesUsed, nearestNotes, notesForSubjects, updateNote, type NotesDeps } from "@/lib/brandNotes/store";
import { suggestKind } from "@/lib/brandNotes/prompts";

/**
 * What the brand has seen, for one blog article (BRAND_NOTES_ENABLED with the editorial writer).
 * A note goes into the article only on a STRONG match: it is linked to the article's brand map
 * subject, or it is close in meaning to the article's question AND a model check says it bears on
 * that question. Weaker ones are kept aside for a person to add. With no strong match, the
 * article gets three questions its team could answer instead. A note a person took out never
 * comes back, and one a person added stays.
 */

/** At most this many notes go into an article by themselves. */
export const STRONG_NOTES = 3;
const NEAR_NOTES = 5;
const MAX_NOTES = 6;
const CANDIDATES = 12;
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

const asSeen = (n: BrandNote, why: string): BlogSeenNote => ({ id: n.id, text: n.text.slice(0, BRAND_NOTE_LIMITS.MAX_TEXT), why, canName: n.canName });
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

export function parseAsks(raw: string): string[] {
  const out: string[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]\s*)?\**ASK\**\s*:\**\s*(.+)$/i.exec(line);
    const q = m?.[1]?.trim().replace(/^["“]|["”]$/g, "");
    if (q && q.length >= 12 && !out.includes(q)) out.push(q.slice(0, 300));
    if (out.length === 3) break;
  }
  return out;
}

export async function matchSeen(
  ctx: TenantContext,
  args: { plan: Pick<ContentPlan, "name" | "scope">; brief: BlogBrief; brandName: string; audience?: string | null },
  deps: SeenDeps = {},
): Promise<BlogSeen> {
  const now = (deps.now ?? (() => new Date()))();
  const current = BlogSeenSchema.parse(args.brief.seen ?? {});
  const question = seenQuestion(args.plan, args.brief);
  const removed = new Set(current.removed);
  const manual = current.notes.filter((n) => n.why === ADDED_BY_YOU && !removed.has(n.id));
  const skip = (id: string) => removed.has(id) || manual.some((n) => n.id === id);
  const generate = deps.generate ?? generateTextWithDeadline;
  const brand = args.brandName.replace(/["\n]/g, " ").slice(0, 120);
  const spark = oneLine(args.plan.scope.spark).slice(0, 600) || "(none)";

  const [linked, near] = await Promise.all([
    args.brief.subjectId ? notesForSubjects(ctx, [args.brief.subjectId], deps).catch(() => []) : Promise.resolve([] as BrandNote[]),
    nearestNotes(ctx, [question, args.plan.scope.spark].filter(Boolean).join("\n"), { limit: CANDIDATES, minSim: CANDIDATE_MIN_SIM }, deps).catch(() => []),
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

  const strong = [
    ...linkedOk.map((n) => asSeen(n, WHY_LINKED)),
    ...toCheck.filter((_, i) => verdicts[i] === "STRONG").map((n) => asSeen(n, WHY_CLOSE)),
  ].slice(0, Math.max(0, Math.min(STRONG_NOTES, MAX_NOTES - manual.length)));
  const strongIds = new Set(strong.map((n) => n.id));
  const weaker = [...linkedOk, ...toCheck.filter((_, i) => verdicts[i] !== "NO")]
    .filter((n) => !strongIds.has(n.id))
    .slice(0, NEAR_NOTES)
    .map((n) => asSeen(n, WHY_NEAR));
  const notes = [...manual, ...strong];

  let asks: string[] = [];
  if (!notes.length) {
    const raw = await generate(
      renderPrompt("content.blog_note_asks", {
        brand_name: brand,
        question,
        spark,
        audience: oneLine(args.audience ?? "").slice(0, 300) || "(not given)",
      }),
      { timeoutMs: 20_000, temperature: 0.4, thinkingBudget: 256 },
    ).catch(() => null);
    asks = raw ? parseAsks(raw) : [];
  }

  return BlogSeenSchema.parse({ ...current, notes, near: weaker, asks, matchedFor: question, matchedAt: now.toISOString() });
}

/**
 * Once an article is written and checked: the notes it was written with record that they were
 * used, and what a person wrote for it is kept as one of the brand's notes (when they left
 * "Also save" ticked). One note per article: a later check updates it. A question from the
 * list that a person dropped into the box is not part of their note.
 */
export async function keepArticleSeen(
  ctx: TenantContext,
  args: { article: string; brief: BlogBrief; used: boolean },
  deps: NotesDeps = {},
): Promise<void> {
  const seen = args.brief.seen;
  if (!seen) return;
  if (args.used && seen.notes.length) await markNotesUsed(ctx, seen.notes.map((n) => n.id), args.article, deps);
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
