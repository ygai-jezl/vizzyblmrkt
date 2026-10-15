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
import { freshId, groupIdFor, questionKey, subjectKey, urlKey } from "./keys";
import { parseBrandMap } from "./store";

/**
 * The map's records as the app reads and a person edits them (BRAND_MAP_SCALE_ENABLED):
 * subjects, their questions, and groups. Each record is parsed on its own, so one that no
 * longer reads is left out, never the whole list. Every edit names the revision it started
 * from; an edit over someone else's is refused with the current record (409
 * `record_changed`), the way a save of the whole map is. Saving one subject never touches
 * another.
 *
 * Results say which subjects a change touched, so their counts and embeddings can follow, and
 * which groups lost one (a move, a removal, a merge), so their totals follow too.
 */

export type RecordResult<T> =
  | { ok: true; value: T; touched: string[]; groups?: Array<string | null> }
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
  "groupId", "name", "nameKey", "home", "urlKey", "suggestedHome", "looksLike", "counts", "answeredShare", "mergedInto", "order",
];

/** A brand's subjects: all of them, or one group's (null = ungrouped), and of one status. */
export async function listSubjects(
  ctx: TenantContext,
  opts: { groupId?: string | null; status?: RecordStatus } = {},
  deps: Deps = {},
): Promise<BrandMapSubjectRecord[]> {
  const where: Array<[string, "==", unknown]> = [];
  if (opts.groupId !== undefined) where.push(["groupId", "==", opts.groupId]);
  else if (opts.status) where.push(["status", "==", opts.status]);
  const rows = await storeOf(ctx, deps).pageAll("sub", { where, fields: SUBJECT_SUMMARY_FIELDS });
  return parseAll(rows, parseSubject).filter((s) => !s.mergedInto && (!opts.status || s.status === opts.status));
}

export async function listGroups(ctx: TenantContext, deps: Deps = {}): Promise<BrandMapGroup[]> {
  const rows = await storeOf(ctx, deps).pageAll("grp");
  return parseAll(rows, parseGroup).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

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
  if (input.groupId && !parseGroup(await store.get("grp", input.groupId))) return fail(404, "no_group");
  const parsed = BrandMapSubjectRecordSchema.safeParse({
    id: existing?.id ?? freshId("sub"),
    ...base(ctx, now),
    name,
    nameKey: key,
    groupId: input.groupId ?? null,
    home: input.home ?? null,
    urlKey: urlKey(input.home),
  });
  if (!parsed.success) return fail(400, "invalid_subject");
  // A subject dismissed before comes back as decided when a person adds it by hand.
  const saved = existing
    ? await store.claim("sub", existing.id, (cur) => ({ ...strip(parsed.data), rev: Number(cur.rev ?? 0) + 1, createdAt: cur.createdAt }))
    : await store.create("sub", parsed.data.id, strip(parsed.data));
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
  if (input.groupId && !parseGroup(await store.get("grp", input.groupId))) return fail(404, "no_group");
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
      ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
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
  for (const q of fromQs) {
    if (asked.has(q.textKey)) {
      await store.remove("q", q.id).catch(() => undefined);
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
    id: existing?.id ?? freshId("q"),
    ...base(ctx, now),
    subjectId: subject.id,
    text,
    textKey: key,
    intent: input.intent ?? "other",
    situationIds: input.situationIds ?? [],
    order: count,
  });
  if (!parsed.success) return fail(400, "invalid_question");
  const saved = existing
    ? await store.claim("q", existing.id, (cur) => ({ ...strip(parsed.data), rev: Number(cur.rev ?? 0) + 1, createdAt: cur.createdAt }))
    : await store.create("q", parsed.data.id, strip(parsed.data));
  await markRecordsDecided(ctx, deps);
  const value = parseQuestion(saved);
  return value ? { ok: true, value, touched: [subject.id] } : fail(500, "not_saved");
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
  const seen: { conflict: BrandMapQuestionRecord | null; from: string | null } = { conflict: null, from: null };
  const saved = await store.claim("q", id, (cur) => {
    const current = parseQuestion(cur);
    if (!current) return null;
    if (current.rev !== input.baseRev) {
      seen.conflict = current;
      return null;
    }
    seen.from = current.subjectId;
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
  return { ok: true, value, touched: [...new Set([seen.from, value.subjectId].filter((x): x is string => Boolean(x)))] };
}

export async function removeQuestion(ctx: TenantContext, id: string, deps: Deps = {}): Promise<RecordResult<{ id: string }>> {
  const store = storeOf(ctx, deps);
  const question = parseQuestion(await store.get("q", id));
  if (!question) return fail(404, "no_question");
  await store.remove("q", id);
  return { ok: true, value: { id }, touched: [question.subjectId] };
}

export async function createGroup(ctx: TenantContext, input: { name: string }, deps: Deps = {}): Promise<RecordResult<BrandMapGroup>> {
  const now = iso(deps.nowMs);
  const store = storeOf(ctx, deps);
  const name = input.name.replace(/\s+/g, " ").trim();
  const key = subjectKey(name);
  if (!key) return fail(400, "invalid_name");
  const [existing] = await store.find("grp", { where: [["nameKey", "==", key]], limit: 1 });
  if (existing) return fail(409, "group_exists", parseGroup(existing));
  const groups = await store.count("grp");
  if (groups >= LIMITS.groups) return fail(409, "too_many_groups");
  const parsed = BrandMapGroupSchema.safeParse({ id: groupIdFor(ctx.tenantId, name), ...base(ctx, now), name, nameKey: key, order: groups });
  if (!parsed.success) return fail(400, "invalid_group");
  const saved = (await store.createIfAbsent("grp", parsed.data.id, strip(parsed.data))) ?? (await store.create("grp", freshId("grp"), strip(parsed.data)));
  const value = parseGroup(saved);
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

/** Remove a group: its subjects stay, ungrouped. */
export async function removeGroup(ctx: TenantContext, id: string, deps: Deps = {}): Promise<RecordResult<{ id: string; subjects: number }>> {
  const now = iso(deps.nowMs);
  const store = storeOf(ctx, deps);
  if (!(await store.get("grp", id))) return fail(404, "no_group");
  const subjects = await store.pageAll("sub", { where: [["groupId", "==", id]], fields: ["groupId"] });
  for (const s of subjects) await store.claim("sub", s.id, (cur) => ({ groupId: null, rev: Number(cur.rev ?? 0) + 1, updatedAt: now }));
  await store.remove("grp", id);
  return { ok: true, value: { id, subjects: subjects.length }, touched: subjects.map((s) => s.id) };
}
