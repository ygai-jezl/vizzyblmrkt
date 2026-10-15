import { forTenant } from "@/lib/tenant";
import { brandMapRecords, MAX_IN } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { matchQuestion, type QuestionState } from "@/lib/content/blog/coverage";
import { BrandMapPageSchema } from "@/lib/types/brandMapPage";
import type { BrandMapImport, BrandMapSubjectRecord, ImportItem } from "@/lib/types/brandMapRecords";
import { afterRecordsChange } from "./afterChange";
import type { EmbedDeps } from "./embed";
import { getImport, type ImportResult } from "./imports";
import { questionKey, subjectKey } from "./keys";
import { addQuestion, createGroup, createSubject, listGroups, parseQuestion, parseSubject, subjectQuestions } from "./records";
import { decideProposals } from "./proposals";
import { recountSituations } from "./situations";

/**
 * What a brand's own research adds to its map (BRAND_MAP_IMPORT_ENABLED), worked out each time
 * its report is opened, so "not written yet" becomes "answered" as articles go live. Each
 * question (a search, once placing has turned it into one) is matched against the whole map
 * by its words: answered by an article, on the map but not written yet, waiting as a proposal,
 * close in wording to a question in the subject it was placed in (today's word-overlap rule;
 * the person chooses), or new. New ones arrive ticked; "Add ticked" adds them as decided,
 * marked "from your research: <file>, page N", with what people add to their search as leads
 * for an article. A heading of the research's AI answer with two or more new subjects under it
 * becomes a group (the new top-level pillar); one matched to a group puts them there.
 */

export type ItemOutcome = "answered" | "on_map" | "waiting" | "close" | "new" | "no_fit" | "search" | "note";

export interface ReportItem {
  id: string;
  kind: ImportItem["kind"];
  text: string;
  page: number | null;
  search: string;
  /** The question it is, or the one a search implies (once placed). */
  question: string;
  outcome: ItemOutcome;
  /** On the map (or close to it): that question, its subject, and how far along. */
  match?: { id: string; text: string; subjectId: string; subjectName: string; state: QuestionState };
  answeredBy?: { title: string; url: string | null };
  /** Where it would go: a subject on the map, or a new one; its heading and situation. */
  subjectId?: string | null;
  subjectName?: string;
  newSubject?: string;
  theme?: string;
  situationId?: string | null;
  why?: string;
  adds?: string;
  /** It can be ticked and added. */
  addable: boolean;
}

export interface ImportReport {
  counts: {
    found: number;
    newQuestions: number;
    newSubjects: number;
    newGroups: number;
    onMap: number;
    answered: number;
    waiting: number;
    close: number;
    noFit: number;
    searches: number;
  };
  items: ReportItem[];
  /** What people add to the searches ("examples", "free"), each once, in the order found. */
  adds: string[];
  themes: Array<{ name: string; page: number | null; groupId: string | null; groupName: string; newSubjects: string[]; becomesGroup: boolean }>;
}

type Deps = { db?: FirestoreLike; nowMs?: number; embed?: Omit<EmbedDeps, "db" | "nowMs"> };

const questionOf = (i: ImportItem) => (i.kind === "also" ? i.asQuestion : i.text);
const stateIn = (s: BrandMapSubjectRecord | undefined, qid: string): QuestionState =>
  !s ? "open" : s.answeredIds.includes(qid) ? "answered" : s.draftedIds.includes(qid) ? "drafted" : s.plannedIds.includes(qid) ? "planned" : "open";

/** The live page that answers each of these questions, from the rows that carry its id. */
async function answeredBy(ctx: TenantContext, ids: string[], deps: Deps): Promise<Map<string, { title: string; url: string | null }>> {
  const out = new Map<string, { title: string; url: string | null }>();
  const pages = forTenant(ctx, deps.db).brandMapPages;
  for (let i = 0; i < ids.length; i += MAX_IN) {
    const chunk = ids.slice(i, i + MAX_IN);
    const rows = await pages.find({ where: [["refs", "array-contains-any", chunk]], limit: 200 }).catch(() => []);
    for (const raw of rows) {
      const row = BrandMapPageSchema.safeParse(raw);
      if (!row.success || row.data.state !== "live") continue;
      for (const id of row.data.refs ?? []) if (chunk.includes(id) && !out.has(id)) out.set(id, { title: row.data.title || row.data.url || "An article", url: row.data.url });
    }
  }
  return out;
}

export async function importReport(ctx: TenantContext, imp: BrandMapImport, deps: Deps = {}): Promise<ImportReport> {
  const store = brandMapRecords(ctx, deps.db);
  const asks = imp.items.filter((i) => i.kind !== "note");
  const keys = [...new Set(asks.map((i) => questionKey(questionOf(i))).filter(Boolean))];
  const found = (await store.findIn("q", "textKey", keys).catch(() => [])).flatMap((r) => {
    const q = parseQuestion(r);
    return q && q.status !== "dismissed" ? [q] : [];
  });
  const byKey = new Map(found.map((q) => [q.textKey, q]));
  const subjectIds = [...new Set([...found.map((q) => q.subjectId), ...asks.flatMap((i) => (i.subjectId ? [i.subjectId] : []))])];
  const subjects = new Map(
    (await store.getMany("sub", subjectIds).catch(() => [])).flatMap((r) => {
      const s = parseSubject(r);
      return s ? [[s.id, s] as const] : [];
    }),
  );
  const answered = await answeredBy(
    ctx,
    found.filter((q) => q.status === "decided" && stateIn(subjects.get(q.subjectId), q.id) === "answered").map((q) => q.id),
    deps,
  );
  // Close wording is looked for in the subject each new question was placed in.
  const placedIn = [...new Set(asks.flatMap((i) => (i.subjectId && !byKey.has(questionKey(questionOf(i))) ? [i.subjectId] : [])))].slice(0, 60);
  const questionsIn = new Map(await Promise.all(placedIn.map(async (id) => [id, await subjectQuestions(ctx, id, deps).catch(() => [])] as const)));
  const groups = new Map((await listGroups(ctx, deps).catch(() => [])).map((g) => [g.id, g]));

  const items = imp.items.map((i): ReportItem => {
    const question = questionOf(i) || "";
    const base = { id: i.id, kind: i.kind, text: i.text, page: i.page, search: i.search, question, ...(i.adds ? { adds: i.adds } : {}), addable: false };
    if (i.kind === "note") return { ...base, outcome: "note" };
    const q = question ? byKey.get(questionKey(question)) : undefined;
    if (q) {
      const s = subjects.get(q.subjectId);
      const state = stateIn(s, q.id);
      const by = answered.get(q.id);
      return {
        ...base,
        outcome: q.status === "proposed" ? "waiting" : state === "answered" ? "answered" : "on_map",
        match: { id: q.id, text: q.text, subjectId: q.subjectId, subjectName: s?.name ?? "", state },
        ...(by ? { answeredBy: by } : {}),
      };
    }
    if (!i.fits) return { ...base, outcome: "no_fit", why: i.why };
    // A search not (yet) turned into a question: shown with what it adds.
    if (!question) return { ...base, outcome: "search" };
    const s = i.subjectId ? subjects.get(i.subjectId) : undefined;
    const where = { subjectId: s ? s.id : null, subjectName: s?.name ?? "", newSubject: i.newSubject, theme: i.theme, situationId: i.situationId };
    const addable = Boolean(s && s.status !== "dismissed") || Boolean(i.newSubject);
    const near = s
      ? questionsIn.get(s.id)?.find((x) => x.status !== "dismissed" && matchQuestion({ id: "", text: question }, { primaryRef: null, primaryQuestion: x.text, questions: [], title: "" }) === "probably")
      : undefined;
    if (near) return { ...base, ...where, outcome: "close", match: { id: near.id, text: near.text, subjectId: s!.id, subjectName: s!.name, state: stateIn(s, near.id) }, addable };
    return { ...base, ...where, outcome: "new", addable };
  });

  const fresh = items.filter((i) => i.outcome === "new" && i.addable);
  const themes = imp.themes.map((t) => {
    const under = [...new Map(fresh.filter((i) => i.newSubject && i.theme === t.name).map((i) => [subjectKey(i.newSubject!), i.newSubject!])).values()];
    const group = t.groupId ? groups.get(t.groupId) : undefined;
    return { name: t.name, page: t.page, groupId: group ? group.id : null, groupName: group?.name ?? "", newSubjects: under, becomesGroup: !group && under.length >= 2 };
  });
  const count = (o: ItemOutcome) => items.filter((i) => i.outcome === o).length;
  return {
    counts: {
      found: items.filter((i) => i.kind !== "note").length,
      newQuestions: fresh.length,
      newSubjects: new Set(fresh.flatMap((i) => (i.newSubject ? [subjectKey(i.newSubject)] : []))).size,
      newGroups: themes.filter((t) => t.becomesGroup).length,
      onMap: count("on_map"),
      answered: count("answered"),
      waiting: count("waiting"),
      close: count("close"),
      noFit: count("no_fit"),
      searches: items.filter((i) => i.kind === "also").length,
    },
    items,
    adds: [...new Set(imp.items.flatMap((i) => (i.adds ? [i.adds] : [])))],
    themes,
  };
}

/**
 * Add the ticked items: each becomes a decided question on its subject (a new subject is made
 * first, in its heading's group when it has one), marked as coming from this research, with
 * what people add to its search as leads. The import remembers what was added from it.
 */
export async function addImported(
  ctx: TenantContext,
  importId: string,
  itemIds: string[],
  deps: Deps = {},
): Promise<ImportResult<{ added: number; newSubjects: number; newGroups: number }>> {
  const imp = await getImport(ctx, importId, deps);
  if (!imp) return { ok: false, status: 404, error: "no_import" };
  const store = brandMapRecords(ctx, deps.db);
  const report = await importReport(ctx, imp, deps);
  const ticked = new Set(itemIds);
  const chosen = report.items.filter((i) => ticked.has(i.id) && i.addable && (i.outcome === "new" || i.outcome === "close"));

  // A heading becomes a group when two or more new subjects chosen sit under it.
  const underTheme = new Map<string, Set<string>>();
  for (const i of chosen) if (i.newSubject && i.theme) underTheme.set(i.theme, (underTheme.get(i.theme) ?? new Set()).add(subjectKey(i.newSubject)));
  const themeGroup = new Map<string, string>();
  let newGroups = 0;
  for (const t of report.themes) {
    if (t.groupId) themeGroup.set(t.name, t.groupId);
    else if ((underTheme.get(t.name)?.size ?? 0) >= 2) {
      const g = await createGroup(ctx, { name: t.name }, deps);
      const id = g.ok ? g.value.id : g.error === "group_exists" ? (g.current as { id?: string } | undefined)?.id : undefined;
      if (id) themeGroup.set(t.name, id);
      if (g.ok) newGroups += 1;
    }
  }

  // What people add to each search, as leads for an article on a question found under it.
  const leadsFor = new Map<string, string[]>();
  for (const i of imp.items) if (i.kind === "also" && i.adds && i.search) leadsFor.set(i.search, [...new Set([...(leadsFor.get(i.search) ?? []), i.adds])].slice(0, 8));

  const made = new Map<string, string>();
  const done = new Map<string, { questionId: string; subjectId: string }>();
  const touched = new Set<string>();
  const situations = new Set<string>();
  for (const i of chosen) {
    let subjectId = i.subjectId ?? null;
    if (!subjectId && i.newSubject) {
      const key = subjectKey(i.newSubject);
      subjectId = made.get(key) ?? null;
      if (!subjectId) {
        const s = await createSubject(ctx, { name: i.newSubject, groupId: i.theme ? (themeGroup.get(i.theme) ?? null) : null }, deps);
        subjectId = s.ok ? s.value.id : s.error === "subject_exists" ? ((s.current as { id?: string } | undefined)?.id ?? null) : null;
        if (subjectId) made.set(key, subjectId);
      }
    }
    if (!subjectId) continue;
    // A subject still proposed is decided with it: a decided question never sits in a proposed subject.
    if (i.subjectId && parseSubject(await store.get("sub", subjectId).catch(() => null))?.status === "proposed") {
      await decideProposals(ctx, { accept: { subjects: [subjectId] } }, { db: deps.db, nowMs: deps.nowMs });
    }
    const q = await addQuestion(ctx, subjectId, { text: i.question, situationIds: i.situationId ? [i.situationId] : [] }, deps);
    const qid = q.ok ? q.value.id : q.error === "question_exists" ? (q.current as { id?: string } | undefined)?.id : undefined;
    if (!qid) continue;
    const leads = leadsFor.get(i.search) ?? [];
    const evidence = `From your research: ${imp.fileName}${i.page ? `, page ${i.page}` : ""}`.slice(0, 200);
    await store.claim("q", qid, () => ({ from: "import", evidence, ...(leads.length ? { leads } : {}) })).catch(() => null);
    done.set(i.id, { questionId: qid, subjectId });
    touched.add(subjectId);
    if (i.situationId) situations.add(i.situationId);
  }
  if (done.size) {
    await store.claim("imp", imp.id, (cur) => ({
      items: (Array.isArray(cur.items) ? (cur.items as Array<Record<string, unknown>>) : []).map((raw) => {
        const d = done.get(String(raw.id));
        return d ? { ...raw, questionId: d.questionId, subjectId: d.subjectId, newSubject: "" } : raw;
      }),
    }));
    await afterRecordsChange(ctx, { subjects: [...touched] }, { db: deps.db, nowMs: deps.nowMs, ...deps.embed });
    if (situations.size) await recountSituations(ctx, situations, { db: deps.db });
  }
  return { ok: true, value: { added: done.size, newSubjects: made.size, newGroups } };
}
