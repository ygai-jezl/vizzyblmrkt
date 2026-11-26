import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { listBrandMapPages } from "@/lib/brandMap/pages";
import { parseQuestion, parseSubject } from "@/lib/brandMap/records";
import { readBrandMap } from "@/lib/brandMap/store";
import { computeCoverage } from "@/lib/content/blog/coverage";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BrandMapPage } from "@/lib/types/brandMapPage";
import type { BlogIntent } from "@/lib/types/contentPlan";

/**
 * The brand map's questions as the content plan names them, by id: their words, their subject and
 * how far along they are now (open, planned, drafted or answered), at either size of map. The plan
 * keeps ids only, so these are read when a slot is shown or picked.
 */

export interface QuestionNow {
  id: string;
  text: string;
  intent: BlogIntent;
  /** Its buying situations (a moved map's records keep them; a small map's list doesn't). */
  situationIds: string[];
  /** The live article Next up linked it to by meaning, and the pages a person unlinked. */
  answeredBy: { pageId: string } | null;
  notAnsweredBy: string[];
  subjectId: string;
  subjectName: string;
  state: "open" | "planned" | "drafted" | "answered";
  /** Its subject's questions, and how many are answered. */
  answered: number;
  total: number;
}

export interface QuestionDeps {
  db?: FirestoreLike;
  /** The brand's page rows on a small map (tests inject them). */
  pages?: (ctx: TenantContext) => Promise<BrandMapPage[]>;
}

/** The decided questions named, with their state now; a question no longer on the map is left out. */
export async function questionsNow(ctx: TenantContext, ids: string[], deps: QuestionDeps = {}): Promise<Map<string, QuestionNow>> {
  const out = new Map<string, QuestionNow>();
  const want = [...new Set(ids)];
  if (!want.length) return out;
  const read = await readBrandMap(ctx, deps.db).catch(() => null);
  if (!read || read.state !== "ok") return out;
  if (isBrandMapScaleEnabled() && read.map.moved) {
    const store = brandMapRecords(ctx, deps.db);
    const questions = (await store.getMany("q", want).catch(() => [])).flatMap((r) => {
      const q = parseQuestion(r);
      return q && q.status === "decided" && !q.mergedInto ? [q] : [];
    });
    const subjects = new Map(
      (await store.getMany("sub", [...new Set(questions.map((q) => q.subjectId))]).catch(() => [])).flatMap((r) => {
        const s = parseSubject(r);
        return s ? [[s.id, s] as const] : [];
      }),
    );
    for (const q of questions) {
      const s = subjects.get(q.subjectId);
      if (!s || s.status !== "decided") continue;
      const state = s.answeredIds.includes(q.id) ? "answered" : s.draftedIds.includes(q.id) ? "drafted" : s.plannedIds.includes(q.id) ? "planned" : "open";
      out.set(q.id, {
        id: q.id,
        text: q.text,
        intent: q.intent,
        situationIds: q.situationIds,
        answeredBy: q.answeredBy,
        notAnsweredBy: q.notAnsweredBy,
        subjectId: s.id,
        subjectName: s.name,
        state,
        answered: s.counts.answered,
        total: s.counts.questions,
      });
    }
    return out;
  }
  const rows = await (deps.pages ?? ((c) => listBrandMapPages(c, deps.db)))(ctx).catch(() => [] as BrandMapPage[]);
  const cov = computeCoverage(read.map, rows);
  for (const s of cov.subjects) {
    for (const q of s.questions) {
      if (!want.includes(q.id)) continue;
      out.set(q.id, { id: q.id, text: q.text, intent: q.intent, situationIds: [], answeredBy: null, notAnsweredBy: [], subjectId: s.id, subjectName: s.name, state: q.state, answered: s.answered, total: s.questions.length });
    }
  }
  return out;
}

/** Just the words of the questions named, at either size of map. */
export async function questionTexts(ctx: TenantContext, ids: string[], deps: QuestionDeps = {}): Promise<Map<string, string>> {
  const now = await questionsNow(ctx, ids, { ...deps, pages: deps.pages ?? (async () => []) });
  return new Map([...now.values()].map((q) => [q.id, q.text] as const));
}
