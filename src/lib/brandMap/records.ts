import { forTenant } from "@/lib/tenant";
import { brandMapRecords, type BrandMapRecordStore } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { brandMapDocId } from "@/lib/types/brandMap";
import type { BlogIntent } from "@/lib/types/contentPlan";
import {
  BRAND_MAP_RECORD_LIMITS as LIMITS,
  BrandMapGroupSchema,
  BrandMapQuestionRecordSchema,
  BrandMapSubjectRecordSchema,
  type BrandMapGroup,
  type BrandMapQuestionRecord,
  type BrandMapStoredRecord,
  type BrandMapSubjectRecord,
  type RecordStatus,
} from "@/lib/types/brandMapRecords";
import { sitesOf, siteOf } from "@/lib/knowledge/site";
import { createOnce } from "./createOnce";
import { freshId, groupIdFor, questionIdFor, questionKey, subjectIdFor, subjectKey, urlKey } from "./keys";
import { parseBrandMap } from "./store";

/**
 * The map's records as the app reads and a person edits them (BRAND_MAP_SCALE_ENABLED):
 * subjects, their questions, and groups. Each record is parsed on its own, so one that no
 * longer reads is left out, never the whole list. Every edit names the revision it started
 * from; an edit over someone else's is refused with the current record (409
 * `record_changed`), the way a save of the whole map is. Saving one subject never touches
 * another.
 *
 * Results say which subjects a change touched, so their counts and embeddings can follow,
 * which groups lost one (a move, a removal, a merge), so their totals follow too, and which
 * buying situations a question was or is linked to, so their counts follow.
 */

export type RecordResult<T> =
  | { ok: true; value: T; touched: string[]; groups?: Array<string | null>; situations?: string[] }
  | { ok: false; status: number; error: string; current?: unknown };

const iso = (nowMs?: number) => new Date(nowMs ?? Date.now()).toISOString();
const fail = (status: number, error: string, current?: unknown): RecordResult<never> => ({ ok: false, status, error, ...(current ? { current } : {}) });

export function parseSubject(raw: BrandMapStoredRecord | null): BrandMapSubjectRecord | null {
  if (!raw) return null;
  const r = BrandMapSubjectRecordSchema.safeParse(raw);
  return r.success ? r.data : null;
}
export function parseQuestion(raw: BrandMapStoredRecord | null): BrandMapQuestionRecord | null {
  if (!raw) return null;
  const r = BrandMapQuestionRecordSchema.safeParse(raw);
  return r.success ? r.data : null;
}
export function parseGroup(raw: BrandMapStoredRecord | null): BrandMapGroup | null {
  if (!raw) return null;
  const r = BrandMapGroupSchema.safeParse(raw);
  return r.success ? r.data : null;
}
const parseAll = <T>(rows: BrandMapStoredRecord[], parse: (r: BrandMapStoredRecord) => T | null): T[] => rows.flatMap((r) => {
  const p = parse(r);
  return p ? [p] : [];
});

type Deps = { db?: FirestoreLike; nowMs?: number };
const storeOf = (ctx: TenantContext, deps: Deps): BrandMapRecordStore => brandMapRecords(ctx, deps.db);

/** A subject, following a merge to the one it went into (a few steps at most). */
export async function getSubject(ctx: TenantContext, id: string, deps: Deps = {}): Promise<BrandMapSubjectRecord | null> {
  const store = storeOf(ctx, deps);
  let subject = parseSubject(await store.get("sub", id));
  for (let hop = 0; hop < 3 && subject?.mergedInto; hop += 1) subject = parseSubject(await store.get("sub", subject.mergedInto));
  return subject;
}

/** A subject's questions, in their order. */
export async function subjectQuestions(ctx: TenantContext, subjectId: string, deps: Deps = {}): Promise<BrandMapQuestionRecord[]> {
  const rows = await storeOf(ctx, deps).pageAll("q", { where: [["subjectId", "==", subjectId]] });
  return parseAll(rows, parseQuestion).sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** What a list of subjects shows of each: everything but the id lists. */
export const SUBJECT_SUMMARY_FIELDS = [
  "id", "tenantId", "status", "from", "reason", "evidence", "rev", "createdAt", "updatedAt", "decidedAt",
  "groupId", "name", "nameKey", "home", "urlKey", "suggestedHome", "looksLike", "suggestedGroupId", "counts", "answeredShare", "mergedInto", "order",
];

/** A subject as a list or the map shows it: what a row or a circle needs, no more (5,000 of them stay small). */
export type SubjectListItem = Pick<BrandMapSubjectRecord, "id" | "name" | "status" | "from" | "reason" | "groupId" | "suggestedGroupId" | "counts" | "answeredShare">;

export const listItemOf = (s: BrandMapSubjectRecord): SubjectListItem => ({
  id: s.id,
  name: s.name,
  status: s.status,
  from: s.from,
  reason: s.reason,
  groupId: s.groupId,
  suggestedGroupId: s.suggestedGroupId,
  counts: s.counts,
  answeredShare: s.answeredShare,
});

/** A brand's subjects: all of them, one group's (null = ungrouped), those suggested for a group, and of one status. */
export async function listSubjects(
  ctx: TenantContext,
  opts: { groupId?: string | null; suggestedGroupId?: string; status?: RecordStatus } = {},
  deps: Deps = {},
): Promise<BrandMapSubjectRecord[]> {
  const where: Array<[string, "==", unknown]> = [];
  if (opts.suggestedGroupId) where.push(["suggestedGroupId", "==", opts.suggestedGroupId]);
  else if (opts.groupId !== undefined) where.push(["groupId", "==", opts.groupId]);
  else if (opts.status) where.push(["status", "==", opts.status]);
  const rows = await storeOf(ctx, deps).pageAll("sub", { where, fields: SUBJECT_SUMMARY_FIELDS });
  // A dismissed one is kept (so it isn't proposed again) but never listed as if it were on the map.
  return parseAll(rows, parseSubject).filter((s) => !s.mergedInto && (opts.status ? s.status === opts.status : s.status !== "dismissed"));
}

/** A brand's groups: decided, and proposed ("Sort into groups"). A dismissed one is kept, so it isn't proposed again, but not listed. */
export async function listGroups(ctx: TenantContext, deps: Deps = {}): Promise<BrandMapGroup[]> {
  const rows = await storeOf(ctx, deps).pageAll("grp");
  return parseAll(rows, parseGroup)
    .filter((g) => g.status !== "dismissed")
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** A group a subject can be put in: one that is there and not dismissed. */
const usableGroup = async (store: BrandMapRecordStore, id: string) => {
  const group = parseGroup(await store.get("grp", id));
  return group && group.status !== "dismissed" ? group : null;
};

/** Every subject's name, for search: a few hundred KB at 5,000 subjects. */
export async function subjectIndex(ctx: TenantContext, deps: Deps = {}): Promise<Array<{ id: string; name: string; groupId: string | null; status: RecordStatus }>> {
  const rows = await storeOf(ctx, deps).pageAll("sub", { fields: ["name", "groupId", "status", "mergedInto"] });
  return rows.flatMap((r) =>
    typeof r.name === "string" && !r.mergedInto && r.status !== "dismissed"
      ? [{ id: r.id, name: r.name, groupId: typeof r.groupId === "string" ? r.groupId : null, status: (r.status === "proposed" ? "proposed" : "decided") as RecordStatus }]
      : [],
  );
}

/** The first time a person decides one of the map's records, the map counts as saved. */
export async function markRecordsDecided(ctx: TenantContext, deps: Deps = {}): Promise<void> {
  const now = iso(deps.nowMs);
  await forTenant(ctx, deps.db)
    .brandMaps.claim(brandMapDocId(ctx.tenantId), (current) => {
      const map = parseBrandMap(current);
      return map && !map.recordsDecidedAt ? ({ recordsDecidedAt: now, updatedAt: now } as never) : null;
    })
    .catch(() => null);
}

/** A home page must be on the brand's own site. */
function homeProblem(home: string | null | undefined, ownSites: string[] | undefined): string | null {
  if (!home) return null;
  if (!/^https:\/\//i.test(home)) return "home_not_https";
  const own = sitesOf(ownSites ?? []);
  return own.size && !own.has(siteOf(home)) ? "home_not_own_site" : null;
}

const base = (ctx: TenantContext, now: string) => ({ tenantId: ctx.tenantId, status: "decided" as const, from: "person" as const, rev: 0, createdAt: now, updatedAt: now, decidedAt: now });
const strip = <T extends { id: string; tenantId: string }>(r: T) => {
  const { id: _i, tenantId: _t, ...rest } = r;
  void _i;
  void _t;
  return rest;
};

export async function createSubject(
  ctx: TenantContext,
  input: { name: string; groupId?: string | null; home?: string | null; ownSites?: string[] },
  deps: Deps = {},
): Promise<RecordResult<BrandMapSubjectRecord>> {
  const now = iso(deps.nowMs);
  const store = storeOf(ctx, deps);
  const name = input.name.replace(/\s+/g, " ").trim();
  const key = subjectKey(name);
  if (!key) return fail(400, "invalid_name");
  const problem = homeProblem(input.home, input.ownSites);
  if (problem) return fail(400, problem);
  const [existing] = await store.find("sub", { where: [["nameKey", "==", key]], limit: 1 });
  if (existing && existing.status !== "dismissed") return fail(409, "subject_exists", parseSubject(existing));
  if ((await store.count("sub")) >= LIMITS.subjects) return fail(409, "too_many_subjects");
  if (input.groupId && !(await usableGroup(store, input.groupId))) return fail(404, "no_group");
  const parsed = BrandMapSubjectRecordSchema.safeParse({
    id: existing?.id ?? subjectIdFor(ctx.tenantId, name),
    ...base(ctx, now),
    name,
    nameKey: key,
    groupId: input.groupId ?? null,
    home: input.home ?? null,
    urlKey: urlKey(input.home),
  });
  if (!parsed.success) return fail(400, "invalid_subject");
  // A subject dismissed before comes back as decided when a person adds it by hand.
  let saved;
  if (existing) saved = await store.claim("sub", existing.id, (cur) => ({ ...strip(parsed.data), rev: Number(cur.rev ?? 0) + 1, createdAt: cur.createdAt }));
  else {
    const once = await createOnce(store, "sub", parsed.data.id, strip(parsed.data), { same: (there) => there.nameKey === key, fresh: () => freshId("sub") });
    // Added by someone else at the same moment.
    if (once.existing) return fail(409, "subject_exists", parseSubject(once.existing));
    saved = once.created;
  }
  await markRecordsDecided(ctx, deps);
  const value = parseSubject(saved);
  return value ? { ok: true, value, touched: [value.id] } : fail(500, "not_saved");
}

export async function editSubject(
  ctx: TenantContext,
  id: string,
  input: { baseRev: number; name?: string; home?: string | null; groupId?: string | null; ownSites?: string[] },
  deps: Deps = {},
): Promise<RecordResult<BrandMapSubjectRecord>> {
  const now = iso(deps.nowMs);
  const store = storeOf(ctx, deps);
  const name = input.name?.replace(/\s+/g, " ").trim();
  const key = name !== undefined ? subjectKey(name) : undefined;
  if (key === "") return fail(400, "invalid_name");
  const problem = homeProblem(input.home, input.ownSites);
  if (problem) return fail(400, problem);
  if (key) {
    const [other] = await store.find("sub", { where: [["nameKey", "==", key]], limit: 2 });
    if (other && other.id !== id && other.status !== "dismissed") return fail(409, "subject_exists", parseSubject(other));
  }
  if (input.groupId && !(await usableGroup(store, input.groupId))) return fail(404, "no_group");
  const seen: { conflict: BrandMapSubjectRecord | null; left: string | null | undefined } = { conflict: null, left: undefined };
  const saved = await store.claim("sub", id, (cur) => {
    const current = parseSubject(cur);
    if (!current) return null;
    if (current.rev !== input.baseRev) {
      seen.conflict = current;
      return null;
    }
    if (input.groupId !== undefined && input.groupId !== current.groupId) seen.left = current.groupId;
    return {
      ...(name !== undefined ? { name, nameKey: key } : {}),
      ...(input.home !== undefined ? { home: input.home, urlKey: urlKey(input.home), suggestedHome: input.home ? null : current.suggestedHome } : {}),
      // A person putting it in a group answers any group suggested for it.
      ...(input.groupId !== undefined ? { groupId: input.groupId, suggestedGroupId: null } : {}),
      rev: current.rev + 1,
      updatedAt: now,
    };
  });
  if (seen.conflict) return fail(409, "record_changed", seen.conflict);
  const value = parseSubject(saved);
  return value ? { ok: true, value, touched: [id], ...(seen.left !== undefined ? { groups: [seen.left] } : {}) } : fail(404, "no_subject");
}

/** Remove a subject and its questions. Articles written for it keep their link, and say it is no longer on the map. */
export async function removeSubject(ctx: TenantContext, id: string, deps: Deps = {}): Promise<RecordResult<{ id: string; questions: number }>> {
  const store = storeOf(ctx, deps);
  const subject = parseSubject(await store.get("sub", id));
  if (!subject) return fail(404, "no_subject");
  const questions = await store.pageAll("q", { where: [["subjectId", "==", id]], fields: ["subjectId"] });
  for (const q of questions) await store.remove("q", q.id).catch(() => undefined);
  await store.remove("sub", id);
  return { ok: true, value: { id, questions: questions.length }, touched: [id], groups: [subject.groupId] };
}

/**
 * Merge one subject into another: its questions move across (one the other already asks
 * goes), and it stays as a pointer (`mergedInto`), so articles and links to it still lead
 * somewhere.
 */
export async function mergeSubjects(ctx: TenantContext, input: { from: string; into: string }, deps: Deps = {}): Promise<RecordResult<{ moved: number; dropped: number }>> {
  if (input.from === input.into) return fail(400, "same_subject");
  const now = iso(deps.nowMs);
  const store = storeOf(ctx, deps);
  const [from, into] = await Promise.all([getSubject(ctx, input.from, deps), getSubject(ctx, input.into, deps)]);
  if (!from || !into || from.id === into.id) return fail(404, "no_subject");
  const [fromQs, intoQs] = await Promise.all([subjectQuestions(ctx, from.id, deps), subjectQuestions(ctx, into.id, deps)]);
  const asked = new Set(intoQs.map((q) => q.textKey));
  let moved = 0;
  let dropped = 0;
  let order = intoQs.reduce((m, q) => Math.max(m, q.order), -1) + 1;
  const askedBy = new Map(intoQs.map((q) => [q.textKey, q.id]));
  for (const q of fromQs) {
    if (asked.has(q.textKey)) {
      // The other asks it already: this one stays as a pointer to it, so an article's link
      // follows. Out of every lookup by its words (its key changes), so it never comes back.
      const target = askedBy.get(q.textKey);
      await store
        .claim("q", q.id, (cur) => ({ status: "dismissed", mergedInto: target ?? null, textKey: `merged:${q.id}`, rev: Number(cur.rev ?? 0) + 1, updatedAt: now }))
        .catch(() => null);
      dropped += 1;
      continue;
    }
    asked.add(q.textKey);
    await store.claim("q", q.id, (cur) => ({ subjectId: into.id, order: order++, rev: Number(cur.rev ?? 0) + 1, updatedAt: now }));
    moved += 1;
  }
  await store.claim("sub", from.id, (cur) => ({ mergedInto: into.id, status: "dismissed", rev: Number(cur.rev ?? 0) + 1, updatedAt: now }));
  // The merged-away subject now reads as the one it went into: its own group is said here.
  return { ok: true, value: { moved, dropped }, touched: [from.id, into.id], groups: [from.groupId] };
}

export async function addQuestion(
  ctx: TenantContext,
  subjectId: string,
  input: { text: string; intent?: BlogIntent; situationIds?: string[] },
  deps: Deps = {},
): Promise<RecordResult<BrandMapQuestionRecord>> {
  const now = iso(deps.nowMs);
  const store = storeOf(ctx, deps);
  const subject = await getSubject(ctx, subjectId, deps);
  if (!subject) return fail(404, "no_subject");
  const text = input.text.replace(/\s+/g, " ").trim();
  const key = questionKey(text);
  if (!key) return fail(400, "invalid_question");
  const [existing] = await store.find("q", { where: [["textKey", "==", key]], limit: 1 });
  if (existing && existing.status !== "dismissed") return fail(409, "question_exists", parseQuestion(existing));
  const count = await store.count("q", [["subjectId", "==", subject.id]]);
  if (count >= LIMITS.questionsPerSubject) return fail(409, "too_many_questions");
  const parsed = BrandMapQuestionRecordSchema.safeParse({
    id: existing?.id ?? questionIdFor(ctx.tenantId, text),
    ...base(ctx, now),
    subjectId: subject.id,
    text,
    textKey: key,
    intent: input.intent ?? "other",
    situationIds: input.situationIds ?? [],
    order: count,
  });
  if (!parsed.success) return fail(400, "invalid_question");
  let saved;
  if (existing) saved = await store.claim("q", existing.id, (cur) => ({ ...strip(parsed.data), rev: Number(cur.rev ?? 0) + 1, createdAt: cur.createdAt }));
  else {
    const once = await createOnce(store, "q", parsed.data.id, strip(parsed.data), { same: (there) => there.textKey === key, fresh: () => freshId("q") });
    if (once.existing) return fail(409, "question_exists", parseQuestion(once.existing));
    saved = once.created;
  }
  await markRecordsDecided(ctx, deps);
  const value = parseQuestion(saved);
  return value ? { ok: true, value, touched: [subject.id], ...(value.situationIds.length ? { situations: value.situationIds } : {}) } : fail(500, "not_saved");
}

export async function editQuestion(
  ctx: TenantContext,
  id: string,
  input: { baseRev: number; text?: string; intent?: BlogIntent; situationIds?: string[]; subjectId?: string },
  deps: Deps = {},
): Promise<RecordResult<BrandMapQuestionRecord>> {
  const now = iso(deps.nowMs);
  const store = storeOf(ctx, deps);
  const text = input.text?.replace(/\s+/g, " ").trim();
  const key = text !== undefined ? questionKey(text) : undefined;
  if (key === "") return fail(400, "invalid_question");
  if (key) {
    const [other] = await store.find("q", { where: [["textKey", "==", key]], limit: 2 });
    if (other && other.id !== id && other.status !== "dismissed") return fail(409, "question_exists", parseQuestion(other));
  }
  let target: BrandMapSubjectRecord | null = null;
  if (input.subjectId) {
    target = await getSubject(ctx, input.subjectId, deps);
    if (!target) return fail(404, "no_subject");
  }
  const seen: { conflict: BrandMapQuestionRecord | null; from: string | null; situations: string[] } = { conflict: null, from: null, situations: [] };
  const saved = await store.claim("q", id, (cur) => {
    const current = parseQuestion(cur);
    if (!current) return null;
    if (current.rev !== input.baseRev) {
      seen.conflict = current;
      return null;
    }
    seen.from = current.subjectId;
    seen.situations = current.situationIds;
    return {
      ...(text !== undefined ? { text, textKey: key } : {}),
      ...(input.intent ? { intent: input.intent } : {}),
      ...(input.situationIds ? { situationIds: [...new Set(input.situationIds)].slice(0, LIMITS.situationsPerQuestion) } : {}),
      ...(target ? { subjectId: target.id } : {}),
      rev: current.rev + 1,
      updatedAt: now,
    };
  });
  if (seen.conflict) return fail(409, "record_changed", seen.conflict);
  const value = parseQuestion(saved);
  if (!value) return fail(404, "no_question");
  const situations = [...new Set([...seen.situations, ...value.situationIds])];
  return { ok: true, value, touched: [...new Set([seen.from, value.subjectId].filter((x): x is string => Boolean(x)))], ...(situations.length ? { situations } : {}) };
}

export async function removeQuestion(ctx: TenantContext, id: string, deps: Deps = {}): Promise<RecordResult<{ id: string }>> {
  const store = storeOf(ctx, deps);
  const question = parseQuestion(await store.get("q", id));
  if (!question) return fail(404, "no_question");
  await store.remove("q", id);
  return { ok: true, value: { id }, touched: [question.subjectId], ...(question.situationIds.length ? { situations: question.situationIds } : {}) };
}

export async function createGroup(ctx: TenantContext, input: { name: string }, deps: Deps = {}): Promise<RecordResult<BrandMapGroup>> {
  const now = iso(deps.nowMs);
  const store = storeOf(ctx, deps);
  const name = input.name.replace(/\s+/g, " ").trim();
  const key = subjectKey(name);
  if (!key) return fail(400, "invalid_name");
  const [existing] = await store.find("grp", { where: [["nameKey", "==", key]], limit: 1 });
  if (existing?.status === "decided") return fail(409, "group_exists", parseGroup(existing));
  if (existing) {
    // Proposed, or dismissed before: a person adding it by name decides it.
    const revived = parseGroup(await store.claim("grp", existing.id, (cur) => ({ status: "decided", name, decidedAt: now, rev: Number(cur.rev ?? 0) + 1, updatedAt: now })));
    return revived ? { ok: true, value: revived, touched: [] } : fail(500, "not_saved");
  }
  const groups = await store.count("grp");
  if (groups >= LIMITS.groups) return fail(409, "too_many_groups");
  const parsed = BrandMapGroupSchema.safeParse({ id: groupIdFor(ctx.tenantId, name), ...base(ctx, now), name, nameKey: key, order: groups });
  if (!parsed.success) return fail(400, "invalid_group");
  const once = await createOnce(store, "grp", parsed.data.id, strip(parsed.data), { same: (there) => there.nameKey === key, fresh: () => freshId("grp") });
  if (once.existing) return fail(409, "group_exists", parseGroup(once.existing));
  const value = parseGroup(once.created);
  return value ? { ok: true, value, touched: [] } : fail(500, "not_saved");
}

export async function renameGroup(ctx: TenantContext, id: string, input: { baseRev: number; name: string }, deps: Deps = {}): Promise<RecordResult<BrandMapGroup>> {
  const now = iso(deps.nowMs);
  const store = storeOf(ctx, deps);
  const name = input.name.replace(/\s+/g, " ").trim();
  const key = subjectKey(name);
  if (!key) return fail(400, "invalid_name");
  const [other] = await store.find("grp", { where: [["nameKey", "==", key]], limit: 2 });
  if (other && other.id !== id) return fail(409, "group_exists", parseGroup(other));
  const seen: { conflict: BrandMapGroup | null } = { conflict: null };
  const saved = await store.claim("grp", id, (cur) => {
    const current = parseGroup(cur);
    if (!current) return null;
    if (current.rev !== input.baseRev) {
      seen.conflict = current;
      return null;
    }
    return { name, nameKey: key, rev: current.rev + 1, updatedAt: now };
  });
  if (seen.conflict) return fail(409, "record_changed", seen.conflict);
  const value = parseGroup(saved);
  return value ? { ok: true, value, touched: [] } : fail(404, "no_group");
}

/** Remove a group: its subjects stay, ungrouped (ten moved at a time). */
export async function removeGroup(ctx: TenantContext, id: string, deps: Deps = {}): Promise<RecordResult<{ id: string; subjects: number }>> {
  const now = iso(deps.nowMs);
  const store = storeOf(ctx, deps);
  if (!(await store.get("grp", id))) return fail(404, "no_group");
  const subjects = await store.pageAll("sub", { where: [["groupId", "==", id]], fields: ["groupId"] });
  for (let i = 0; i < subjects.length; i += 10) {
    await Promise.all(
      subjects
        .slice(i, i + 10)
        // One a person has moved since stays where they put it.
        .map((s) => store.claim("sub", s.id, (cur) => (cur.groupId === id ? { groupId: null, rev: Number(cur.rev ?? 0) + 1, updatedAt: now } : null))),
    );
  }
  await store.remove("grp", id);
  // A move changes no subject's counts or meaning: only the ungrouped totals follow.
  return { ok: true, value: { id, subjects: subjects.length }, touched: [], groups: [null] };
}
