import { forTenant } from "@/lib/tenant";
import { brandMapRecords, MAX_IN } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { brandMapDocId } from "@/lib/types/brandMap";
import { BrandMapPageSchema, type BrandMapPage } from "@/lib/types/brandMapPage";
import { GroupTotalsSchema, type BrandMapQuestionRecord, type BrandMapSubjectRecord, type GroupTotals, type SubjectCounts } from "@/lib/types/brandMapRecords";
import { computeCoverage, meaningWords, type Coverage, type SubjectCoverage } from "@/lib/content/blog/coverage";
import { shareOf } from "./keys";
import { getSubject, parseSubject, subjectQuestions } from "./records";
import { parseBrandMap } from "./store";

/**
 * Coverage one subject at a time, at any size (BRAND_MAP_SCALE_ENABLED). Instead of reading
 * a brand's first 600 page rows, the rows that could answer one subject's questions are asked
 * for directly — on the subject, carrying one of its questions' ids or words, at its home
 * page, or sharing a meaningful word with one of its questions (close wording always shares
 * one) — and today's rules (computeCoverage) run on them.
 *
 * A subject's counts and its group's totals are kept for lists and the map, for display
 * only: worked out again when a page or question changes, when the subject is opened, and in
 * the recount pass after "Read what's already there". Storing them never moves a record's
 * revision, so it never makes a person's edit fail.
 */

type Deps = { db?: FirestoreLike; nowMs?: number };

const ROWS_PER_QUERY = 500;
const WORD_ROWS = 200;
const MAX_WORDS = 60;

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** The rows that could answer this subject's questions. */
export async function candidateRows(
  ctx: TenantContext,
  subject: Pick<BrandMapSubjectRecord, "id" | "urlKey">,
  questions: Array<Pick<BrandMapQuestionRecord, "id" | "text" | "textKey">>,
  deps: Deps = {},
): Promise<BrandMapPage[]> {
  const pages = forTenant(ctx, deps.db).brandMapPages;
  const ids = questions.map((q) => q.id);
  const keys = [...new Set(questions.map((q) => q.textKey).filter(Boolean))];
  const words = [...new Set(questions.flatMap((q) => meaningWords(q.text)))].slice(0, MAX_WORDS);
  const reads = [
    pages.find({ where: [["subjectId", "==", subject.id]], limit: ROWS_PER_QUERY }),
    ...chunks(ids, MAX_IN).map((c) => pages.find({ where: [["refs", "array-contains-any", c]], limit: ROWS_PER_QUERY })),
    ...chunks(keys, MAX_IN).map((c) => pages.find({ where: [["textKeys", "array-contains-any", c]], limit: ROWS_PER_QUERY })),
    ...(subject.urlKey ? [pages.find({ where: [["urlKey", "==", subject.urlKey]], limit: 50 })] : []),
    ...chunks(words, MAX_IN).map((c) => pages.find({ where: [["words", "array-contains-any", c]], limit: WORD_ROWS })),
  ];
  const found = new Map<string, BrandMapPage>();
  for (const batch of await Promise.all(reads.map((r) => r.catch(() => [])))) {
    for (const raw of batch) {
      if (found.has(raw.id)) continue;
      const parsed = BrandMapPageSchema.safeParse(raw);
      if (parsed.success) found.set(raw.id, parsed.data);
    }
  }
  return [...found.values()];
}

export interface SubjectCoverageRead {
  subject: BrandMapSubjectRecord;
  /** Every question on it: decided and proposed. Coverage is of the decided ones. */
  questions: BrandMapQuestionRecord[];
  coverage: SubjectCoverage;
  overlaps: Coverage["overlaps"];
  missingLinks: Coverage["missingLinks"];
  siblings: Coverage["siblings"];
  answered: Coverage["answered"];
  /** The rows it was worked out from. */
  rows: BrandMapPage[];
}

/** One subject's coverage, worked out now from its own rows (`exclude`: an article's own row never answers its own questions). */
export async function subjectCoverage(ctx: TenantContext, subjectId: string, deps: Deps = {}, opts: { exclude?: string } = {}): Promise<SubjectCoverageRead | null> {
  const subject = await getSubject(ctx, subjectId, deps);
  if (!subject) return null;
  const questions = await subjectQuestions(ctx, subject.id, deps);
  const decided = questions.filter((q) => q.status === "decided");
  const rows = (await candidateRows(ctx, subject, decided, deps)).filter((r) => r.id !== opts.exclude);
  const c = computeCoverage(
    { subjects: [{ id: subject.id, name: subject.name, home: subject.home, questions: decided.map((q) => ({ id: q.id, text: q.text, intent: q.intent })) }] },
    rows,
  );
  return { subject, questions, coverage: c.subjects[0]!, overlaps: c.overlaps, missingLinks: c.missingLinks, siblings: c.siblings, answered: c.answered, rows };
}

/**
 * The rows a subject's own view of the content map draws: written for it, answering one of
 * its questions for sure, or at its home page. A row that only shares a word stays off.
 */
export function subjectViewRows(read: Pick<SubjectCoverageRead, "subject" | "coverage" | "rows">): BrandMapPage[] {
  const answering = new Set(read.coverage.questions.flatMap((q) => q.pages.map((p) => p.id)));
  return read.rows.filter((r) => r.subjectId === read.subject.id || answering.has(r.id) || Boolean(read.subject.urlKey && r.urlKey === read.subject.urlKey));
}

/** A subject's counts, from its coverage. */
export function countsOf(coverage: SubjectCoverage): { counts: SubjectCounts; answeredIds: string[]; draftedIds: string[]; plannedIds: string[] } {
  const by = (state: string) => coverage.questions.filter((q) => q.state === state).map((q) => q.id);
  const answeredIds = by("answered");
  const draftedIds = by("drafted");
  const plannedIds = by("planned");
  return {
    counts: {
      questions: coverage.questions.length,
      answered: answeredIds.length,
      drafted: draftedIds.length,
      planned: plannedIds.length,
      open: by("open").length,
    },
    answeredIds,
    draftedIds,
    plannedIds,
  };
}

const sameCounts = (a: unknown, b: SubjectCounts) => JSON.stringify(a) === JSON.stringify(b);

/** Work a subject's counts out again; store them, and its group's totals, when they changed. */
export async function recountSubject(ctx: TenantContext, subjectId: string, deps: Deps = {}): Promise<SubjectCoverageRead | null> {
  const read = await subjectCoverage(ctx, subjectId, deps);
  if (!read) return null;
  const { counts, answeredIds, draftedIds, plannedIds } = countsOf(read.coverage);
  const share = shareOf(counts.answered, counts.questions);
  if (!sameCounts(read.subject.counts, counts) || read.subject.answeredShare !== share) {
    await brandMapRecords(ctx, deps.db).claim("sub", read.subject.id, () => ({ counts, answeredShare: share, answeredIds, draftedIds, plannedIds }));
    await recountGroup(ctx, read.subject.groupId, deps);
  }
  return read;
}

/** Totals of a list of subjects (decided ones only). */
export function totalsOf(subjects: BrandMapSubjectRecord[]): GroupTotals {
  const t = GroupTotalsSchema.parse({});
  for (const s of subjects) {
    if (s.status !== "decided" || s.mergedInto) continue;
    t.subjects += 1;
    t.questions += s.counts.questions;
    t.answered += s.counts.answered;
    t.drafted += s.counts.drafted;
    t.planned += s.counts.planned;
    if (s.counts.answered > 0) t.subjectsAnswered += 1;
    else if (s.counts.drafted > 0) t.subjectsDrafted += 1;
    else t.subjectsOpen += 1;
  }
  return t;
}

/** Add a group's totals up again from its subjects (null: the ungrouped ones, kept on the brand's record). */
export async function recountGroup(ctx: TenantContext, groupId: string | null, deps: Deps = {}): Promise<GroupTotals> {
  const store = brandMapRecords(ctx, deps.db);
  const rows = await store.pageAll("sub", { where: [["groupId", "==", groupId]], fields: ["status", "counts", "mergedInto", "name", "nameKey", "groupId"] });
  const totals = totalsOf(rows.flatMap((r) => parseSubject(r) ?? []));
  if (groupId) {
    await store.claim("grp", groupId, (cur) => (JSON.stringify(cur.totals) === JSON.stringify(totals) ? null : { totals }));
  } else {
    await forTenant(ctx, deps.db)
      .brandMaps.claim(brandMapDocId(ctx.tenantId), (cur) => (parseBrandMap(cur) && JSON.stringify(cur.ungroupedTotals) !== JSON.stringify(totals) ? ({ ungroupedTotals: totals } as never) : null))
      .catch(() => null);
  }
  return totals;
}

/** The subjects a page row points at: by its subject, its questions' ids and words, and its address. */
export async function subjectsOfRows(ctx: TenantContext, rows: Array<Partial<BrandMapPage> | null | undefined>, deps: Deps = {}): Promise<string[]> {
  const store = brandMapRecords(ctx, deps.db);
  const real = rows.filter((r): r is Partial<BrandMapPage> => Boolean(r));
  const subjects = new Set(real.flatMap((r) => (r.subjectId ? [r.subjectId] : [])));
  const refs = [...new Set(real.flatMap((r) => r.refs ?? []))];
  const keys = [...new Set(real.flatMap((r) => r.textKeys ?? []))];
  const urls = [...new Set(real.flatMap((r) => (r.urlKey ? [r.urlKey] : [])))];
  const [byRef, byKey, byHome] = await Promise.all([
    refs.length ? store.getMany("q", refs) : [],
    keys.length ? store.findIn("q", "textKey", keys) : [],
    urls.length ? store.findIn("sub", "urlKey", urls) : [],
  ]);
  for (const q of [...byRef, ...byKey]) if (typeof q.subjectId === "string") subjects.add(q.subjectId);
  for (const s of byHome) subjects.add(s.id);
  return [...subjects];
}

/** Recount every subject a changed row pointed at, before and after (bounded, a few at a time). */
export async function recountForRows(ctx: TenantContext, rows: Array<Partial<BrandMapPage> | null | undefined>, deps: Deps = {}): Promise<number> {
  const subjects = await subjectsOfRows(ctx, rows, deps);
  for (let i = 0; i < subjects.length; i += 5) await Promise.all(subjects.slice(i, i + 5).map((id) => recountSubject(ctx, id, deps).catch(() => null)));
  return subjects.length;
}
