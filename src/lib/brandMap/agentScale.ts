import type { TenantContext } from "@/lib/tenant";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { BrandMap } from "@/lib/types/brandMap";
import { isMapSaved } from "@/lib/types/brandMap";
import { SITUATION_W_LABEL } from "@/lib/types/brandMapRecords";
import { describeChange } from "./changes";
import { nearestSubjects, type EmbedDeps } from "./embed";
import { isBrandMapImportEnabled, isBrandMapSituationsEnabled } from "./flags";
import { importReport } from "./importCompare";
import { getImport, listImports } from "./imports";
import { listGroups, parseSubject } from "./records";
import { subjectCoverage } from "./recount";
import { listSituations } from "./situations";
import { proposalsWaiting } from "./waiting";

/**
 * What Vizzy reads of a map at any size (BRAND_MAP_SCALE_ENABLED, once its subjects moved):
 * never the whole list. A summary (what the brand is, its names, its buying situations and
 * groups with their counts, what waits); the subjects nearest some words in meaning; one
 * subject with its questions and what answers them; and what an import of the brand's own
 * research added. Brand content only.
 */

export type ApiResult = { status: number; body: unknown };

const FIND = 10;
const SITUATIONS = 50;

export const SCALE_NOTE =
  "This brand map is large, so it is read a part at a time: ask for the subjects near some words (find), or one subject by id (subject), " +
  "never the whole list. Vizzy can only propose (subjects, questions, buying situations): nothing on the map changes until an admin adds it " +
  "on Brand › Brand map.";

const STATE: Record<string, string> = { answered: "answered", drafted: "being written", planned: "planned", open: "open" };

/** The summary: identity, names, situations and groups with counts, what waits. */
export async function agentMapSummary(ctx: TenantContext, map: BrandMap, db?: FirestoreLike): Promise<ApiResult> {
  const situationsOn = isBrandMapSituationsEnabled();
  const [groups, situations, waiting, imports] = await Promise.all([
    listGroups(ctx, { db }).catch(() => []),
    situationsOn ? listSituations(ctx, { db }).catch(() => []) : Promise.resolve([]),
    proposalsWaiting(ctx, { db }),
    isBrandMapImportEnabled() ? listImports(ctx, { db }).catch(() => []) : Promise.resolve([]),
  ]);
  const i = map.identity;
  const decided = situations.filter((s) => s.status === "decided");
  return {
    status: 200,
    body: {
      map: {
        rev: map.rev,
        saved: isMapSaved(map),
        atAnySize: true,
        identity: { name: i.name, category: i.category, statement: i.statement, isNot: i.isNot, avoid: i.avoid.map((a) => ({ term: a.term, useInstead: a.useInstead })), site: i.site },
        names: map.names.map((n) => ({ id: n.id, name: n.name, kind: n.kind, aliases: n.aliases })),
        groups: groups
          .filter((g) => g.status === "decided")
          .map((g) => ({ id: g.id, name: g.name, subjects: g.totals.subjects, questions: g.totals.questions, answered: g.totals.answered })),
        ungrouped: map.ungroupedTotals ? { subjects: map.ungroupedTotals.subjects, questions: map.ungroupedTotals.questions, answered: map.ungroupedTotals.answered } : null,
        ...(situationsOn
          ? {
              situations: decided.slice(0, SITUATIONS).map((s) => ({
                id: s.id,
                text: s.text,
                who: s.who,
                ...(s.wText ? { [SITUATION_W_LABEL[s.w].toLowerCase()]: s.wText } : {}),
                focus: s.focus,
                questions: s.counts.questions,
                answered: s.counts.answered,
              })),
              situationsInAll: decided.length,
            }
          : {}),
      },
      waiting: {
        proposals: waiting,
        suggestions: map.suggestions.length,
        latest: [...map.suggestions]
          .sort((a, b) => b.at.localeCompare(a.at))
          .slice(0, 5)
          .map((s) => ({ change: describeChange(s.change), from: s.from })),
      },
      ...(imports.length ? { imports: imports.slice(0, 5).map((m) => ({ id: m.id, fileName: m.fileName, at: m.at })) } : {}),
      note: SCALE_NOTE,
    },
  };
}

/** The subjects nearest some words in meaning (or shared words), with their counts. */
export async function agentFindSubjects(ctx: TenantContext, text: string, db?: FirestoreLike, embed: Omit<EmbedDeps, "db"> = {}): Promise<ApiResult> {
  const words = text.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!words) return { status: 400, body: { error: "invalid_input", note: "Say what to look for." } };
  const near = await nearestSubjects(ctx, words, { limit: FIND, statuses: ["decided", "proposed"] }, { db, ...embed }).catch(() => []);
  const rows = await brandMapRecords(ctx, db).getMany("sub", near.map((n) => n.ref)).catch(() => []);
  const byId = new Map(rows.flatMap((r) => (parseSubject(r) ? [[r.id, parseSubject(r)!] as const] : [])));
  return {
    status: 200,
    body: {
      subjects: near.flatMap((n) => {
        const s = byId.get(n.ref);
        return s && !s.mergedInto ? [{ id: s.id, name: s.name, status: s.status, questions: s.counts.questions, answered: s.counts.answered }] : [];
      }),
      note: SCALE_NOTE,
    },
  };
}

/** One subject: its questions, how far along each is, and the page that answers it. */
export async function agentOneSubject(ctx: TenantContext, id: string, db?: FirestoreLike): Promise<ApiResult> {
  const read = await subjectCoverage(ctx, id, { db }).catch(() => null);
  if (!read) return { status: 404, body: { error: "no_subject" } };
  const cov = new Map(read.coverage.questions.map((q) => [q.id, q] as const));
  return {
    status: 200,
    body: {
      subject: {
        id: read.subject.id,
        name: read.subject.name,
        status: read.subject.status,
        groupId: read.subject.groupId,
        home: read.subject.home,
        questions: read.questions
          .filter((q) => q.status !== "dismissed")
          .map((q) => {
            const c = cov.get(q.id);
            return {
              id: q.id,
              text: q.text,
              intent: q.intent,
              status: q.status,
              ...(q.situationIds.length ? { situationIds: q.situationIds } : {}),
              ...(c ? { state: STATE[c.state], ...(c.pages[0] ? { answeredBy: { title: c.pages[0].title, url: c.pages[0].url } } : {}) } : {}),
            };
          }),
      },
      note: SCALE_NOTE,
    },
  };
}

/** What an import of the brand's own research added: the latest, or one by id. */
export async function agentImportResults(ctx: TenantContext, id: string, db?: FirestoreLike): Promise<ApiResult> {
  if (!isBrandMapImportEnabled()) return { status: 503, body: { error: "import_disabled" } };
  const imp = id === "latest" ? ((await listImports(ctx, { db }).catch(() => []))[0] ?? null) : await getImport(ctx, id, { db });
  if (!imp) return { status: 404, body: { error: "no_import", note: "No research has been uploaded yet. It's uploaded as a PDF on Brand › Brand map › Your research." } };
  const report = await importReport(ctx, imp, { db });
  const fresh = report.items.filter((i) => i.outcome === "new" && i.addable);
  return {
    status: 200,
    body: {
      import: { id: imp.id, fileName: imp.fileName, at: imp.at, pages: imp.pages, searches: imp.searches },
      counts: report.counts,
      newQuestions: fresh.slice(0, 20).map((i) => ({ question: i.question, page: i.page, goes: i.newSubject ? `a new subject: ${i.newSubject}` : `the subject ${i.subjectName}` })),
      onTheMapNotWritten: report.items
        .filter((i) => i.outcome === "on_map" && i.match?.state === "open")
        .slice(0, 10)
        .map((i) => ({ question: i.match!.text, subject: i.match!.subjectName, questionId: i.match!.id })),
      newGroups: report.themes.filter((t) => t.becomesGroup).map((t) => t.name),
      peopleAddToTheSearch: report.adds,
      cited: imp.cited,
      note: "Nothing from it is on the map until an admin ticks it and adds it on Brand › Brand map › Your research.",
    },
  };
}
